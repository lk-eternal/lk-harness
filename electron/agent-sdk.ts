import { Agent, type SDKAgent, type Run, type SDKMessage, type McpServerConfig } from "@cursor/sdk"
import { app } from "electron"
import { resolve, join, dirname } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import type { ChatType, LaunchMeta } from "./agent-session-types"
import { resolveSessionChatName } from "./session-chat-name"
import { assembleWakePrompt, computePromptHash, resolveDaemonPortForPrompt } from "./prompt-assembler"
import { buildSdkMcpServers } from "../src/shared/harness-mcp-store.js"
import { getAgentResource } from "./config-store"
import { readLockFile, httpPost, notifySessionLaunched as notifyDaemonSessionLaunched } from "./daemon-client"
import {
  type PollPhaseEventPayload,
  type StreamAgg,
  type StreamCardHost,
  type StreamPollPhaseState,
  type StreamTodoItem,
  applyTodoUpdate,
  buildStreamPayload,
  endStreamRound,
  enqueueReply,
  enqueueThinking,
  enqueueTool,
  enterSilentPollPhase,
  flushStreamCard,
  isFeishuStreamEnabled,
  isMediaSendInvocation,
  isPollMessageTool,
  isSendQuestionInvocation,
  isShowThinkingEnabled,
  isStreamSilenced,
  isTodoUpdateInvocation,
  isToolStreamSilenced,
  newStreamAgg,
  POLL_DIRECTIVE_END_MARK,
  POLL_DIRECTIVE_TIMEOUT_MARK,
  postStreamCard,
  scheduleFlushStreamCard,
  sealAllThinking,
  sealLastThinking,
  sealRunningTools,
  shouldOmitFromStreamCard,
  summarizeToolArgs,
} from "./stream-card"
import {
  initSessionModelStore,
  resolveModelForSession,
  setSessionOverride,
  getSessionOverride,
  clearSessionOverride,
  pushRecentModel,
} from "../src/shared/session-model-store.js"
import { modelSlugFromParams, rememberModelLabel } from "../src/shared/model-utils.js"
import { projectIdFromSessionKey } from "../src/shared/project-types.js"

export interface SdkSessionAgent extends StreamCardHost {
  agent: SDKAgent
  /** 当前活跃 run；null 仅出现在 send 前的短暂窗口（run 结束即整体释放） */
  run: Run | null
  agentId: string
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
  /** 定时任务 outbound 投递目标 */
  notifySessionKey?: string
  /** 是否跳过数字身份（主工作区 / 项目 / 任务） */
  useMainWorkspace?: boolean
  /** 主用户私聊：协议内嵌 admin 段 */
  includeAdmin?: boolean
  /** 通道级数字身份 */
  digitalIdentityOverride?: string
  abortController: AbortController
  /** 通道开关：是否保留会话上下文（run 结束后记录 agentId，新消息 Resume 续上） */
  keepSession: boolean
  /** 通道开关：是否长连接（无限 poll 保活）；false = 回答完即收回合，按需唤醒 */
  persistentPoll: boolean
  /** 实际使用的模型 id（空/"auto" 时已解析为默认 composer-2） */
  model: string
  /** 模型参数 JSON（与启动时一致，供 UI 展示 slug） */
  modelParams?: string
  /** 流式日志聚合缓冲：连续同类型(thinking/text)增量合并成一条打印 */
  logAgg: { kind: "thinking" | "text" | null; buf: string }
  /** 飞书流式进度卡；非飞书通道为 null */
  streamAgg: StreamAgg | null
  /** 任务清单最新快照（会话级，跨换卡存活） */
  todoSnapshot: StreamTodoItem[] | null
  /** 最近一次 status 事件（含 RUNNING/ERROR 等），结束诊断与断线挂起判定用 */
  lastStatus?: { status: string; message?: string }
  /** poll 已见 messageId：非阻塞 poll 区分新消息 vs 重投 */
  seenMessageIds: Set<string>
  /** 已成功跑完 worker 回合的 messageId：黑洞重投时跳过重复处理 */
  processedMessageIds: Set<string>
  /** run 级 poll 等待态（跨换卡存活）；worker 模式下由宿主 poll，此处仅保留兼容 */
  pollPhase: StreamPollPhaseState
  /** Session Worker 托管 poll 时为 true（listening 阶段 run 可能为 null） */
  workerActive?: boolean
}

function newPollPhase(): StreamPollPhaseState {
  return { blocking: false, nonBlocking: false, questionPause: false }
}

const sdkSessions = new Map<string, SdkSessionAgent>()
const pendingLaunches = new Set<string>()
/** /reset 代数：拉起过程中被重置的会话丢弃本次拉起，防止 rememberResumable 把旧上下文写回 */
const sessionResetGen = new Map<string, number>()

// ── 会话上下文恢复（Resume）──────────────────────────────
// 不保留闲置 agent 进程：闲置连接会被代理/NAT 静默掐死，复用必报 SSL WRONG_VERSION_NUMBER。
// run 结束即释放进程，仅持久化 sessionKey→agentId 映射；新消息 Agent.resume 恢复——
// 全新连接 + 历史上下文完整保留，应用重启后同样有效。
interface ResumeEntry {
  agentId: string
  workspaceDir: string
  updatedAt: number
  senderOpenId?: string
  rulesHash?: string
  /** Resume 时记录的 Daemon 端口，用于检测端口漂移 */
  daemonPort?: number
  /** 最近一次飞书流式卡 cardId；进程重启后用于收口孤儿卡，避免 Resume 再建一张重复卡 */
  streamCardId?: string
}

function promptHashForSession(session: Pick<SdkSessionAgent, "sessionKey" | "chatType" | "useMainWorkspace" | "digitalIdentityOverride" | "includeAdmin">): string {
  return computePromptHash({
    meta: { chatType: session.chatType },
    sessionKey: session.sessionKey,
    useMainWorkspace: session.useMainWorkspace,
    includeAdmin: session.includeAdmin,
    digitalIdentityOverride: session.digitalIdentityOverride,
  }, undefined)
}

const RESUME_ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000
let resumableAgents: Map<string, ResumeEntry> | null = null

function resumeStorePath(): string {
  return join(app.getPath("userData"), "sdk-resume-map.json")
}

function ensureModelStore(): void {
  try { initSessionModelStore(app.getPath("userData")) } catch { /* tests / early */ }
}

function getResumableMap(): Map<string, ResumeEntry> {
  if (resumableAgents) return resumableAgents
  resumableAgents = new Map()
  try {
    const raw = JSON.parse(readFileSync(resumeStorePath(), "utf8")) as Record<string, ResumeEntry>
    const now = Date.now()
    for (const [key, e] of Object.entries(raw)) {
      if (e?.agentId && e.workspaceDir && now - (e.updatedAt ?? 0) < RESUME_ENTRY_TTL_MS) {
        resumableAgents.set(key, e)
      }
    }
  } catch { /* 首次运行或文件损坏：从空开始 */ }
  return resumableAgents
}

