import { Agent, type SDKAgent, type Run, type SDKMessage, type McpServerConfig } from "@cursor/sdk"
import { app } from "electron"
import { resolve, join, dirname } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pushUiLog, broadcastLog, broadcastSessionStatus } from "./ui-logger"
import { type ChatType, type LaunchMeta, buildPrompt, resolveSessionChatName } from "./agent-launcher"
import { assembleWakePrompt, computePromptHash, resolveDaemonPortForPrompt } from "./prompt-assembler"
import { buildSdkMcpServers, shouldIncludeAdminMcp } from "../src/shared/claw-mcp-store.js"
import { getAgentResource, resolveChannelForSession } from "./config-store"
import { readLockFile, httpPost } from "./daemon-client"
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

interface StreamToolEntry {
  callId: string
  name: string
  status: "running" | "completed" | "error"
  summary: string
  startedAt?: number
  ms?: number
}

type StreamSegment =
  | { type: "thinking"; text: string; startedAt?: number; ms?: number }
  | { type: "tools"; tools: StreamToolEntry[] }
  | { type: "reply"; text: string }
  | { type: "todos"; items: StreamTodoItem[] }

interface StreamTodoItem {
  id?: string
  content: string
  status: string
}


/**
 * 飞书流式卡：事件队列。
 * 同类合并、异类新开；SDK assistant 正文当思考；空段丢弃。
 * 切卡仅在新用户消息 / 点选项（见 rotate）；阻塞 poll 开始只收口不换卡。
 */
interface StreamAgg {
  segments: StreamSegment[]
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  ensured: boolean
  /** Daemon 侧 cardId：finish 必须带上，防延迟 finish 误杀下一轮新卡 */
  cardId?: string
  lastFlushAt: number
  /** 串行化 ensure/update/finish，避免乱序 */
  inflight: Promise<void>
  finished: boolean
  /** false：未过首轮 poll 前不发流式卡（避免非阻塞预热单独建卡） */
  gateOpen: boolean
  /** send_* 正文边界：下一段思考必须新开，禁止并进 send 前的思考块 */
  forceNewThinking: boolean
  /** 断线挂起：不 finish 收口，Resume 后继续同一张卡 */
  suspended: boolean
  /** 队列诞生时刻：daemon 用它区分「seal 前的旧队列」（gone 丢弃）与「seal 后的新队列」（放行建卡） */
  bornAt: number
}

interface SdkSessionAgent {
  sessionKey: string
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
  /** 任务清单最新快照（会话级，跨换卡存活）：merge 更新基于它，新卡渲染完整清单 */
  todoSnapshot: StreamTodoItem[] | null
  /** 最近一次 status 事件（含 RUNNING/ERROR 等），结束诊断与断线挂起判定用 */
  lastStatus?: { status: string; message?: string }
  /** poll 已见 messageId：非阻塞 poll 区分新消息 vs 重投 */
  seenMessageIds: Set<string>
  /** run 级 poll 等待态（跨换卡存活） */
  pollPhase: SessionPollPhase
}

interface SessionPollPhase {
  blocking: boolean
  nonBlocking: boolean
  questionPause: boolean
}

function newPollPhase(): SessionPollPhase {
  return { blocking: false, nonBlocking: false, questionPause: false }
}

function isStreamSilenced(session: SdkSessionAgent): boolean {
  const p = session.pollPhase
  return p.blocking || p.questionPause
}

