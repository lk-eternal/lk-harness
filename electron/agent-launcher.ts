import { type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import { getConfig, getMainChatIdForScope, setMainChatIdForScope, primaryWorkspaceForCli } from "./config-store"
import { chatIdFromSessionKey } from "../src/shared/channel-types"
import {
  resolveAgentBinary, applyProxyEnv, createAgentEnv,
  spawnAgentChild, execAgentSync, execAgentAsync, ensureAgentBinary,
  checkCliInstalled,
} from "./agent-cli"
import {
  broadcastLog, pushUiLog, flushAgentStreamChunk, logCursorAgentInvocation, logCursorAgentResponse,
  broadcastSessionStatus as broadcastSessionStatusToUi,
} from "./ui-logger"
import { assembleColdStartPrompt } from "./prompt-assembler"
import { notifySessionLaunched } from "./daemon-client"

// ── 会话 Agent ──────────────────────────────────────────

export type ChatType = "p2p" | "group" | "task" | "temp" | "project"

interface SessionAgent {
  sessionKey: string
  child: ChildProcess
  pid: number
  startedAt: number
  lastActivityAt: number
  lastOutputAt: number
  chatType: ChatType
  workspaceDir?: string
  senderOpenId?: string
  chatName?: string
  model?: string
}

const sessionAgents = new Map<string, SessionAgent>()
const pendingLaunches = new Set<string>()

/** 进程输出捕获上限：长会话只保留尾部，避免 stdout/stderr 无限累积撑爆内存 */
const MAX_CAPTURE_BYTES = 64 * 1024
function appendCapped(buf: string, chunk: string): string {
  const s = buf + chunk
  return s.length > MAX_CAPTURE_BYTES ? s.slice(s.length - MAX_CAPTURE_BYTES) : s
}

let chatNameResolver: ((chatId: string) => string | undefined) | null = null
let chatNameFallback: ((chatId: string) => string | undefined) | null = null
let sessionCloseHandler: ((sessionKey: string, chatType: ChatType, exitInfo?: SessionExitInfo) => void | Promise<void>) | null = null

export interface SessionExitInfo {
  exitCode: number | null
  elapsed: number
  stderr: string
  stdout: string
}

export function setChatNameResolver(fn: (chatId: string) => string | undefined): void {
  chatNameResolver = fn
}

/** 名字解析不到时的兜底展示（如「通道名·访客」），避免 UI 直接裸展示 sessionKey */
export function setChatNameFallback(fn: (chatId: string) => string | undefined): void {
  chatNameFallback = fn
}

export function setSessionCloseHandler(fn: (sessionKey: string, chatType: ChatType, exitInfo?: SessionExitInfo) => void | Promise<void>): void {
  sessionCloseHandler = fn
}

/** 广播时实时解析会话名：优先用会话自带名，否则按 chatId / senderOpenId 查缓存（群名异步解析后自愈），最后走兜底名 */
export function resolveSessionChatName(sessionKey: string, chatName?: string, senderOpenId?: string): string | undefined {
  if (chatName) return chatName
  const chatId = chatIdFromSessionKey(sessionKey)
  return chatNameResolver?.(chatId)
    || (senderOpenId ? chatNameResolver?.(senderOpenId) : undefined)
    || chatNameFallback?.(chatId)
}

function broadcastSessionStatus(): void {
  const list = [...sessionAgents.values()].map((s) => ({
    sessionKey: s.sessionKey, pid: s.pid, startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt, chatType: s.chatType as string,
    chatName: resolveSessionChatName(s.sessionKey, s.chatName, s.senderOpenId),
    workspaceDir: s.workspaceDir,
    model: s.model,
  }))
  broadcastSessionStatusToUi(list, "cli")
}

// ── 状态查询 ──────────────────────────────────────────

export function isAgentRunning(): boolean {
  return getRunningSessionCount() > 0
}

export function isSessionAgentRunning(sessionKey: string): boolean {
  if (pendingLaunches.has(sessionKey)) return true
  const sa = sessionAgents.get(sessionKey)
  return sa !== null && sa !== undefined && !sa.child.killed && sa.child.exitCode === null
}

export function getRunningSessionCount(): number {
  let count = 0
  for (const sa of sessionAgents.values()) {
    if (!sa.child.killed && sa.child.exitCode === null) count++
  }
  return count
}

export function getSessionAgentList() {
  return [...sessionAgents.values()].map((s) => ({
    sessionKey: s.sessionKey, pid: s.pid, startedAt: s.startedAt,
    chatType: s.chatType, lastActivityAt: s.lastActivityAt,
    workspaceDir: s.workspaceDir, senderOpenId: s.senderOpenId,
    chatName: s.chatName, model: s.model,
  }))
}

export function getAgentChildPid(): number | null {
  const first = sessionAgents.values().next()
  return first.done ? null : first.value.pid
}

export function getSessionAgentCount(): number {
  return sessionAgents.size
}

export function getSessionAgentLastOutputAt(sessionKey: string): number | null {
  return sessionAgents.get(sessionKey)?.lastOutputAt ?? null
}

export function getSessionAgentStartedAt(sessionKey: string): number | null {
  return sessionAgents.get(sessionKey)?.startedAt ?? null
}

export function getIndependentTaskStatuses(): Record<string, { running: boolean; pid?: number; startedAt?: number }> {
  const statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }> = {}
  for (const [key, agent] of sessionAgents) {
    if (agent.chatType === "task" || agent.chatType === "temp") {
      statuses[key] = { running: true, pid: agent.pid, startedAt: agent.startedAt }
    }
  }
  return statuses
}