function saveResumableMap(): void {
  if (!resumableAgents) return
  try {
    writeFileSync(resumeStorePath(), JSON.stringify(Object.fromEntries(resumableAgents)), "utf8")
  } catch (e: unknown) {
    pushUiLog("SDK", "WARN", `Resume 映射保存失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function isResumeEligible(session: SdkSessionAgent): boolean {
  return session.keepSession
    && (session.chatType === "p2p" || session.chatType === "group" || session.chatType === "project")
}

function rememberResumable(session: SdkSessionAgent): void {
  if (!isResumeEligible(session) || !session.workspaceDir) return
  const prev = getResumableMap().get(session.sessionKey)
  getResumableMap().set(session.sessionKey, {
    agentId: session.agentId, workspaceDir: session.workspaceDir, updatedAt: Date.now(),
    senderOpenId: session.senderOpenId,
    rulesHash: promptHashForSession(session),
    daemonPort: resolveDaemonPortForPrompt() ?? undefined,
    streamCardId: session.streamAgg?.cardId ?? prev?.streamCardId,
  })
  saveResumableMap()
}

function patchResumableStreamCard(sessionKey: string, streamCardId: string | undefined, opts?: { onlyIf?: string }): void {
  const map = getResumableMap()
  const e = map.get(sessionKey)
  if (!e) return
  // 清除必须带期望值：延迟 finish 的清理不能抹掉新回合刚记录的新卡
  if (opts?.onlyIf && e.streamCardId !== opts.onlyIf) return
  if (e.streamCardId === streamCardId) return
  e.streamCardId = streamCardId
  e.updatedAt = Date.now()
  saveResumableMap()
}

function forgetResumable(sessionKey: string): void {
  if (getResumableMap().delete(sessionKey)) saveResumableMap()
}

let sdkIdleHandler: ((sessionKey: string) => void) | null = null
/** sessionKey → 连续失败次数与最近失败时间（冷却判定在调度器层，对所有叫醒源生效） */
const sdkFailStreak = new Map<string, {
  count: number
  lastFailAt: number
  network?: boolean
  /** 鉴权/配额类永久错误：重试再多也不会自愈，必须退避否则死循环刷屏 */
  permanent?: boolean
}>()

/** 永久性错误退避阶梯（毫秒）：5s → 10s → 30s → 1min → 5min 封顶 */
const PERMANENT_FAIL_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 300_000]

/** 同一错误文本连续重复时的日志折叠：只打第 1 次及每 10 次 */
const lastFailLogSignature = new Map<string, string>()
const FAIL_LOG_FOLD_EVERY = 10

function shouldLogRepeatedFailure(sessionKey: string, errorDetail: string | undefined, count: number): boolean {
  const signature = (errorDetail || "unknown").slice(0, 200)
  const repeated = lastFailLogSignature.get(sessionKey) === signature
  lastFailLogSignature.set(sessionKey, signature)
  return !repeated || count % FAIL_LOG_FOLD_EVERY === 0
}

/** run 收口释放后回调（调度器借此立即消费运行期间积压的消息，含异常结束） */
export function setSdkIdleHandler(fn: (sessionKey: string) => void): void {
  sdkIdleHandler = fn
}

export function clearSdkFailStreak(sessionKey: string): void {
  sdkFailStreak.delete(sessionKey)
  lastFailLogSignature.delete(sessionKey)
}

export function clearAllSdkFailStreaks(): void {
  sdkFailStreak.clear()
  lastFailLogSignature.clear()
}

// SDK socket 深处的网络错误只会抛到主进程全局兜底，无法关联到具体 run；
// 记一份近期错误，run 报错时附到详情里还原真实原因（如代理断连）
const recentGlobalErrors: { at: number; msg: string }[] = []

export function noteGlobalSdkError(msg: string): void {
  recentGlobalErrors.push({ at: Date.now(), msg })
  if (recentGlobalErrors.length > 20) recentGlobalErrors.shift()
}

function recentGlobalErrorHint(withinMs: number): string {
  const cutoff = Date.now() - withinMs
  for (let i = recentGlobalErrors.length - 1; i >= 0; i--) {
    if (recentGlobalErrors[i].at >= cutoff) return recentGlobalErrors[i].msg
  }
  return ""
}

/**
 * 瞬时故障（网络/断连）不退避，立即重试；
 * 鉴权/配额这类永久错误按阶梯退避——否则每轮不到 1s 的重试会把日志刷爆。
 */
export function sdkFailCooldownRemaining(sessionKey: string): number {
  const st = sdkFailStreak.get(sessionKey)
  if (!st?.permanent) return 0
  const idx = Math.min(st.count - 1, PERMANENT_FAIL_BACKOFF_MS.length - 1)
  const wait = PERMANENT_FAIL_BACKOFF_MS[Math.max(idx, 0)]
  return Math.max(0, st.lastFailAt + wait - Date.now())
}

/** pack/异常退出后 force 重发偶发挂死；超时后丢 resume，下次全新会话 */
const FORCE_SEND_TIMEOUT_MS = 30_000
const REATTACH_PROBE_MS = 1500

async function tryReattachActiveRun(
  agent: SDKAgent,
  workspaceDir: string,
  sessionKey: string,
): Promise<Run | null> {
  try {
    const { items } = await Agent.listRuns(agent.agentId, { runtime: "local", cwd: workspaceDir, limit: 10 })
    const active = items.find((r) => r.status === "running")
    if (!active) return null
    const run = await Agent.getRun(active.id, { runtime: "local", cwd: workspaceDir })
    if (run.status !== "running") return null
    pushUiLog("SDK", "INFO", `[${sessionKey}] 挂接残留 active run ${active.id}`)
    return run
  } catch (e: unknown) {
    pushUiLog("SDK", "DEBUG", `[${sessionKey}] getRun 挂接失败: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

function probeRunStillLive(run: Run, ms = REATTACH_PROBE_MS): Promise<boolean> {
  if (run.status !== "running") return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (live: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      resolve(live)
    }
    const timer = setTimeout(() => done(true), ms)
    const off = run.onDidChangeStatus((s) => { if (s !== "running") done(false) })
  })
}

async function cancelActiveRun(
  agent: SDKAgent,
  workspaceDir: string,
  sessionKey: string,
): Promise<boolean> {
  try {
    const { items } = await Agent.listRuns(agent.agentId, { runtime: "local", cwd: workspaceDir, limit: 10 })
    const active = items.find((r) => r.status === "running")
    if (!active) return false
    pushUiLog("SDK", "WARN", `[${sessionKey}] cancel 残留 active run ${active.id}`)
    await Agent.cancelRun(active.id, { runtime: "local", cwd: workspaceDir })
    return true
  } catch (e: unknown) {
    pushUiLog("SDK", "DEBUG", `[${sessionKey}] cancel 残留 run 失败: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 挂接续听时不 send(prompt)（必撞 active run）；唤醒指令入队由 run poll 消费 */
async function enqueueInternalWake(sessionKey: string, chatType: ChatType, prompt: string): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port || !prompt.trim()) return
  try {
    await httpPost(`http://127.0.0.1:${lock.port}/enqueue`, { content: prompt, sessionKey, chatType })
    pushUiLog("SDK", "INFO", `[${sessionKey}] 唤醒 prompt 已入队（挂接续听，跳过 send）`)
  } catch { /* best-effort */ }
}

function finishLiveReattach(
  session: SdkSessionAgent,
  reattached: Run,
  prompt: string,
  resetGenAtStart: number,
  sessionKey: string,
): Promise<{ ok: true }> {
  return enqueueInternalWake(sessionKey, session.chatType, prompt).then(() => {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 挂接成功，续听残留 run`)
    startRunLifecycle(session, reattached)
    if ((sessionResetGen.get(sessionKey) ?? 0) === resetGenAtStart) rememberResumable(session)
    return { ok: true as const }
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

function scheduleSdkIdle(sessionKey: string, errored: boolean, opts?: { network?: boolean; silent?: boolean; permanent?: boolean }): void {
  if (errored) {
    const st = sdkFailStreak.get(sessionKey) ?? { count: 0, lastFailAt: 0, network: false }
    st.count += 1
    st.lastFailAt = Date.now()
    st.network = !!opts?.network
    st.permanent = !!opts?.permanent
    sdkFailStreak.set(sessionKey, st)
    if (!opts?.silent) {
      const waitMs = sdkFailCooldownRemaining(sessionKey)
      pushUiLog("SDK", st.count > 8 ? "ERROR" : "WARN",
        `[${sessionKey}] 异常结束×${st.count}，${waitMs > 0 ? `${Math.round(waitMs / 1000)}s 后重试` : "立即重试"}`)
    }
  } else {
    const prev = sdkFailStreak.get(sessionKey)
    clearSdkFailStreak(sessionKey)
    if (prev && prev.count >= 2) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] 已恢复（曾连续失败 ${prev.count} 次）`)
    }
  }
  // 成功失败都立即叫醒调度器；失败无冷却，可立刻再拉起
  sdkIdleHandler?.(sessionKey)
}

function sessionKeyEquals(a: string, b: string): boolean {
  if (a === b) return true
  return process.platform === "win32" && a.toLowerCase() === b.toLowerCase()
}

/** live 查找：精确 → Win 大小写对齐 → 同 chatId 唯一匹配（带 workspace 时必须对齐） */
function findSdkSessionLoose(sessionKey: string): SdkSessionAgent | undefined {
  const exact = sdkSessions.get(sessionKey)
  if (exact) return exact
  for (const [k, s] of sdkSessions) {
    if (sessionKeyEquals(k, sessionKey)) return s
  }
  const chatId = sessionKey.includes("::") ? sessionKey.slice(0, sessionKey.indexOf("::")) : sessionKey
  const matches = [...sdkSessions.values()].filter((s) => {
    const k = s.sessionKey
    return k === chatId || k.startsWith(`${chatId}::`)
      || (process.platform === "win32" && (
        k.toLowerCase() === chatId.toLowerCase()
        || k.toLowerCase().startsWith(`${chatId.toLowerCase()}::`)
      ))
  })
  if (matches.length === 0) return undefined
  if (sessionKey.includes("::")) {
    const ws = sessionKey.slice(sessionKey.indexOf("::") + 2)
    return matches.find((s) => {
      const i = s.sessionKey.indexOf("::")
      if (i < 0) return false
      const sw = s.sessionKey.slice(i + 2)
      return sessionKeyEquals(sw, ws)
    })
  }
  // 未带 workspace：仅当同 chat 唯一 live 时才兜底
  return matches.length === 1 ? matches[0] : undefined
}

function findResumableLoose(sessionKey: string): { key: string; entry: ResumeEntry } | undefined {
  const map = getResumableMap()
  const exact = map.get(sessionKey)
  if (exact) return { key: sessionKey, entry: exact }
  for (const [k, e] of map) {
    if (sessionKeyEquals(k, sessionKey)) return { key: k, entry: e }
  }
  return undefined
}

function closeAndRemoveSession(session: SdkSessionAgent): void {
  try { session.agent.close() } catch { /* best-effort */ }
  sdkSessions.delete(session.sessionKey)
}

function ensureSdkBinaryPaths(): void {
  if (process.env.CURSOR_RIPGREP_PATH) return

  const platformPkg = `@cursor/sdk-${process.platform}-${process.arch}`
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg"

  const candidates: string[] = []
  try {
    const req = createRequire(import.meta.url)
    const pkgDir = dirname(req.resolve(`${platformPkg}/package.json`))
    candidates.push(join(pkgDir, "bin", binaryName))
  } catch { /* package not resolvable */ }

  // fallback: walk up from app dir
  const appDir = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath)
  for (const base of [appDir, resolve(".")]) {
    candidates.push(join(base, "node_modules", platformPkg, "bin", binaryName))
    candidates.push(join(base, "resources", "node_modules", platformPkg, "bin", binaryName))
  }

  for (const p of candidates) {
    // asar 内的二进制无法 spawn（existsSync 对 asar 虚拟路径返回 true），需指向解包目录
    const real = p.includes("app.asar") && !p.includes("app.asar.unpacked")
      ? p.replace("app.asar", "app.asar.unpacked")
      : p
    if (existsSync(real)) {
      process.env.CURSOR_RIPGREP_PATH = real
      pushUiLog("SDK", "INFO", `Ripgrep 路径: ${real}`)
      return
    }
  }
  pushUiLog("SDK", "WARN", `未找到 ${binaryName}，SDK 可能报错 (searched: ${candidates.join(", ")})`)
}