function isToolStreamSilenced(session: SdkSessionAgent): boolean {
  const p = session.pollPhase
  return p.blocking || p.nonBlocking || p.questionPause
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

function promptHashForSession(session: Pick<SdkSessionAgent, "sessionKey" | "chatType" | "useMainWorkspace" | "digitalIdentityOverride">): string {
  return computePromptHash({
    meta: { chatType: session.chatType },
    sessionKey: session.sessionKey,
    useMainWorkspace: session.useMainWorkspace,
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

// prompt 由 agent-launcher.buildPrompt 统一构建

// stream() 发出的 thinking.text / assistant text 均为增量 delta，逐条打印会刷屏；
// 这里按类型聚合，切换类型 / 超过阈值 / 遇到 tool·status·结束时才落一条日志
const LOG_FLUSH_LEN = 400

/** CardKit 流式更新节流：~400ms 调度，且不低于 ~5/s（200ms） */
const STREAM_FLUSH_MS = 400
const STREAM_MIN_INTERVAL_MS = 200
const STREAM_THINKING_TAIL = 1500
/** 流式卡工具步上限（飞书单卡 ≤200 元素；每步约 1~2 元素） */
const MAX_STREAM_TOOL_STEPS = 40

function newStreamAgg(gateOpen = false): StreamAgg {
  return {
    segments: [],
    dirty: false,
    timer: null,
    ensured: false,
    lastFlushAt: 0,
    inflight: Promise.resolve(),
    finished: false,
    gateOpen,
    forceNewThinking: false,
    suspended: false,
    bornAt: Date.now(),
  }
}

/** 保活 poll 超时/断连/安静退出：保持静默并丢弃保活回合积累的段落 */
function enterSilentPollPhase(session: SdkSessionAgent): void {
  const stream = session.streamAgg
  if (stream && !stream.finished) {
    stream.segments = []
    stream.dirty = false
    if (stream.timer) {
      clearTimeout(stream.timer)
      stream.timer = null
    }
    stream.gateOpen = false
  }
  session.pollPhase.blocking = true
}

/** 已结束的 thinking 段写入固定 ms，避免后续 flush 继续涨表 */
function sealClosedThinking(agg: StreamAgg): void {
  const last = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type !== "thinking") continue
    if (seg.ms != null || seg.startedAt == null) continue
    if (i === last) continue
    seg.ms = Date.now() - seg.startedAt
  }
}

function sealAllThinking(agg: StreamAgg): void {
  for (const seg of agg.segments) {
    if (seg.type !== "thinking") continue
    if (seg.ms != null || seg.startedAt == null) continue
    seg.ms = Date.now() - seg.startedAt
  }
}

/** 收口时 running 工具改完成态：终态事件已无处投递（换卡/run 结束），不留假 running */
function sealRunningTools(agg: StreamAgg): void {
  for (const seg of agg.segments) {
    if (seg.type !== "tools") continue
    for (const t of seg.tools) {
      if (t.status !== "running") continue
      t.status = "completed"
      if (t.startedAt != null) t.ms = Date.now() - t.startedAt
    }
  }
}


/** 可 Resume 的异常终态：不把流式卡标成已完成，便于重连续写 */
function shouldSuspendStreamCard(session: SdkSessionAgent, status: string): boolean {
  if (!session.keepSession) return false
  return status === "ERROR" || status === "EXPIRED" || status === "CANCELLED"
}

function isFeishuStreamEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return !!ch && ch.type === "feishu" && ch.showThinking !== false
}

interface StreamCardPayload {
  segments: Array<
    | { type: "thinking"; text: string; ms?: number }
    | { type: "tools"; tools: { name: string; status: string; summary?: string; ms?: number }[] }
    | { type: "reply"; text: string }
    | { type: "todos"; items: { content: string; status: string }[] }
  >
}

function isShowThinkingEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return ch?.showThinking !== false
}


/** 丢掉末尾空块（空思考/空正文/空工具） */
function dropEmptyTail(stream: StreamAgg): void {
  while (stream.segments.length) {
    const last = stream.segments[stream.segments.length - 1]
    if (last.type === "thinking" && !last.text.trim()) { stream.segments.pop(); continue }
    if (last.type === "reply" && !last.text.trim()) { stream.segments.pop(); continue }
    if (last.type === "tools" && !last.tools.length) { stream.segments.pop(); continue }
    break
  }
}

function sealLastThinking(stream: StreamAgg): void {
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type !== "thinking" || last.ms != null) return
  // startedAt 缺失也要封存，否则后续思考会并进同一块
  last.ms = last.startedAt != null ? Date.now() - last.startedAt : 0
}

/** 入队思考：与上一块同类则合并，否则新开；空文本丢弃 */
function enqueueThinking(stream: StreamAgg, text: string): void {
  if (!text) return
  dropEmptyTail(stream)
  if (stream.forceNewThinking) {
    stream.forceNewThinking = false
    sealLastThinking(stream)
    stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
    stream.dirty = true
    return
  }
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type === "thinking" && last.ms == null) {
    last.text += text
    return
  }
  if (last?.type === "thinking") {
    // 已封存 → 新开一块
    stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
    return
  }
  sealLastThinking(stream)
  stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
}

/** updateTodos 工具调用：解析任务快照（merge=true 按 id 合并），原地刷新时间线中的任务清单段 */
function isTodoUpdateInvocation(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[_-]/g, "")
  return n === "updatetodos" || n === "todowrite" || n === "writetodos"
}

/** status 归一化：事件里是驼峰（inProgress），渲染映射用下划线（in_progress） */
function normalizeTodoStatus(s: unknown): string {
  const n = String(s ?? "").trim().replace(/[-_\s]/g, "").toLowerCase()
  if (n === "inprogress") return "in_progress"
  if (n === "completed" || n === "done") return "completed"
  if (n === "cancelled" || n === "canceled") return "cancelled"
  return "pending"
}