// ── Prompt 构建 ──────────────────────────────────────────

export interface LaunchMeta { messageIds?: string[]; chatId?: string; chatType?: string }

export function buildPrompt(
  meta?: LaunchMeta,
  taskMessage?: string,
  sessionKey?: string,
  useMainWorkspace?: boolean,
  notifySessionKey?: string,
  digitalIdentityOverride?: string,
): string {
  return assembleColdStartPrompt({
    meta,
    taskMessage,
    sessionKey,
    useMainWorkspace,
    notifySessionKey,
    digitalIdentityOverride,
  }, undefined)
}

// ── 进程管理工具 ─────────────────────────────────────────

function buildAgentLaunchArgs(workspaceDir: string, prompt: string, resumeChatId: string | false, model?: string): string[] {
  const args = [
    "--print", "--force",
    ...(resumeChatId ? ["--resume", resumeChatId] : []),
    "--approve-mcps", "--workspace", workspaceDir, "--trust",
  ]
  const m = model?.trim()
  if (m && m !== "auto") args.push("--model", m)
  args.push(prompt)
  return args
}

function createChatId(workspaceDir: string, scope: string, spawnEnv: Record<string, string>): string | null {
  const ws = workspaceDir?.trim() || undefined
  const r = execAgentSync(
    ["create-chat", "--workspace", workspaceDir],
    spawnEnv,
    { timeoutMs: 15_000, cwd: ws, logLabel: "create-chat" },
  )
  if (!r.ok) {
    broadcastLog(`[Agent] create-chat 失败: ${r.error}`, "ERROR")
    return null
  }
  const chatId = r.stdout.trim().split(/\s+/).pop()?.trim()
  if (!chatId) {
    broadcastLog(`[Agent] create-chat 返回为空`, "ERROR")
    return null
  }
  setMainChatIdForScope(scope, chatId)
  broadcastLog(`[Agent] 创建主会话: ${chatId} (scope=${scope})`)
  return chatId
}

function ensureMainChatId(workspaceDir: string, scope: string, spawnEnv: Record<string, string>): string | null {
  return getMainChatIdForScope(scope) || createChatId(workspaceDir, scope, spawnEnv)
}