function broadcastSdkSessionStatus(): void {
  const list = [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    pid: 0,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType as string,
    chatName: resolveSessionChatName(s.sessionKey, s.chatName, s.senderOpenId),
    workspaceDir: s.workspaceDir,
    model: s.model,
    modelParams: s.modelParams,
  }))
  broadcastSessionStatus(list, "sdk")
}


// stream() 发出的 thinking.text / assistant text 均为增量 delta，逐条打印会刷屏；
// 这里按类型聚合，切换类型 / 超过阈值 / 遇到 tool·status·结束时才落一条日志
const LOG_FLUSH_LEN = 400

function extractToolResultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (typeof result !== "object") return String(result)
  const rec = result as Record<string, unknown>
  for (const key of ["output", "stdout", "content", "text", "result", "message"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  try { return JSON.stringify(rec) } catch { return "" }
}

interface PollPayload {
  messages?: Array<{ messageId?: string; text?: string }>
  keepAlive?: boolean
  directive?: string
  kind?: string
}

function parsePollJson(result: unknown): PollPayload | null {
  const raw = extractToolResultText(result).trim()
  if (!raw) return null
  try {
    return JSON.parse(raw) as PollPayload
  } catch {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end <= start) return null
    try { return JSON.parse(raw.slice(start, end + 1)) as PollPayload } catch { return null }
  }
}

function parsePollDelivery(session: SdkSessionAgent, result: unknown): {
  hasUserMsgs: boolean
  hasNewUserMsgs: boolean
  isEnd: boolean
  isTimeout: boolean
} {
  const empty = { hasUserMsgs: false, hasNewUserMsgs: false, isEnd: false, isTimeout: false }
  const p = parsePollJson(result)
  if (!p) return empty

  const msgs = p.messages ?? []
  const userMsgs = msgs.filter((m) => m.messageId && !m.messageId.startsWith("internal_"))
  let hasNewUserMsgs = false
  for (const m of userMsgs) {
    const id = m.messageId!
    if (!session.seenMessageIds.has(id)) {
      hasNewUserMsgs = true
      session.seenMessageIds.add(id)
    }
  }
  const hasUserMsgs = userMsgs.length > 0

  if (p.directive) {
    if (hasUserMsgs) return { hasUserMsgs, hasNewUserMsgs, isEnd: false, isTimeout: false }
    const d = p.directive
    if (d.includes(POLL_DIRECTIVE_END_MARK)) return { hasUserMsgs: false, hasNewUserMsgs: false, isEnd: true, isTimeout: false }
    if (d.includes(POLL_DIRECTIVE_TIMEOUT_MARK)) return { hasUserMsgs: false, hasNewUserMsgs: false, isEnd: false, isTimeout: true }
    return empty
  }

  if (p.kind === "end") return { hasUserMsgs: false, hasNewUserMsgs: false, isEnd: true, isTimeout: false }
  if (p.kind === "timeout") return { hasUserMsgs: false, hasNewUserMsgs: false, isEnd: false, isTimeout: true }
  const override = msgs.find((m) => !m.messageId && /SYSTEM OVERRIDE/.test(m.text ?? ""))
  if (override) {
    const isEnd = /按需唤醒|安静结束/.test(override.text ?? "")
    return { hasUserMsgs: false, hasNewUserMsgs: false, isEnd, isTimeout: !isEnd }
  }

  return { hasUserMsgs, hasNewUserMsgs, isEnd: false, isTimeout: false }
}

/** 按需唤醒收到 end directive 后必须终止 run，否则僵尸态挡新消息 */
async function terminateRunAfterPollEnd(session: SdkSessionAgent): Promise<void> {
  pushUiLog("SDK", "INFO", `[${session.sessionKey}] 按需唤醒 directive=end，宿主终止 run`)
  const run = session.run
  if (run) {
    try { await run.cancel() } catch { /* best-effort */ }
  }
  session.abortController.abort()
}

/** 可 Resume 的异常终态：不把流式卡标成已完成，便于重连续写 */
function shouldSuspendStreamCard(session: SdkSessionAgent, status: string): boolean {
  if (!session.keepSession) return false
  return status === "ERROR" || status === "EXPIRED" || status === "CANCELLED"
}

export type { PollPhaseEventPayload } from "./stream-card"

/** 宿主 worker 回合开始：清 poll 等待态并打开流式卡（SSE poll-phase 与 fetch poll 竞态时仍保开门） */
function openStreamForSdkTurn(session: SdkSessionAgent): void {
  session.pollPhase.blocking = false
  session.pollPhase.nonBlocking = false
  session.pollPhase.questionPause = false
  if (!isFeishuStreamEnabled(session.sessionKey)) return
  if (!session.streamAgg || session.streamAgg.finished) {
    session.streamAgg = newStreamAgg(true)
  } else {
    session.streamAgg.gateOpen = true
  }
}