/**
 * 基于真实事件形态（实测）设计：
 * - 同一次调用会发多个 running 事件，args.todos 从 1 项流式增长到本次调用的全部项；
 * - 事件里无 id、无 merge 字段；status 为驼峰。
 * 因此按 content 匹配「合并」到会话级快照（跨换卡存活）：命中更新状态、未命中追加；
 * 仅当新清单与快照零交集时才视为全新清单整体替换。
 */
function applyTodoUpdate(session: SdkSessionAgent, stream: StreamAgg, args: unknown): void {
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch { return }
  }
  if (!args || typeof args !== "object") return
  const rec = args as { todos?: unknown }
  if (!Array.isArray(rec.todos)) return
  const incoming: StreamTodoItem[] = []
  for (const t of rec.todos) {
    if (!t || typeof t !== "object") continue
    const item = t as { id?: unknown; content?: unknown; status?: unknown }
    const content = typeof item.content === "string" ? item.content.trim() : ""
    if (!content) continue
    incoming.push({
      id: typeof item.id === "string" ? item.id : undefined,
      content,
      status: normalizeTodoStatus(item.status),
    })
  }
  if (!incoming.length) return

  const snapshot = session.todoSnapshot ?? []
  const sameItem = (a: StreamTodoItem, b: StreamTodoItem): boolean =>
    (!!a.id && a.id === b.id) || a.content === b.content
  const overlap = incoming.filter((inc) => snapshot.some((x) => sameItem(inc, x))).length
  if (snapshot.length && overlap === 0) {
    // 零交集 = 全新任务清单：整体替换
    session.todoSnapshot = incoming
  } else {
    for (const inc of incoming) {
      const hit = snapshot.find((x) => sameItem(inc, x))
      if (hit) {
        hit.status = inc.status
        if (inc.id && !hit.id) hit.id = inc.id
      } else {
        snapshot.push(inc)
      }
    }
    session.todoSnapshot = snapshot
  }
  pushUiLog("SDK", "DEBUG",
    `[${session.sessionKey}] [todos] incoming=${incoming.length} overlap=${overlap} snapshot=${session.todoSnapshot.length}`)

  let seg = stream.segments.find((s): s is Extract<StreamSegment, { type: "todos" }> => s.type === "todos")
  if (!seg) {
    dropEmptyTail(stream)
    sealLastThinking(stream)
    seg = { type: "todos", items: [] }
    stream.segments.push(seg)
  }
  seg.items = session.todoSnapshot.map((t) => ({ ...t }))
  stream.dirty = true
}

/** 入队工具：callId 已存在则更新；running 新开步；孤儿终态事件（上一回合遗留）丢弃 */
function enqueueTool(
  stream: StreamAgg,
  event: { call_id: string; name: string; args?: unknown; status: StreamToolEntry["status"] },
  summary: string,
): void {
  for (const seg of stream.segments) {
    if (seg.type !== "tools") continue
    const hit = seg.tools.find((x) => x.callId === event.call_id)
    if (!hit) continue
    hit.status = event.status
    if (summary) hit.summary = summary
    if (event.status === "running") {
      hit.startedAt = Date.now()
      hit.ms = undefined
    } else if (hit.startedAt != null && (event.status === "completed" || event.status === "error")) {
      hit.ms = Date.now() - hit.startedAt
    }
    return
  }
  // 终态事件但队列里没有对应步：running 落在换卡前的旧队列，别在新卡凭空造一个孤儿步
  if (event.status !== "running") return
  dropEmptyTail(stream)
  sealLastThinking(stream)
  let toolsSeg = stream.segments[stream.segments.length - 1]
  if (toolsSeg?.type !== "tools") {
    toolsSeg = { type: "tools", tools: [] }
    stream.segments.push(toolsSeg)
  }
  toolsSeg.tools.push({
    callId: event.call_id,
    name: resolveToolDisplayName(event.name, event.args),
    status: event.status,
    summary,
    startedAt: event.status === "running" ? Date.now() : undefined,
  })
}