function spawnAgentWithLogs(args: string[], env: Record<string, string>, label: string, cwd?: string): ChildProcess {
  logCursorAgentInvocation(label, args, cwd)
  return spawnAgentChild(args, env, { cwd })
}

/** 挂接 stdout/stderr：按行推 UI 日志；onData 供调用方同步捕获原始输出（单次 decode，避免重复监听器） */
function attachStreamLoggers(child: ChildProcess, onData?: (stream: "stdout" | "stderr", text: string) => void): void {
  const outBuf = { current: "" }
  const errBuf = { current: "" }
  child.stdout?.on("data", (d: Buffer) => {
    const s = d.toString()
    onData?.("stdout", s)
    flushAgentStreamChunk(outBuf, s, "stdout")
  })
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString()
    onData?.("stderr", s)
    flushAgentStreamChunk(errBuf, s, "stderr")
  })
  child.on("close", () => {
    if (outBuf.current.trim()) { pushUiLog("Agent", "INFO", outBuf.current.trim()); outBuf.current = "" }
    if (errBuf.current.trim()) { pushUiLog("Agent", "WARN", errBuf.current.trim()); errBuf.current = "" }
  })
}

// ── 公开 API ────────────────────────────────────────

export interface LaunchAgentOptions {
  sessionKey: string
  chatType: ChatType
  meta?: LaunchMeta
  useMainWorkspace?: boolean
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  /** 调用方解析好的工作目录（必填，由 session-dispatcher 按通道计算） */
  workspaceDir: string
  /** 调用方解析好的模型（空 / auto = CLI 默认） */
  model?: string
  /** 主会话 resume 作用域（`channelId:workspaceDir`）；仅主用户会话传入 */
  resumeScope?: string
  /** 每次新建会话（不 resume），仅在 resumeScope 存在时有意义 */
  newSession?: boolean
  /** 长连接保活（无限 poll）；false = 回答完即结束回合 */
  persistentPoll?: boolean
  /** 定时任务 outbound 投递目标（notify_session_key） */
  notifySessionKey?: string
  /** 通道级数字身份（非主工作区群聊） */
  digitalIdentityOverride?: string
}