/** daemon poll HTTP 生命周期 → 流式卡状态（唯一真值，不解析 command） */
export function handlePollPhaseEvent(
  sessionKey: string,
  phase: "start" | "end",
  payload: PollPhaseEventPayload,
): void {
  const session = findSdkSessionLoose(sessionKey)
  if (!session) return

  // 宿主 worker 自行 fetch poll：SSE poll-phase 仅同步 messageId，不驱动 gateOpen/换卡
  if (session.workerActive) {
    if (phase === "end") {
      for (const id of payload.messageIds ?? []) {
        if (id) session.seenMessageIds.add(id)
      }
    }
    pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] poll-phase ${phase} worker-hosted (skip gate)`)
    return
  }

  if (phase === "start") {
    const blocking = payload.blocking === true
    if (blocking) {
      if (session.pollPhase.blocking) return
      session.pollPhase.blocking = true
      const stream = session.streamAgg
      if (stream && !stream.finished) stream.gateOpen = false
    } else {
      session.pollPhase.nonBlocking = true
    }
    pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] poll-phase start blocking=${blocking}`)
    return
  }

  const blocking = payload.blocking === true
  const wasNonBlocking = session.pollPhase.nonBlocking
  const wasBlocking = session.pollPhase.blocking
  session.pollPhase.nonBlocking = false

  const deliveredIds = (payload.messageIds ?? []).filter((id): id is string => !!id)
  let hasNewUserMsgs = false
  let hasFreshDelivery = false
  for (const id of deliveredIds) {
    if (!session.seenMessageIds.has(id)) {
      hasFreshDelivery = true
      if (!id.startsWith("internal_")) hasNewUserMsgs = true
      session.seenMessageIds.add(id)
    }
  }
  const hasWorkMsgs = deliveredIds.length > 0
  const directive = payload.directive ?? ""
  const isEnd = payload.reason === "end" || directive.includes(POLL_DIRECTIVE_END_MARK)
  const isTimeout = payload.reason === "timeout" || directive.includes(POLL_DIRECTIVE_TIMEOUT_MARK)
  const isAbort = payload.reason === "abort"

  if (isEnd && (wasBlocking || blocking)) {
    void terminateRunAfterPollEnd(session)
  }

  if (hasFreshDelivery) session.pollPhase.questionPause = false

  if (wasBlocking || blocking) {
    if (isTimeout || isEnd || isAbort) {
      enterSilentPollPhase(session)
      pushUiLog("SDK", "DEBUG",
        `[${session.sessionKey}] poll-phase end blocking=${blocking} reason=${payload.reason ?? "?"} silent=1`)
      return
    }
    if (hasWorkMsgs) {
      session.pollPhase.blocking = false
      session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
      pushUiLog("SDK", "DEBUG",
        `[${session.sessionKey}] 阻塞poll换新队列 bornAt=${session.streamAgg?.bornAt ?? "null"}`)
      if (session.streamAgg) scheduleFlushStreamCard(session, true)
      return
    }
  }

  const stream = session.streamAgg
  if (!stream || stream.finished) {
    pushUiLog("SDK", "DEBUG",
      `[${session.sessionKey}] poll-phase end blocking=${blocking} reason=${payload.reason ?? "?"} newUser=${hasNewUserMsgs} (no stream)`)
    return
  }

  pushUiLog("SDK", "DEBUG",
    `[${session.sessionKey}] poll-phase end blocking=${blocking} reason=${payload.reason ?? "?"} newUser=${hasNewUserMsgs} work=${hasWorkMsgs} bornAt=${stream.bornAt}`)

  if (wasNonBlocking && !hasNewUserMsgs && hasWorkMsgs) {
    if (!stream.ensured) {
      stream.segments = []
      stream.dirty = false
      pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] 非阻塞 poll 重复投递，清预热队列`)
    } else {
      pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] 非阻塞 poll 重复投递，保留已刷内容`)
    }
    stream.gateOpen = true
    scheduleFlushStreamCard(session, true)
    return
  }

  if (wasNonBlocking) {
    stream.gateOpen = true
    scheduleFlushStreamCard(session, true)
  }
}

/**
 * 拉起后通知 daemon：resumed=false 全新会话（收口上一 run 残留流式卡）。失败静默＝降级默认行为。
 */
async function notifySessionLaunched(sessionKey: string, resumed: boolean): Promise<void> {
  await notifyDaemonSessionLaunched(sessionKey, { resumed, runtime: "sdk" })
}

function flushSdkLog(session: SdkSessionAgent): void {
  const agg = session.logAgg
  const text = agg.buf.trim()
  if (agg.kind && text) {
    if (agg.kind === "thinking") {
      pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] [thinking] ${text}`)
    } else {
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] ${text}`)
    }
  }
  agg.kind = null
  agg.buf = ""
}

function appendSdkLog(session: SdkSessionAgent, kind: "thinking" | "text", delta: string): void {
  const agg = session.logAgg
  if (agg.kind && agg.kind !== kind) flushSdkLog(session)
  agg.kind = kind
  agg.buf += delta
  if (agg.buf.length >= LOG_FLUSH_LEN) flushSdkLog(session)
}

function formatRunResultForLog(result: unknown): string | undefined {
  if (result == null || result === "") return undefined
  const s = String(result)
  if (s.length <= 200) return `result=${s}`
  return `result=${s.slice(0, 200)}…(+${s.length - 200} chars)`
}

async function streamRunEvents(session: SdkSessionAgent, run: Run): Promise<void> {
  try {
    for await (const event of run.stream()) {
      if (session.abortController.signal.aborted) break
      session.lastActivityAt = Date.now()
      handleSdkEvent(session, event)
    }
    flushSdkLog(session)
  } catch (e: unknown) {
    flushSdkLog(session)
    if (!session.abortController.signal.aborted) {
      const msg = e instanceof Error ? `[${e.constructor.name}] ${e.message}` : String(e)
      const stack = e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : ""
      const cause = e instanceof Error && "cause" in e && e.cause ? JSON.stringify(e.cause) : ""
      pushUiLog("SDK", "ERROR", `[${session.sessionKey}] 流处理异常: ${msg}${stack ? ` stack=${stack}` : ""}${cause ? ` cause=${cause}` : ""}`)
    }
  } finally {
    if (session.abortController.signal.aborted) return
    // run 结束：落最终内容并关闭 streaming_mode（飞书 CardKit）
    // 全程无 thinking/tool/text 则不建空卡
    try {
      const agg = session.streamAgg
      if (agg && (agg.ensured || agg.dirty || agg.segments.length)) {
        sealAllThinking(agg)
        sealRunningTools(agg)
        if (agg.suspended || (session.lastStatus && shouldSuspendStreamCard(session, session.lastStatus.status))) {
          agg.suspended = true
          await flushStreamCard(session, false)
        } else {
          await flushStreamCard(session, true)
        }
      } else if (agg) {
        agg.finished = true
      }
    } catch { /* best-effort */ }
  }
}