/** 出站 payload：只按队列顺序输出，空段丢弃；SDK reply 残段并入思考 */
function buildStreamPayload(agg: StreamAgg, sessionKey: string): StreamCardPayload {
  const showThinking = isShowThinkingEnabled(sessionKey)
  sealClosedThinking(agg)
  const segments: StreamCardPayload["segments"] = []
  const lastIdx = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type === "thinking") {
      const text = seg.text.trim()
      if (!text || !showThinking) continue
      let thinking = text
      if (thinking.length > STREAM_THINKING_TAIL) {
        thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
      }
      const ms = seg.ms ?? (i === lastIdx && seg.startedAt != null ? Date.now() - seg.startedAt : undefined)
      // 不合并相邻思考：每块独立面板独立计时，避免旧思考被新思考顶出截断窗口
      segments.push({ type: "thinking", text: thinking, ms })
    } else if (seg.type === "tools") {
      if (!seg.tools.length) continue
      const tools = seg.tools.length > MAX_STREAM_TOOL_STEPS
        ? seg.tools.slice(-MAX_STREAM_TOOL_STEPS)
        : seg.tools
      const prev = segments[segments.length - 1]
      if (prev?.type === "tools") {
        prev.tools.push(...tools.map((t) => ({
          name: t.name,
          status: t.status,
          summary: t.summary || undefined,
          ms: t.ms,
        })))
      } else {
        segments.push({
          type: "tools",
          tools: tools.map((t) => ({
            name: t.name,
            status: t.status,
            summary: t.summary || undefined,
            ms: t.ms,
          })),
        })
      }
    } else if (seg.type === "todos") {
      if (!seg.items.length) continue
      segments.push({ type: "todos", items: seg.items.map((t) => ({ content: t.content, status: t.status })) })
    } else if (seg.type === "reply") {
      // 兼容残段：SDK 正文视作思考（独立块，不并入上一块）
      const text = seg.text.trim()
      if (!text || !showThinking) continue
      let thinking = text
      if (thinking.length > STREAM_THINKING_TAIL) {
        thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
      }
      segments.push({ type: "thinking", text: thinking })
    }
  }
  return { segments }
}