export async function launchAgent(opts: LaunchAgentOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, chatType, meta, senderOpenId, chatName, taskMessage } = opts
  const needResume = (chatType === "p2p" || chatType === "group") && !!opts.resumeScope
  const useMainWorkspace = opts.useMainWorkspace ?? false

  if (isSessionAgentRunning(sessionKey)) {
    const sa = sessionAgents.get(sessionKey)
    if (sa) sa.lastActivityAt = Date.now()
    return { ok: true }
  }

  pendingLaunches.add(sessionKey)

  const workDir = opts.workspaceDir

  if (!workDir) { pendingLaunches.delete(sessionKey); return { ok: false, error: "工作目录未配置" } }
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })
  if (!resolveAgentBinary()) { pendingLaunches.delete(sessionKey); return { ok: false, error: "Cursor CLI 未安装" } }

  const prompt = buildPrompt(meta, taskMessage, sessionKey, useMainWorkspace, opts.notifySessionKey, opts.digitalIdentityOverride)
  const spawnEnv = createAgentEnv({ LARK_WORKSPACE_DIR: workDir })

  let resumeChatId: string | false = false
  if (needResume && opts.resumeScope) {
    if (opts.newSession) {
      if (getMainChatIdForScope(opts.resumeScope)) setMainChatIdForScope(opts.resumeScope, "")
    } else {
      const cid = ensureMainChatId(workDir, opts.resumeScope, spawnEnv)
      if (cid) resumeChatId = cid
    }
  }

  const args = buildAgentLaunchArgs(workDir, prompt, resumeChatId, opts.model)

  try {
    const ws = workDir.trim() || undefined
    pushUiLog("CLI", "INFO", `[${sessionKey}] 启动 CLI Agent (model=${opts.model?.trim() || "auto"}, cwd=${workDir})`)
    const child = spawnAgentWithLogs(args, spawnEnv, `session-${sessionKey}`, ws)

    const now = Date.now()
    const sa: SessionAgent = {
      sessionKey, child, pid: child.pid!, startedAt: now, lastActivityAt: now, lastOutputAt: now,
      chatType, workspaceDir: workDir, senderOpenId, chatName,
      model: opts.model?.trim() && opts.model.trim() !== "auto" ? opts.model.trim() : undefined,
    }
    sessionAgents.set(sessionKey, sa)

    let stderrChunks = ""
    let stdoutChunks = ""
    attachStreamLoggers(child, (stream, s) => {
      if (stream === "stderr") stderrChunks = appendCapped(stderrChunks, s)
      else stdoutChunks = appendCapped(stdoutChunks, s)
      sa.lastOutputAt = Date.now()
    })

    child.on("close", (code, signal) => {
      const isCurrent = sessionAgents.get(sessionKey) === sa
      const elapsed = Date.now() - sa.startedAt
      pushUiLog("Agent", "INFO", `[${sessionKey}] 退出 code=${code}${signal ? ` signal=${signal}` : ""} (${elapsed}ms)`)
      if (isCurrent) sessionAgents.delete(sessionKey)
      broadcastSessionStatus()

      if (code !== 0 && stderrChunks.includes("[unavailable]")) {
        pushUiLog("Agent", "ERROR",
          `[${sessionKey}] gRPC [unavailable] 错误，可能原因: ` +
          "Cursor 未登录 / 网络不通 / 代理配置问题 / macOS 安全限制",
        )
      }

      if (isCurrent && sessionCloseHandler) sessionCloseHandler(sessionKey, chatType, { exitCode: code, elapsed, stderr: stderrChunks, stdout: stdoutChunks })
    })
    child.on("error", (e) => {
      pushUiLog("Agent", "ERROR", `[${sessionKey}] 进程错误: ${e.message}`)
      if (sessionAgents.get(sessionKey) === sa) sessionAgents.delete(sessionKey)
      broadcastSessionStatus()
    })

    pendingLaunches.delete(sessionKey)
    broadcastLog(`[Agent] 会话 ${sessionKey} (${chatType}) 已启动, pid=${child.pid}`)
    broadcastSessionStatus()
    await notifySessionLaunched(sessionKey, { resumed: resumeChatId !== false, runtime: "cli" })
    return { ok: true }
  } catch (e: unknown) {
    pendingLaunches.delete(sessionKey)
    const msg = e instanceof Error ? e.message : String(e)
    broadcastLog(`[Agent] 启动失败 ${sessionKey}: ${msg}`, "ERROR")
    return { ok: false, error: msg }
  }
}

export function stopAgent(): void {
  stopAllSessionAgents()
}

export function stopSessionAgent(sessionKey: string): void {
  const sa = sessionAgents.get(sessionKey)
  if (sa && !sa.child.killed) {
    // 残留 poll 连接由下一次 poll 顶掉；claimed 消息下次 poll 重新可见
    try { sa.child.kill("SIGTERM") } catch { /* ignore */ }
  }
  sessionAgents.delete(sessionKey)
  broadcastSessionStatus()
}

export function stopAllSessionAgents(): void {
  for (const [key] of sessionAgents) stopSessionAgent(key)
}


// ── CLI 登录 ────────────────────────────────────────

type AgentLoginStatus = { cliFound: boolean; loggedIn: boolean; identityLine?: string; error?: string }

let agentLoggedInCheckInFlight: Promise<AgentLoginStatus> | null = null
let agentLoginStatusCache: AgentLoginStatus | null = null

/** 登录流程等需要刷新时清空，避免沿用旧的 whoami 结果 */
export function invalidateAgentLoggedInCache(): void {
  agentLoginStatusCache = null
}