function handleSdkEvent(session: SdkSessionAgent, event: SDKMessage): void {
  if (session.abortController.signal.aborted) return
  const stream = session.streamAgg
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          appendSdkLog(session, "text", block.text)
          if (isStreamSilenced(session)) continue
          // 宿主模式：assistant 正文进用户可见 reply 区（与 Pi LLM text_delta 一致）
          if (stream && !stream.finished) {
            stream.gateOpen = true
            enqueueReply(stream, block.text)
            scheduleFlushStreamCard(session)
          }
        }
      }
      break
    case "thinking":
      if (event.text) {
        appendSdkLog(session, "thinking", event.text)
        if (isStreamSilenced(session)) break
        if (stream && !stream.finished && isShowThinkingEnabled(session.sessionKey)) {
          enqueueThinking(stream, event.text)
          scheduleFlushStreamCard(session)
        }
      }
      break
    case "tool_call": {
      flushSdkLog(session)
      const summary = event.status === "running" ? summarizeToolArgs(event.args) : ""
      const detectSummary = summary || summarizeToolArgs(event.args) || ""
      pushUiLog("SDK", "INFO", `[${session.sessionKey}] [tool] ${event.name}: ${event.status}${summary ? ` · ${summary}` : ""}`)
      if (stream && !stream.finished) {
        if (isToolStreamSilenced(session)) {
          break
        }
        if (isTodoUpdateInvocation(event.name)) {
          stream.gateOpen = true
          applyTodoUpdate(session, stream, event.args)
          scheduleFlushStreamCard(session, true)
          break
        }
        if (shouldOmitFromStreamCard(event.name, detectSummary, event.args)) {
          if (isMediaSendInvocation(event.name, detectSummary, event.args)) {
            stream.gateOpen = true
            if (event.status === "running") {
              sealLastThinking(stream)
              stream.forceNewThinking = true
              scheduleFlushStreamCard(session, true)
            } else {
              // completed/error：与 daemon seal 对齐，换新队列，防复制整卡 / 思考中挂起
              endStreamRound(session)
            }
            break
          }
          if (isSendQuestionInvocation(event.name, detectSummary, event.args) && event.status === "running") {
            session.pollPhase.questionPause = true
            pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] send_question 开始，暂停写 segments`)
          }
          // poll / send_text 等协议工具：不 gateOpen、不刷首卡，等 poll-phase 结束统一开门
          if (event.status === "running" && !isPollMessageTool(event.name, detectSummary, event.args)) {
            stream.gateOpen = true
            sealLastThinking(stream)
            stream.forceNewThinking = true
            scheduleFlushStreamCard(session, true)
          }
          break
        }
        stream.gateOpen = true
        enqueueTool(stream, event, summary)
        scheduleFlushStreamCard(session, event.status === "running")
      }
      break
    }
    case "status": {
      flushSdkLog(session)
      const isErr = event.status === "ERROR" || event.status === "EXPIRED"
      // 含 RUNNING：换模等待依赖 lastStatus，不能只记终态
      session.lastStatus = { status: event.status, message: event.message }
      const lvl = isErr ? "ERROR" as const : "INFO" as const
      pushUiLog("SDK", lvl, `[${session.sessionKey}] [status] ${event.status}${event.message ? ` - ${event.message}` : ""}`)
      // FINISHED / 终态：尽快收口流式卡（finally 还会再 finish 一次，daemon 侧幂等）
      if (stream && (event.status === "FINISHED" || event.status === "ERROR" || event.status === "CANCELLED" || event.status === "EXPIRED")) {
        sealAllThinking(stream)
        sealRunningTools(stream)
        if (event.status === "FINISHED") {
          void flushStreamCard(session, true)
        } else if (shouldSuspendStreamCard(session, event.status)) {
          // 断线/取消：刷最后一帧但不 finish，Daemon 侧保留 card 供 Resume 接续
          stream.suspended = true
          void flushStreamCard(session, false)
        } else {
          void flushStreamCard(session, true)
        }
      }
      break
    }
  }
}

// ── 公开 API ────────────────────────────────────────

export function isSdkSessionRunning(sessionKey: string): boolean {
  if (pendingLaunches.has(sessionKey)) return true
  try {
    const { isSdkWorkerActive } = require("./sdk-session-worker.js") as typeof import("./sdk-session-worker.js")
    if (isSdkWorkerActive(sessionKey)) return true
  } catch { /* worker 未加载 */ }
  const s = findSdkSessionLoose(sessionKey)
  if (!s || s.abortController.signal.aborted) return false
  return s.run !== null || !!s.workerActive
}

/** 是否有可 Resume 的历史会话（上下文可恢复，无需完整冷启动提示） */
export function hasResumableSdkSession(sessionKey: string): boolean {
  return getResumableMap().has(sessionKey)
}

// ── 会话诊断 ─────────────────────────────────────────────

export interface SdkRunResult {
  status: string
  endedAt: number
  durationMs?: number
  error?: string
}

export interface SdkSessionDiagnostics {
  running: boolean
  resumeAgentId?: string
  resumeUpdatedAt?: number
  lastRun?: SdkRunResult
}

/** 每会话最近一次 run 的终态（内存，重启清零；诊断面板用） */
const lastRunResults = new Map<string, SdkRunResult>()

export function getSdkSessionDiagnostics(sessionKey: string): SdkSessionDiagnostics {
  const resume = getResumableMap().get(sessionKey)
  return {
    running: isSdkSessionRunning(sessionKey),
    resumeAgentId: resume?.agentId,
    resumeUpdatedAt: resume?.updatedAt,
    lastRun: lastRunResults.get(sessionKey),
  }
}

/** 诊断包用：resume 映射概要（agentId 非敏感） */
export function getResumableSummary(): { sessionKey: string; agentId: string; workspaceDir: string; updatedAt: number }[] {
  return [...getResumableMap().entries()].map(([sessionKey, e]) => ({
    sessionKey, agentId: e.agentId, workspaceDir: e.workspaceDir, updatedAt: e.updatedAt,
  }))
}

export function getSdkSessionCount(): number {
  let count = 0
  for (const s of sdkSessions.values()) {
    if (!s.abortController.signal.aborted && s.run !== null) count++
  }
  return count
}

export function getSdkSessionList() {
  return [...sdkSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    agentId: s.agentId,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType,
    workspaceDir: s.workspaceDir,
    senderOpenId: s.senderOpenId,
    chatName: s.chatName,
    model: s.model,
    modelParams: s.modelParams,
  }))
}

export interface SdkLaunchOptions {
  sessionKey: string
  chatType: ChatType
  meta?: LaunchMeta
  workspaceDir: string
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  /** 该会话所属通道绑定的 SDK 资源 API Key */
  apiKey: string
  /** 调用方解析好的模型（空 = composer-2） */
  model?: string
  modelParams?: string
  /** 通道开关：保留会话上下文（默认 true；false = 每条消息全新会话） */
  keepSession?: boolean
  /** 通道开关：长连接无限 poll 保活（默认 true；false = 回答完收回合按需唤醒） */
  persistentPoll?: boolean
  /** 主用户每次新会话：跳过 Resume，直接新建（上下文清零） */
  newSession?: boolean
  /** 调度拉起时已知的队列 messageId（bootstrap poll 不应因此换卡） */
  pendingMessageIds?: string[]
  /** 定时任务 outbound 投递目标（notify_session_key） */
  notifySessionKey?: string
  /** 通道级数字身份 */
  digitalIdentityOverride?: string
  /** 主用户私聊：挂载 lk-harness-admin 并在协议内嵌 admin 段 */
  includeAdmin?: boolean
}

export interface SdkTurnResult {
  ok: boolean
  errorDetail?: string
  networkFail: boolean
  permanentFail: boolean
}

/** run 生命周期托管；workerHosted 时保留 agent 供下轮 poll 继续 */
function startRunLifecycle(session: SdkSessionAgent, run: Run, opts?: { workerHosted?: boolean }): Promise<SdkTurnResult> {
  session.run = run
  session.lastActivityAt = Date.now()
  lastRunResults.delete(session.sessionKey)

  return streamRunEvents(session, run).then(async () => {
    const sessionKey = session.sessionKey
    if (session.abortController.signal.aborted) {
      session.run = null
      if (!opts?.workerHosted) {
        sdkSessions.delete(sessionKey)
        broadcastSdkSessionStatus()
      }
      pushUiLog("SDK", "INFO", `[${sessionKey}] Agent 已中止（用户停止或 daemon 关闭）`)
      return { ok: false, errorDetail: "aborted", networkFail: false, permanentFail: false }
    }
    let errorDetail: string | undefined
    let networkFail = false
    let permanentFail = false
    if (run.status === "error") {
      const wr = await run.wait().catch((e: unknown) => e)
      let detail: string
      if (wr instanceof Error) {
        detail = `${wr.constructor.name}: ${wr.message}${(wr as Error & { cause?: unknown }).cause ? ` cause=${String((wr as Error & { cause?: unknown }).cause)}` : ""}`
      } else if (wr && typeof wr === "object") {
        const o = wr as Record<string, unknown>
        detail = JSON.stringify({
          status: o.status, result: o.result, error: o.error, message: o.message,
          durationMs: o.durationMs, id: o.id, model: o.model,
        })
      } else {
        detail = String(wr)
      }
      const last = session.lastStatus
      const lastStr = last ? `lastStatus=${last.status}${last.message ? ` msg=${last.message}` : ""} ` : ""
      const netHint = recentGlobalErrorHint(120_000)
      errorDetail = `${lastStr}${detail}${netHint ? ` | net=${netHint}` : ""}`.slice(0, 500)
      networkFail = /API key exchange|exchange_user_api_key|fetch failed|unauthenticated|ECONNRESET|socket hang up|GOAWAY|疑似底层网络/i.test(errorDetail)
      permanentFail = !networkFail && /invalid[_ ]api[_ ]key|api key not valid|401|403|forbidden|quota|rate limit|insufficient|model .*not (found|available)/i.test(errorDetail)
    }

    lastRunResults.set(sessionKey, {
      status: run.status ?? "unknown",
      endedAt: Date.now(),
      durationMs: run.durationMs ?? undefined,
      error: errorDetail,
    })

    session.run = null
    const errored = run.status === "error"

    if (opts?.workerHosted) {
      if (!errored) rememberResumable(session)
      broadcastSdkSessionStatus()
      if (errored) {
        const st = sdkFailStreak.get(sessionKey)
        const dur = run.durationMs != null ? `${run.durationMs}ms` : "?"
        if (shouldLogRepeatedFailure(sessionKey, errorDetail, st?.count ?? 1)) {
          pushUiLog("SDK", (st?.count ?? 0) > 8 ? "ERROR" : "WARN",
            `[${sessionKey}] worker 回合失败 ${dur} | ${errorDetail || "unknown"}`)
        }
      } else {
        const summary = [
          formatRunResultForLog(run.result),
          run.durationMs != null && `duration=${run.durationMs}ms`,
        ].filter(Boolean).join(", ")
        pushUiLog("SDK", "INFO", `[${sessionKey}] worker 回合结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)
        const { hostTouchSessionReply } = await import("./poll-host.js")
        void hostTouchSessionReply(sessionKey).catch(() => {})
      }
      return { ok: !errored, errorDetail, networkFail, permanentFail }
    }

    closeAndRemoveSession(session)
    broadcastSdkSessionStatus()

    if (errored) {
      scheduleSdkIdle(sessionKey, true, { network: networkFail, silent: true, permanent: permanentFail })
      const st = sdkFailStreak.get(sessionKey)
      const dur = run.durationMs != null ? `${run.durationMs}ms` : "?"
      const tip = networkFail ? "将Resume重建连接" : ""
      const waitMs = sdkFailCooldownRemaining(sessionKey)
      const retryTip = waitMs > 0 ? `→ ${Math.round(waitMs / 1000)}s 后重试` : "→ 立即重试"
      if (shouldLogRepeatedFailure(sessionKey, errorDetail, st?.count ?? 1)) {
        pushUiLog("SDK", (st?.count ?? 0) > 8 ? "ERROR" : "WARN",
          `[${sessionKey}] 运行失败×${st?.count ?? 1} ${dur}${tip ? ` ${tip}` : ""} ${retryTip} | ${errorDetail || "unknown"}`)
      }
    } else {
      const summary = [
        formatRunResultForLog(run.result),
        run.durationMs != null && `duration=${run.durationMs}ms`,
      ].filter(Boolean).join(", ")
      pushUiLog("SDK", "INFO", `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)
      scheduleSdkIdle(sessionKey, false)
    }
    return { ok: !errored, errorDetail, networkFail, permanentFail }
  })
}

async function sendSdkPrompt(session: SdkSessionAgent, prompt: string): Promise<Run> {
  const { agent, sessionKey, workspaceDir } = session
  try {
    return await agent.send(prompt)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes("already has active run")) throw e

    pushUiLog("SDK", "WARN", `[${sessionKey}] 检测到残留 active run，先 cancel 清 store`)
    await cancelActiveRun(agent, workspaceDir ?? "", sessionKey)

    try {
      return await withTimeout(agent.send(prompt), FORCE_SEND_TIMEOUT_MS, "send after cancel")
    } catch (retryErr: unknown) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
      if (!retryMsg.includes("already has active run")) throw retryErr
      const reattached = await tryReattachActiveRun(agent, workspaceDir ?? "", sessionKey)
      if (reattached && await probeRunStillLive(reattached)) {
        throw new Error("active run reattached; worker 不应走到此路径")
      }
      pushUiLog("SDK", "WARN", `[${sessionKey}] cancel/挂接均失败，force 恢复重发`)
      return await withTimeout(
        agent.send(prompt, { local: { force: true } }),
        FORCE_SEND_TIMEOUT_MS,
        "force send",
      )
    }
  }
}

export async function executeSdkTurn(session: SdkSessionAgent, prompt: string): Promise<SdkTurnResult> {
  if (session.abortController.signal.aborted) {
    return { ok: false, errorDetail: "aborted", networkFail: false, permanentFail: false }
  }
  openStreamForSdkTurn(session)
  pushUiLog("SDK", "INFO", `[${session.sessionKey}] worker 回合 Prompt:\n${prompt}`)
  const run = await sendSdkPrompt(session, prompt)
  return startRunLifecycle(session, run, { workerHosted: true })
}

export async function unregisterSdkSessionForWorker(session: SdkSessionAgent, aborted: boolean): Promise<void> {
  session.workerActive = false
  void sealStreamCardForStop(session).catch(() => {})
  if (!aborted && session.keepSession) rememberResumable(session)
  // 仅当仍是 map 中的活跃实例时才 release——避免旧 worker finally 误删新 launch 登记的 session
  if (sdkSessions.get(session.sessionKey) === session) {
    await releaseSession(session)
  }
}

export function onSdkWorkerFinished(
  sessionKey: string,
  errored: boolean,
  opts?: { network?: boolean; permanent?: boolean; errorDetail?: string },
): void {
  // 新 launch / 新 worker 已接替时，旧 worker 的 finally 不应再触发调度
  if (pendingLaunches.has(sessionKey)) return
  const live = findSdkSessionLoose(sessionKey)
  if (live?.workerActive) return
  try {
    const { isSdkWorkerActive } = require("./sdk-session-worker.js") as typeof import("./sdk-session-worker.js")
    if (isSdkWorkerActive(sessionKey)) return
  } catch { /* worker 未加载 */ }
  if (errored) {
    scheduleSdkIdle(sessionKey, true, { network: opts?.network, silent: true, permanent: opts?.permanent })
    const st = sdkFailStreak.get(sessionKey)
    const waitMs = sdkFailCooldownRemaining(sessionKey)
    const retryTip = waitMs > 0 ? `→ ${Math.round(waitMs / 1000)}s 后重试` : "→ 立即重试"
    if (shouldLogRepeatedFailure(sessionKey, opts?.errorDetail, st?.count ?? 1)) {
      pushUiLog("SDK", (st?.count ?? 0) > 8 ? "ERROR" : "WARN",
        `[${sessionKey}] worker 异常结束×${st?.count ?? 1} ${retryTip} | ${opts?.errorDetail || "unknown"}`)
    }
    broadcastLog(`[SDK] 会话 ${sessionKey} worker 异常: ${opts?.errorDetail}`, "ERROR")
  } else {
    pushUiLog("SDK", "INFO", `[${sessionKey}] worker 已退出`)
    scheduleSdkIdle(sessionKey, false)
  }
}

export async function launchSdkAgent(opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, workspaceDir, senderOpenId, chatName, taskMessage } = opts

  const { startSdkWorkerLoop, isSdkWorkerActive, stopSdkWorker } = await import("./sdk-session-worker.js")

  if (isSdkWorkerActive(sessionKey)) {
    const s = findSdkSessionLoose(sessionKey)
    if (s) {
      s.lastActivityAt = Date.now()
      if (opts.notifySessionKey?.trim()) s.notifySessionKey = opts.notifySessionKey.trim()
      if (!s.senderOpenId && senderOpenId) s.senderOpenId = senderOpenId
      for (const id of opts.pendingMessageIds ?? []) {
        if (id) s.seenMessageIds.add(id)
      }
    }
    return { ok: true }
  }

  if (isSdkSessionRunning(sessionKey) || pendingLaunches.has(sessionKey)) {
    const s = findSdkSessionLoose(sessionKey)
    if (s) {
      s.lastActivityAt = Date.now()
      if (opts.notifySessionKey?.trim()) s.notifySessionKey = opts.notifySessionKey.trim()
      // 异常重启等路径可能丢失用户标识，随新消息自愈回填（否则会话名永远兜底为「通道名·访客」）
      if (!s.senderOpenId && senderOpenId) s.senderOpenId = senderOpenId
      for (const id of opts.pendingMessageIds ?? []) {
        if (id) s.seenMessageIds.add(id)
      }
    }
    return { ok: true }
  }

  pendingLaunches.add(sessionKey)
  const resetGenAtStart = sessionResetGen.get(sessionKey) ?? 0

  const apiKey = opts.apiKey?.trim()
  if (!apiKey) {
    pendingLaunches.delete(sessionKey)
    return { ok: false, error: "通道绑定的 SDK 资源未配置 API Key（设置 → Agent）" }
  }

  const keepSession = opts.keepSession ?? true
  const persistentPoll = keepSession && (opts.persistentPoll ?? true)

  try {
    ensureSdkBinaryPaths()
    ensureModelStore()

    const fallbackModel = opts.model?.trim() && opts.model.trim() !== "auto" ? opts.model.trim() : "composer-2"
    const resolvedRef = resolveModelForSession(sessionKey, {
      model: fallbackModel,
      modelParams: opts.modelParams ?? "",
    })
    const modelId = resolvedRef.model?.trim() && resolvedRef.model.trim() !== "auto" ? resolvedRef.model.trim() : "composer-2"
    const modelParams = resolvedRef.modelParams ?? ""
    const modelSelection: { id: string; params?: { id: string; value: string }[] } = { id: modelId }
    if (modelParams.trim()) {
      try {
        modelSelection.params = JSON.parse(modelParams)
      } catch { /* ignore bad JSON */ }
    }

    const localOptions = {
      cwd: workspaceDir,
      settingSources: [] as ("project" | "user")[],
      sandboxOptions: { enabled: false },
    }

    const sdkPort = resolveDaemonPortForPrompt()
    const includeAdmin = opts.includeAdmin === true
    const mcpServers = buildSdkMcpServers(sdkPort, includeAdmin) as Record<string, McpServerConfig>
    const agentBaseOpts = { apiKey, model: modelSelection, local: localOptions, mcpServers }

    // Resume 语义：
    // - project 永远 Resume（带 taskMessage 时任务附在唤醒 prompt 里）
    // - task/temp 带 taskMessage 为任务首启不 Resume；无 taskMessage 为续聊，Resume 保上下文
    // - p2p/group 正常 Resume
    const wantResume = keepSession && !opts.newSession
      && (chatType === "project" || !taskMessage)
    if (!wantResume) forgetResumable(sessionKey)
    const resumable = wantResume ? getResumableMap().get(sessionKey) : undefined
    let agent: SDKAgent | undefined
    if (resumable && resumable.workspaceDir === workspaceDir) {
      try {
        pushUiLog("SDK", "INFO", `[${sessionKey}] Resume 恢复会话 (agentId=${resumable.agentId}, model=${JSON.stringify(modelSelection)}, 新连接/上下文保留)`)
        agent = await Agent.resume(resumable.agentId, agentBaseOpts)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        // 只有服务端确认上下文不存在才允许回退全新会话；网络等瞬时故障直接放弃本次拉起——
        // resume 映射保留、消息还在队列，调度器下轮重试 Resume，上下文绝不因瞬时故障丢失
        if (!/not found/i.test(msg)) {
          pushUiLog("SDK", "WARN", `[${sessionKey}] Resume 暂不可用（瞬时故障，保留上下文稍后重试）: ${msg}`)
          return { ok: false, error: `Resume 暂不可用: ${msg}` }
        }
        pushUiLog("SDK", "WARN", `[${sessionKey}] Resume 上下文已不存在，回退全新会话: ${msg}`)
      }
    }
    const resumed = agent !== undefined

    if (!agent) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] 正在创建 SDK Agent (cwd=${workspaceDir}, model=${JSON.stringify(modelSelection)})`)
      agent = await Agent.create(agentBaseOpts)
    }

    // 拉起期间被 /reset：本次 agent 可能带着旧上下文，直接丢弃（队列消息会驱动下一次全新拉起）
    if ((sessionResetGen.get(sessionKey) ?? 0) !== resetGenAtStart) {
      try { agent.close() } catch { /* best-effort */ }
      pushUiLog("SDK", "INFO", `[${sessionKey}] 拉起期间会话被重置，丢弃本次拉起（下次全新会话）`)
      return { ok: false, error: "会话已重置" }
    }

    // 残留旧实例必须先释放（abort 事件流）再登记新实例：直接 set 覆盖会留下无人管的旧事件流，
    // 新旧两个实例交替刷同一张流式卡（内容来回跳动、任务清单时有时无的根因）
    await stopSdkWorker(sessionKey)
    const stale = sdkSessions.get(sessionKey)
    if (stale) {
      pushUiLog("SDK", "WARN", `[${sessionKey}] 检测到残留旧会话实例，先行释放防双写 (agentId=${stale.agentId})`)
      await releaseSession(stale)
    }

    const abortController = new AbortController()
    const session: SdkSessionAgent = {
      sessionKey,
      agent,
      run: null,
      agentId: agent.agentId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      chatType,
      workspaceDir,
      senderOpenId: senderOpenId ?? resumable?.senderOpenId,
      chatName,
      notifySessionKey: opts.notifySessionKey?.trim() || undefined,
      useMainWorkspace: opts.useMainWorkspace,
      includeAdmin,
      digitalIdentityOverride: opts.digitalIdentityOverride,
      abortController,
      keepSession,
      persistentPoll,
      model: modelId,
      modelParams,
      logAgg: { kind: null, buf: "" },
      streamAgg: isFeishuStreamEnabled(sessionKey) ? newStreamAgg() : null,
      todoSnapshot: null,
      patchStreamCardId: (cardId, patchOpts) => patchResumableStreamCard(sessionKey, cardId, patchOpts),
      seenMessageIds: new Set((opts.pendingMessageIds ?? []).filter(Boolean)),
      processedMessageIds: new Set<string>(),
      pollPhase: newPollPhase(),
    }

    sdkSessions.set(sessionKey, session)
    if (session.seenMessageIds.size > 0) {
      pushUiLog("SDK", "DEBUG", `[${sessionKey}] 预登记 ${session.seenMessageIds.size} 条队列 messageId（bootstrap poll 不换卡）`)
    }
    broadcastLog(`[SDK] 会话 ${sessionKey} 已${resumed ? "恢复" : "创建"}, agentId=${agent.agentId}, model=${JSON.stringify(modelSelection)}`)
    broadcastSdkSessionStatus()
    pushRecentModel({ model: modelId, modelParams })

    // Resume 会话的规则是创建时快照：规则文件变过则在唤醒 prompt 里硬指令重读
    const currentDaemonPort = resolveDaemonPortForPrompt()
    const rulesUpdated = resumed && !!resumable?.rulesHash
      && resumable.rulesHash !== promptHashForSession({
        sessionKey,
        chatType,
        useMainWorkspace: opts.useMainWorkspace,
        includeAdmin,
        digitalIdentityOverride: opts.digitalIdentityOverride,
      })
    const portChanged = resumed && !!resumable?.daemonPort && !!currentDaemonPort
      && resumable.daemonPort !== currentDaemonPort
    if (rulesUpdated) pushUiLog("SDK", "INFO", `[${sessionKey}] 检测到协议/规则变更（已反映于 prompt 上下文，rulesHash 已变）`)
    if (portChanged) pushUiLog("SDK", "INFO", `[${sessionKey}] 检测到 Daemon 端口变更 ${resumable!.daemonPort} → ${currentDaemonPort}`)
    // 全新项目会话（not found 回退 / reset 后 / resume 映射丢失）必须重带项目元数据——
    // 新 Agent 没有历史上下文，不注入就不知道项目/仓库/分支/角色
    let effectiveTask = taskMessage
    if (!resumed && !effectiveTask?.trim() && chatType === "project") {
      const pid = projectIdFromSessionKey(sessionKey)
      if (pid) {
        try {
          const { getProject } = await import("../src/shared/project-store.js")
          const { buildProjectSessionPrompt } = await import("./project-prompts")
          const proj = getProject(pid)
          if (proj) {
            effectiveTask = buildProjectSessionPrompt(proj)
            pushUiLog("SDK", "INFO", `[${sessionKey}] 全新项目会话，已重新注入项目上下文（${proj.name}）`)
          }
        } catch (e: unknown) {
          pushUiLog("SDK", "WARN", `[${sessionKey}] 项目上下文注入失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    const promptCtx = {
      meta,
      sessionKey,
      useMainWorkspace: opts.useMainWorkspace,
      includeAdmin,
      notifySessionKey: opts.notifySessionKey,
      digitalIdentityOverride: opts.digitalIdentityOverride,
      taskMessage: resumed ? taskMessage : effectiveTask,
    }
    // pack/进程重启后 daemon 内存无卡，飞书旧流式卡仍在：Resume 前先按持久化 cardId 收口，避免再建一张重复卡
    if (resumed && resumable?.streamCardId && session.streamAgg) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] Resume 收口孤儿流式卡 card=${resumable.streamCardId}`)
      await postStreamCard(sessionKey, "finish", { segments: [] }, { cardId: resumable.streamCardId })
      patchResumableStreamCard(sessionKey, undefined, { onlyIf: resumable.streamCardId })
    }
    await notifySessionLaunched(sessionKey, resumed)

    if ((sessionResetGen.get(sessionKey) ?? 0) === resetGenAtStart) {
      rememberResumable(session)
    }

    if (isSdkWorkerActive(sessionKey)) {
      session.workerActive = true
      return { ok: true }
    }

    pushUiLog("SDK", "INFO", `[${sessionKey}] ${resumed ? "恢复" : "启动"} Session Worker (persistentPoll=${persistentPoll})`)
    session.workerActive = true
    void startSdkWorkerLoop(session, {
      persistentPoll,
      promptCtx,
      taskMessage: promptCtx.taskMessage,
      firstTurn: !resumed || !!(opts.pendingMessageIds?.length),
    })

    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[SDK] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    // 不动 resume 映射：仍指向上一个可用的 agentId，重试可续上上下文
    const failed = sdkSessions.get(sessionKey)
    if (failed) closeAndRemoveSession(failed)
    broadcastSdkSessionStatus()
    return { ok: false, error: msg }
  } finally {
    pendingLaunches.delete(sessionKey)
  }
}