async function postStreamCard(
  sessionKey: string,
  action: "ensure" | "update" | "finish",
  payload: StreamCardPayload,
  opts?: { cardId?: string; queueBornAt?: number },
): Promise<{ cardId?: string; gone?: boolean } | undefined> {
  const lock = readLockFile()
  if (!lock?.port) return undefined
  try {
    const r = await httpPost(
      `http://127.0.0.1:${lock.port}/api/agent-stream-card`,
      {
        session_key: sessionKey,
        action,
        segments: payload.segments,
        ...(opts?.cardId ? { card_id: opts.cardId } : {}),
        ...(opts?.queueBornAt ? { queue_born_at: opts.queueBornAt } : {}),
      },
      15_000,
    ) as { ok?: boolean; skipped?: boolean; error?: string; cardId?: string; gone?: boolean } | null
    if (r && r.ok === false && !r.skipped) {
      pushUiLog("SDK", "DEBUG", `[${sessionKey}] 流式卡片 ${action} 失败: ${r.error || "unknown"}`)
    }
    if (r?.gone) return { gone: true }
    return r?.cardId ? { cardId: r.cardId } : undefined
  } catch (e: unknown) {
    pushUiLog("SDK", "DEBUG", `[${sessionKey}] 流式卡片 ${action} 异常: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

/** daemon 判定本队列已随旧卡收口（gone）：换空队列，不迁移 segments（旧卡已 seal，迁移会复制整卡） */
function rotateStaleStreamQueue(session: SdkSessionAgent, agg: StreamAgg): void {
  agg.finished = true
  pushUiLog("SDK", "DEBUG", `[${session.sessionKey}] 流式卡队列已随收口作废，换新空队列`)
  if (session.streamAgg !== agg) return
  session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
}

function scheduleFlushStreamCard(session: SdkSessionAgent, immediate = false): void {
  const agg = session.streamAgg
  if (!agg || agg.finished) return
  agg.dirty = true
  if (immediate) {
    if (agg.timer) {
      clearTimeout(agg.timer)
      agg.timer = null
    }
    void flushStreamCard(session, false)
    return
  }
  if (agg.timer) return
  const elapsed = Date.now() - agg.lastFlushAt
  const delay = Math.max(STREAM_FLUSH_MS, STREAM_MIN_INTERVAL_MS - elapsed)
  agg.timer = setTimeout(() => {
    agg.timer = null
    void flushStreamCard(session, false)
  }, Math.max(0, delay))
}

async function flushStreamCard(session: SdkSessionAgent, finish: boolean): Promise<void> {
  const agg = session.streamAgg
  if (!agg || agg.finished) return
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  if (!finish && !agg.dirty) return
  // 阻塞 poll 期间不发卡；仍保留 dirty，有新消息后开门再刷
  if (!finish && (!agg.gateOpen || session.pollPhase.blocking)) return

  const payload = buildStreamPayload(agg, session.sessionKey)
  // 空 payload 不建卡（只有会话条的空白卡会闪现给用户）；保留 dirty 等真内容
  if (!finish && !agg.ensured && payload.segments.length === 0) return
  agg.dirty = false
  agg.lastFlushAt = Date.now()
  // 同步标记，防止 status FINISHED 与 stream finally 双重 finish
  if (finish) agg.finished = true

  const run = async (): Promise<void> => {
    if (finish) {
      // 与 endStreamRound 对齐：无 cardId 不 finish，防误杀 MCP 新卡
      if (!agg.cardId) return
      await postStreamCard(session.sessionKey, "finish", payload, { cardId: agg.cardId })
      patchResumableStreamCard(session.sessionKey, undefined, { onlyIf: agg.cardId })
      return
    }
    // finish 已抢占：丢弃排队中的 update
    if (agg.finished) return
    if (!agg.ensured) {
      const ensured = await postStreamCard(session.sessionKey, "ensure", payload, { queueBornAt: agg.bornAt })
      if (ensured?.gone) {
        rotateStaleStreamQueue(session, agg)
        return
      }
      agg.ensured = true
      if (ensured?.cardId) {
        agg.cardId = ensured.cardId
        patchResumableStreamCard(session.sessionKey, ensured.cardId)
      }
      // Resume 复用 Daemon 已有卡时，ensure 本身不写内容，再补一帧 update
      const updated = await postStreamCard(session.sessionKey, "update", payload, { cardId: agg.cardId, queueBornAt: agg.bornAt })
      if (updated?.gone) {
        rotateStaleStreamQueue(session, agg)
        return
      }
      if (!agg.cardId && updated?.cardId) {
        agg.cardId = updated.cardId
        patchResumableStreamCard(session.sessionKey, updated.cardId)
      }
      return
    }
    const updated = await postStreamCard(session.sessionKey, "update", payload, { cardId: agg.cardId, queueBornAt: agg.bornAt })
    if (updated?.gone) {
      rotateStaleStreamQueue(session, agg)
      return
    }
    if (!agg.cardId && updated?.cardId) {
      agg.cardId = updated.cardId
      patchResumableStreamCard(session.sessionKey, updated.cardId)
    }
  }

  agg.inflight = agg.inflight.then(run, run)
  await agg.inflight
}

// ── 工具调用识别：优先结构化解析 args，字符串匹配只留给 shell command ──
// tool_call 事件本身是结构化的：MCP 工具有 args.toolName，shell 有 args.command。
// 严禁把整个 args 序列化后模糊匹配——Task 的 prompt / send_text 的 text 等长文本里
// 出现 "poll-message"、"send_text" 字样就会整体误判（Subagent 步被隐藏、卡片被错误收口）。

/** MCP 调用的目标工具名（args.toolName / tool_name）；非 MCP 调用返回 "" */
function mcpToolName(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["toolName", "tool_name"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/** shell 类工具的命令文本；非 shell 调用返回 "" */
function shellCommandText(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  return ""
}

/** cursor-claw 出站工具（已有独立飞书消息，不进流式工具区） */
const OUTBOUND_MCP_RE = /^(?:send_(?:text|question|image|file)|project_\w+)$/i
const MEDIA_MCP_RE = /^send_(?:file|image)$/i

function isPollMessageInvocation(name: string, summary: string, args?: unknown): boolean {
  const cmd = shellCommandText(args)
  if (cmd && /poll-message/i.test(cmd)) return true
  if (mcpToolName(args)) return false
  return /poll-message/i.test(summary)
}

/** 仅阻塞 poll 才换卡。必须看完整 command（摘要 120 字会裁掉 wait=false） */
function isBlockingPollMessage(name: string, summary: string, args?: unknown): boolean {
  if (!isPollMessageInvocation(name, summary, args)) return false
  const full = shellCommandText(args) || summary
  if (/wait\s*=\s*false/i.test(full)) return false
  if (/["']wait["']\s*:\s*false/i.test(full)) return false
  if (/wait%3[Dd]false/i.test(full)) return false
  return true
}

/** 仅隐藏本通道出站 MCP（send_text 等）与 poll；其它 MCP/工具都进流式工具区 */
function shouldOmitFromStreamCard(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return OUTBOUND_MCP_RE.test(mcp)
  if (OUTBOUND_MCP_RE.test(name.trim())) return true
  if (isPollMessageInvocation(name, summary, args)) return true
  // MCP 退避方案：shell curl 直连 daemon HTTP API 也是出站
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:text|question|image|file)/i.test(cmd)
}

/** send_file / send_image：独立消息，完成后必须换回合，否则 daemon seal 后 SDK 会 ensure 复制整卡 */
function isMediaSendInvocation(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return MEDIA_MCP_RE.test(mcp)
  if (MEDIA_MCP_RE.test(name.trim())) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:file|image)/i.test(cmd)
}

function isSendQuestionInvocation(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return /^send_question$/i.test(mcp)
  if (/^send_question$/i.test(name.trim())) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-question/i.test(cmd)
}

/** MCP 工具展示名：优先 args.toolName / tool_name；Task/subagent 加可见标记 */
function resolveToolDisplayName(name: string, args: unknown): string {
  const raw = name.trim()
  const isTask = /^task$/i.test(raw) || /^task\b/i.test(raw)
  let label = raw
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>
    if (isTask) {
      const desc = typeof rec.description === "string" ? rec.description.trim()
        : typeof rec.prompt === "string" ? rec.prompt.trim().slice(0, 80) : ""
      const sub = typeof rec.subagent_type === "string" ? rec.subagent_type.trim() : ""
      label = desc ? `🤖 Subagent · ${desc}` : sub ? `🤖 Subagent · ${sub}` : "🤖 Subagent"
      return label
    }
    for (const key of ["toolName", "tool_name", "name"]) {
      const v = rec[key]
      if (typeof v === "string" && v.trim()) {
        const server = typeof rec.serverName === "string" ? rec.serverName
          : typeof rec.server === "string" ? rec.server : ""
        return server ? `${server}/${v.trim()}` : v.trim()
      }
    }
  }
  return isTask ? "🤖 Subagent" : label
}


const POLL_DIRECTIVE_END_MARK = "安静退出"
const POLL_DIRECTIVE_TIMEOUT_MARK = "轮询正常超时"

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

export interface PollPhaseEventPayload {
  blocking?: boolean
  reason?: string
  messageIds?: string[]
  directive?: string
}

/** daemon poll HTTP 生命周期 → 流式卡状态（唯一真值，不解析 command） */
export function handlePollPhaseEvent(
  sessionKey: string,
  phase: "start" | "end",
  payload: PollPhaseEventPayload,
): void {
  const session = findSdkSessionLoose(sessionKey)
  if (!session) return

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
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    await httpPost(
      `http://127.0.0.1:${lock.port}/api/session-launched`,
      { session_key: sessionKey, resumed },
      5_000,
    )
  } catch { /* best-effort */ }
}