async function checkAgentLoggedInImpl(): Promise<AgentLoginStatus> {
  if (!(await ensureAgentBinary())) {
    return { cliFound: false, loggedIn: false, error: "未找到 Cursor CLI（agent）" }
  }
  const config = getConfig()
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
  applyProxyEnv(env, config)
  const workspaceCwd = primaryWorkspaceForCli()
  const r = await execAgentAsync(["whoami"], env, { timeoutMs: 15_000, cwd: workspaceCwd, logLabel: "whoami" })
  const out = r.stdout.trim()
  const err = r.stderr.trim()
  if (r.ok) {
    const loggedIn = /logged\s+in/i.test(out) || /✓\s*Logged/i.test(out)
    const firstLine = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0)
    return {
      cliFound: true, loggedIn, identityLine: firstLine,
      error: loggedIn ? undefined : (out || err || "未识别登录状态").slice(0, 400),
    }
  }
  return { cliFound: true, loggedIn: false, error: (out || err || r.error || "").trim().slice(0, 500) }
}

/** 合并并发请求 + 本机单用户级进程内缓存（直至 invalidate），避免重复 `agent whoami` */
export function checkAgentLoggedIn(options?: { forceRefresh?: boolean }): Promise<AgentLoginStatus> {
  const force = options?.forceRefresh === true
  if (!force && agentLoginStatusCache) {
    return Promise.resolve({ ...agentLoginStatusCache })
  }
  if (agentLoggedInCheckInFlight) {
    return agentLoggedInCheckInFlight
  }
  agentLoggedInCheckInFlight = checkAgentLoggedInImpl()
    .then((result) => {
      agentLoginStatusCache = result
      return result
    })
    .finally(() => {
      agentLoggedInCheckInFlight = null
    })
  return agentLoggedInCheckInFlight
}

export async function loginCli(): Promise<{ ok: boolean; output: string }> {
  if (!(await ensureAgentBinary()) && !(await checkCliInstalled())) {
    return { ok: false, output: "Cursor CLI 未安装，请先安装" }
  }

  const spawnEnv = createAgentEnv()
  broadcastLog("[CLI Login] 正在打开浏览器进行 Cursor 账号授权...")
  logCursorAgentInvocation("cli-login", ["login"], undefined)

  return new Promise((resolve) => {
    let output = ""
    let settled = false

    try {
      const child = spawnAgentChild(["login"], spawnEnv)

      child.stdout?.on("data", (d: Buffer) => {
        const s = d.toString().trim(); output += s + "\n"
        if (s) broadcastLog(`[CLI Login] ${s}`, "INFO")
      })
      child.stderr?.on("data", (d: Buffer) => {
        const s = d.toString().trim(); output += s + "\n"
        if (s) broadcastLog(`[CLI Login:err] ${s}`, "ERROR")
      })
      child.on("exit", async (code) => {
        if (settled) return; settled = true
        logCursorAgentResponse("cli-login", {
          ok: code === 0,
          stdout: output,
          stderr: "",
          error: code !== 0 ? `exit ${code}` : undefined,
        })
        if (code !== 0) { resolve({ ok: false, output: output || `登录失败 (exit code: ${code})` }); return }
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          invalidateAgentLoggedInCache()
          const st = await checkAgentLoggedIn()
          if (st.loggedIn) { resolve({ ok: true, output: "Cursor CLI 登录授权成功！" }); return }
        }
        resolve({ ok: true, output: "登录流程已完成，但 whoami 未确认登录态，请刷新重试" })
      })
      child.on("error", (e) => {
        if (settled) return
        settled = true
        logCursorAgentResponse("cli-login", { ok: false, stdout: output, stderr: "", error: `进程错误: ${e.message}` })
        resolve({ ok: false, output: `登录进程错误: ${e.message}` })
      })
      setTimeout(() => {
        if (!settled) { settled = true; if (!child.killed) try { child.kill() } catch { /* ignore */ }; resolve({ ok: false, output: "登录超时（2分钟），请重试" }) }
      }, 120_000)
    } catch (e: unknown) {
      resolve({ ok: false, output: `启动登录失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}