/** /stop 等主动终止：finish 当前流式卡，避免 Resume 后旧卡与新卡叠内容 */
async function sealStreamCardForStop(session: SdkSessionAgent): Promise<void> {
  const agg = session.streamAgg
  if (!agg?.cardId || agg.finished) {
    session.streamAgg = null
    return
  }
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  sealAllThinking(agg)
  sealRunningTools(agg)
  agg.finished = true
  const finishCardId = agg.cardId
  session.streamAgg = null
  try {
    const payload = buildStreamPayload(agg, session.sessionKey)
    await postStreamCard(session.sessionKey, "finish", payload, { cardId: finishCardId })
    patchResumableStreamCard(session.sessionKey, undefined, { onlyIf: finishCardId })
  } catch { /* best-effort */ }
}

/** 停止并释放会话：先 abort 再 cancel（工具执行中 cancel 可能延迟，但不再调度/刷卡） */
function releaseSession(s: SdkSessionAgent): Promise<void> {
  s.abortController.abort()
  if (s.streamAgg?.timer) {
    clearTimeout(s.streamAgg.timer)
    s.streamAgg.timer = null
  }
  const { agent, run } = s
  s.run = null
  sdkSessions.delete(s.sessionKey)
  if (!run) {
    try { agent.close() } catch { /* best-effort */ }
    return Promise.resolve()
  }
  const timeout = new Promise<void>((r) => setTimeout(r, 2000))
  return Promise.race([run.cancel().catch(() => {}), timeout]).then(() => {
    try { agent.close() } catch { /* best-effort */ }
  })
}