/**
 * 回合结束（阻塞 poll 挂起 / 干活途中拉到新消息）：
 * 同步换新队列，旧卡异步 finish 收口——后续事件自动落新卡。
 */
function endStreamRound(session: SdkSessionAgent): void {
  const agg = session.streamAgg
  if (!agg) {
    session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
    return
  }
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  const finishCardId = agg.cardId
  // 仅收口本 SDK 队列建过的卡；无 cardId 时 finish 会误杀 MCP 刚建的卡（拆卡/空卡）
  const shouldPost = !agg.finished && !!finishCardId
  agg.finished = true
  sealAllThinking(agg)
  sealRunningTools(agg)
  // 回合边界已过 bootstrap，新队列直接开门
  session.streamAgg = isFeishuStreamEnabled(session.sessionKey) ? newStreamAgg(true) : null
  if (!shouldPost) return
  const payload = buildStreamPayload(agg, session.sessionKey)
  // 必须带上旧卡 cardId：延迟 finish 不能误杀下一轮 MCP/SDK 新建的卡
  const finishAndClear = async (): Promise<void> => {
    await postStreamCard(session.sessionKey, "finish", payload, { cardId: finishCardId })
    // 已收口的卡不再留给 Resume 孤儿收口（条件清，防抹掉新回合的卡）
    patchResumableStreamCard(session.sessionKey, undefined, { onlyIf: finishCardId })
  }
  agg.inflight = agg.inflight.then(finishAndClear, finishAndClear)
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

// 工具入参摘要：按优先级挑最有信息量的字符串字段（Shell→command、Read→path、Grep→pattern…）
const TOOL_ARG_SUMMARY_KEYS = ["command", "path", "target_notebook", "pattern", "glob_pattern", "file_path", "image_path", "url", "query", "question", "text", "description", "name", "toolName", "tool_name", "serverName", "server"]
const TOOL_SUMMARY_MAX = 120

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  let text = ""
  for (const key of TOOL_ARG_SUMMARY_KEYS) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) { text = v.trim(); break }
  }
  if (!text) {
    try { text = JSON.stringify(rec) } catch { return "" }
    if (text === "{}") return ""
  }
  text = text.replace(/\s+/g, " ")
  return text.length > TOOL_SUMMARY_MAX ? `${text.slice(0, TOOL_SUMMARY_MAX)}…` : text
}

function handleSdkEvent(session: SdkSessionAgent, event: SDKMessage): void {
  const stream = session.streamAgg
  switch (event.type) {
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          appendSdkLog(session, "text", block.text)
          // 阻塞 poll 挂起期间不刷卡（避免重复 poll 思考落成新卡）
          if (isStreamSilenced(session)) continue
          // SDK 正文视作思考，不进用户可见正文区
          if (stream && !stream.finished && isShowThinkingEnabled(session.sessionKey)) {
            enqueueThinking(stream, block.text)
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
          if (event.status === "running" && !isPollMessageInvocation(event.name, detectSummary, event.args)) {
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
  const s = sdkSessions.get(sessionKey)
  return s !== undefined && !s.abortController.signal.aborted && s.run !== null
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
}

/** run 生命周期托管：结束即释放 agent 进程（上下文靠持久化的 agentId Resume 恢复） */
function startRunLifecycle(session: SdkSessionAgent, run: Run): void {
  session.run = run
  session.lastActivityAt = Date.now()
  lastRunResults.delete(session.sessionKey)

  streamRunEvents(session, run).then(async () => {
    const sessionKey = session.sessionKey
    let errorDetail: string | undefined
    let networkFail = false
    let permanentFail = false
    if (run.status === "error") {
      // wait() 返回 RunResult 对象（出错时也不抛），真实原因藏在 RunResult.result / 终态状态事件里
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
      // 鉴权/配额/模型不可用：重试不会自愈，必须退避（网络类优先，仍走零退避快速重连）
      permanentFail = !networkFail && /invalid[_ ]api[_ ]key|api key not valid|401|403|forbidden|quota|rate limit|insufficient|model .*not (found|available)/i.test(errorDetail)
      // 不清 Resume：agentId 仍在，下次 Agent.resume 换新本地句柄，云端上下文保留
    }

    lastRunResults.set(sessionKey, {
      status: run.status ?? "unknown",
      endedAt: Date.now(),
      durationMs: run.durationMs ?? undefined,
      error: errorDetail,
    })

    session.run = null
    const errored = run.status === "error"
    closeAndRemoveSession(session)
    broadcastSdkSessionStatus()

    if (errored) {
      // 记账失败次数后叫醒调度器；永久错误由 sdkFailCooldownRemaining 压住重试节奏
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
        run.result && `result=${run.result}`,
        run.durationMs != null && `duration=${run.durationMs}ms`,
      ].filter(Boolean).join(", ")
      pushUiLog("SDK", "INFO", `[${sessionKey}] Agent 运行结束 (status=${run.status}${summary ? `, ${summary}` : ""})`)
      scheduleSdkIdle(sessionKey, false)
    }
  })
}

export async function launchSdkAgent(opts: SdkLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, workspaceDir, senderOpenId, chatName, taskMessage } = opts

  if (isSdkSessionRunning(sessionKey) || pendingLaunches.has(sessionKey)) {
    const s = sdkSessions.get(sessionKey)
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
    const includeAdmin = shouldIncludeAdminMcp(meta, sessionKey)
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
      digitalIdentityOverride: opts.digitalIdentityOverride,
      abortController,
      keepSession,
      persistentPoll,
      model: modelId,
      modelParams,
      logAgg: { kind: null, buf: "" },
      streamAgg: isFeishuStreamEnabled(sessionKey) ? newStreamAgg() : null,
      todoSnapshot: null,
      seenMessageIds: new Set((opts.pendingMessageIds ?? []).filter(Boolean)),
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
        digitalIdentityOverride: opts.digitalIdentityOverride,
      })
    const portChanged = resumed && !!resumable?.daemonPort && !!currentDaemonPort
      && resumable.daemonPort !== currentDaemonPort
    if (rulesUpdated) pushUiLog("SDK", "INFO", `[${sessionKey}] 检测到协议/规则更新，唤醒时重灌全文`)
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
      notifySessionKey: opts.notifySessionKey,
      digitalIdentityOverride: opts.digitalIdentityOverride,
      rulesUpdated,
      portChanged,
      taskMessage: resumed ? taskMessage : effectiveTask,
    }
    const prompt = resumed
      ? assembleWakePrompt(promptCtx, undefined)
      : buildPrompt(meta, effectiveTask, sessionKey, opts.useMainWorkspace, opts.notifySessionKey, opts.digitalIdentityOverride)
    pushUiLog("SDK", "INFO", `[${sessionKey}] ${resumed ? "恢复" : "启动"} Prompt:\n${prompt}`)
    // pack/进程重启后 daemon 内存无卡，飞书旧流式卡仍在：Resume 前先按持久化 cardId 收口，避免再建一张重复卡
    if (resumed && resumable?.streamCardId && session.streamAgg) {
      pushUiLog("SDK", "INFO", `[${sessionKey}] Resume 收口孤儿流式卡 card=${resumable.streamCardId}`)
      await postStreamCard(sessionKey, "finish", { segments: [] }, { cardId: resumable.streamCardId })
      patchResumableStreamCard(sessionKey, undefined, { onlyIf: resumable.streamCardId })
    }
    // 发 prompt 前通知 daemon 拉起形态：Resume 打 fresh-only 标；全新会话收残留旧卡
    await notifySessionLaunched(sessionKey, resumed)
    let run: Run
    try {
      run = await agent.send(prompt)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes("already has active run")) throw e

      pushUiLog("SDK", "WARN", `[${sessionKey}] 检测到残留 active run，先 cancel 清 store`)
      await cancelActiveRun(agent, workspaceDir, sessionKey)

      try {
        run = await withTimeout(agent.send(prompt), FORCE_SEND_TIMEOUT_MS, "send after cancel")
      } catch (retryErr: unknown) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        if (!retryMsg.includes("already has active run")) throw retryErr
        // 非 pack 场景：进程可能仍在，尝试挂接续听（不 send）
        const reattached = await tryReattachActiveRun(agent, workspaceDir, sessionKey)
        if (reattached && await probeRunStillLive(reattached)) {
          return finishLiveReattach(session, reattached, prompt, resetGenAtStart, sessionKey)
        }
        pushUiLog("SDK", "WARN", `[${sessionKey}] cancel/挂接均失败，force 恢复重发`)
        try {
          run = await withTimeout(
            agent.send(prompt, { local: { force: true } }),
            FORCE_SEND_TIMEOUT_MS,
            "force send",
          )
        } catch (forceErr: unknown) {
          const forceMsg = forceErr instanceof Error ? forceErr.message : String(forceErr)
          pushUiLog("SDK", "WARN", `[${sessionKey}] force 恢复失败，丢弃 resume 映射下次全新会话: ${forceMsg}`)
          forgetResumable(sessionKey)
          throw forceErr instanceof Error ? forceErr : new Error(forceMsg)
        }
      }
    }
    startRunLifecycle(session, run)
    // 失败计数不在拉起时清零（断网时 Resume 总能成功、run 中途才死）：
    // run 成功跑完由 scheduleSdkIdle 清零；失败无冷却，调度器立即再拉
    // 持久化最新 agentId：run 结束释放进程后靠它 Resume，应用重启后依然有效
    // send 期间被 /reset 则不回写（否则旧上下文的 agentId 会覆盖掉刚删的映射）
    if ((sessionResetGen.get(sessionKey) ?? 0) === resetGenAtStart) {
      rememberResumable(session)
    }

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