/** 停止会话进程（保留 resume 映射，下条消息仍可续上下文；清上下文用 resetSdkSessionContext） */
export async function stopSdkSession(sessionKey: string): Promise<void> {
  for (const k of [...pendingLaunches]) {
    if (sessionKeyEquals(k, sessionKey)) pendingLaunches.delete(k)
  }
  const { stopSdkWorker } = await import("./sdk-session-worker.js")
  await stopSdkWorker(sessionKey)
  const s = findSdkSessionLoose(sessionKey)
  if (!s) return
  pushUiLog("SDK", "INFO", `[${s.sessionKey}] 会话已停止`)
  void sealStreamCardForStop(s).catch(() => {})
  await releaseSession(s)
  broadcastSdkSessionStatus()
}

/** 切模：写 override + 停止当前 Agent（如有）；有排队消息时 dispatch 自动拉起。 */
export async function switchSdkSessionModel(
  sessionKey: string,
  model: string,
  modelParams?: string,
): Promise<{ ok: boolean; deferred?: boolean; error?: string }> {
  const mid = model?.trim()
  if (!mid) return { ok: false, error: "model 不能为空" }
  ensureModelStore()
  const params = modelParams ?? ""
  setSessionOverride(sessionKey, { model: mid, modelParams: params })
  pushRecentModel({ model: mid, modelParams: params })

  const live = findSdkSessionLoose(sessionKey)
  const effectiveKey = live?.sessionKey ?? sessionKey
  if (effectiveKey !== sessionKey && !sessionKeyEquals(effectiveKey, sessionKey)) {
    setSessionOverride(effectiveKey, { model: mid, modelParams: params })
  }

  if (live) {
    pushUiLog("SDK", "INFO", `[${effectiveKey}] 换模 → ${mid}，停止当前 Agent`)
    const { stopSdkWorker } = await import("./sdk-session-worker.js")
    await stopSdkWorker(effectiveKey)
    await releaseSession(live)
    broadcastSdkSessionStatus()
  } else {
    pushUiLog("SDK", "INFO", `[${sessionKey}] 已记下模型 ${mid}`)
  }
  return { ok: true, deferred: true }
}