/** 停止并释放会话：先等 cancel 把 run 落为终态再关进程（直接 close 会残留 active run，拖垮下次 Resume） */
function releaseSession(s: SdkSessionAgent): Promise<void> {
  // 残留的 poll 连接无需专门收口：新回合的任意 poll 会顶掉它，claimed 消息下次 poll 重新可见
  s.abortController.abort()
  if (s.streamAgg?.timer) {
    clearTimeout(s.streamAgg.timer)
    s.streamAgg.timer = null
  }
  const { agent, run } = s
  sdkSessions.delete(s.sessionKey)
  if (!run) {
    try { agent.close() } catch { /* best-effort */ }
    return Promise.resolve()
  }
  const timeout = new Promise<void>((r) => setTimeout(r, 5000))
  return Promise.race([run.cancel().catch(() => {}), timeout]).then(() => {
    try { agent.close() } catch { /* best-effort */ }
  })
}

/** 停止会话进程（保留 resume 映射，下条消息仍可续上下文；清上下文用 resetSdkSessionContext） */
export async function stopSdkSession(sessionKey: string): Promise<void> {
  const s = findSdkSessionLoose(sessionKey)
  if (!s) return
  pushUiLog("SDK", "INFO", `[${s.sessionKey}] 会话已停止（队列有未回复消息时将自动重新拉起）`)
  await sealStreamCardForStop(s)
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
  const live = sdkSessions.get(sessionKey)
  if (live) void releaseSession(live)
  forgetResumable(sessionKey)
}

/**
 * 停止全部运行中的会话进程；保留 resume 映射（应用重启后上下文可恢复）。
 * 返回的 Promise 在所有 run 取消落库（或超时）后 resolve——退出前 await 可避免残留 active run。
 */
export function stopAllSdkSessions(): Promise<void> {
  const sessions = [...sdkSessions.values()]
  pendingLaunches.clear()
  const releases = sessions.map(async (s) => {
    await sealStreamCardForStop(s)
    await releaseSession(s)
  })
  broadcastSdkSessionStatus()
  return Promise.all(releases).then(() => {})
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