/** 显式重置会话上下文（/reset）：停掉在跑的 run、丢弃 resume 映射，下条消息全新会话 */
export function resetSdkSessionContext(sessionKey: string): void {
  sessionResetGen.set(sessionKey, (sessionResetGen.get(sessionKey) ?? 0) + 1)
  void import("./sdk-session-worker.js").then(({ stopSdkWorker }) => stopSdkWorker(sessionKey))
  const live = findSdkSessionLoose(sessionKey)
  if (live) void releaseSession(live)
  forgetResumable(sessionKey)
}

/** 搬运用导出：SDK 侧取数弱——transcript API 优先，流式卡正文回退；只取助手正文，用户轮缺失 */
export async function exportSdkTranscript(sessionKey: string): Promise<import("./agent-engine/types.js").TranscriptTurn[]> {
  try {
    const live = sdkSessions.get(sessionKey)
    if (!live) return []
    try {
      const api = (live.agent as unknown as { getTranscript?: () => Promise<unknown> })?.getTranscript
      if (typeof api === "function") {
        const raw = await api.call(live.agent)
        if (Array.isArray(raw)) {
          const turns = (raw as { role?: unknown; text?: unknown; content?: unknown }[])
            .filter((m) => (m.role === "user" || m.role === "assistant") && typeof (m.text ?? m.content) === "string" && String(m.text ?? m.content).trim())
            .map((m) => ({ role: m.role as "user" | "assistant", text: String(m.text ?? m.content).trim() }))
          if (turns.length > 0) {
            const { takeLastTurns } = await import("./carryover.js")
            return takeLastTurns(turns)
          }
        }
      }
    } catch { /* 流式卡回退 */ }
    const { takeLastTurns } = await import("./carryover.js")
    const replies = (live.streamAgg?.segments ?? [])
      .filter((s): s is { type: "reply"; text: string } => s.type === "reply" && !!s.text.trim())
      .map((s) => ({ role: "assistant" as const, text: s.text.trim() }))
    return takeLastTurns(replies)
  } catch { return [] }
}

/**
 * 停止全部运行中的会话进程；保留 resume 映射（应用重启后上下文可恢复）。
 * 返回的 Promise 在所有 run 取消落库（或超时）后 resolve——退出前 await 可避免残留 active run。
 */
export function stopAllSdkSessions(): Promise<void> {
  pendingLaunches.clear()
  return import("./sdk-session-worker.js").then(({ stopAllSdkWorkers }) =>
    stopAllSdkWorkers().then(() => {
      const sessions = [...sdkSessions.values()]
      for (const s of sessions) s.abortController.abort()
      broadcastSdkSessionStatus()
      const releases = sessions.map(async (s) => {
        void sealStreamCardForStop(s).catch(() => {})
        await releaseSession(s)
      })
      return Promise.all(releases).then(() => {})
    }),
  )
}

export async function checkSdkApiKey(apiKey: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const me = await Cursor.me({ apiKey: key })
    return { ok: true, email: me.userEmail }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export interface SdkModelOption {
  id: string
  label: string
  params: string
  current: boolean
}

/** 与设置页同一套：modelSlug（含 params 里的 1m/300k） */
function modelSlug(id: string, params: { id: string; value: string }[]): string {
  return modelSlugFromParams(id, params)
}

export async function listSdkModels(apiKey: string, currentModelId?: string, currentModelParams?: string): Promise<{ ok: boolean; models: SdkModelOption[]; error?: string }> {
  const key = apiKey?.trim()
  if (!key) return { ok: false, models: [], error: "API Key 未配置" }

  try {
    const { Cursor } = await import("@cursor/sdk")
    const sdkModels = await Cursor.models.list({ apiKey: key })
    const currentModel = currentModelId?.trim() || ""
    const currentParams = currentModelParams?.trim() || ""

    const models: SdkModelOption[] = []
    for (const m of sdkModels) {
      if (m.variants && m.variants.length > 0) {
        const slugCount = new Map<string, number>()
        for (const v of m.variants) {
          const s = modelSlug(m.id, v.params)
          slugCount.set(s, (slugCount.get(s) || 0) + 1)
        }
        for (const v of m.variants) {
          const ps = JSON.stringify(v.params)
          const slug = modelSlug(m.id, v.params)
          const hasDup = (slugCount.get(slug) || 0) > 1
          const label = hasDup
            ? `${slug} (${v.params.map((p) => `${p.id}=${p.value}`).join(", ")})`
            : slug
          rememberModelLabel(m.id, ps, label)
          models.push({
            id: m.id,
            label,
            params: ps,
            current: m.id === currentModel && ps === currentParams,
          })
        }
      } else {
        const label = m.id
        rememberModelLabel(m.id, "", label)
        models.push({
          id: m.id,
          label,
          params: "",
          current: m.id === currentModel && !currentParams,
        })
      }
    }
    return { ok: true, models }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, models: [], error: msg }
  }
}
