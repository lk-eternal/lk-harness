import { BrowserWindow, app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"

const LOG_BUFFER_MAX = 300
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024
const logBuffer: string[] = []
let logFilePath: string | null = null
let logWriteCount = 0

// 统一日志目录：{userData}/logs/（app.log = Electron 主进程；daemon.log = Daemon 进程）
// 固定位置，不随工作目录切换而漂移
function getOrCreateLogFilePath(): string {
  if (logFilePath) return logFilePath
  const dir = path.join(app.getPath("userData"), "logs")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  logFilePath = path.join(dir, "app.log")
  rotateLogIfNeeded(logFilePath)
  return logFilePath
}

/** 日志文件超过上限时滚动保留一个 .old，避免无限追加占满磁盘 */
function rotateLogIfNeeded(p: string): void {
  try {
    if (fs.statSync(p).size <= LOG_FILE_MAX_BYTES) return
    const old = `${p}.old`
    try { fs.rmSync(old, { force: true }) } catch { /* ignore */ }
    fs.renameSync(p, old)
  } catch { /* ignore (文件不存在等) */ }
}

function appendToLogFile(line: string): void {
  try {
    const p = getOrCreateLogFilePath()
    if (++logWriteCount % 100 === 0) rotateLogIfNeeded(p)
    fs.appendFileSync(p, line + "\n", "utf-8")
  } catch { /* ignore */ }
}

function uiTimestamp(): string {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, "0")
  const p3 = (n: number) => String(n).padStart(3, "0")
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
}

/**
 * 单行化日志内容。换行用 ⏎ 标记（展示层还原），
 * 不能用字面量 \n —— 会与 Windows 路径（\node_modules、\release）冲突导致展示错乱。
 */
export function escapeLogContentSingleLine(s: string): string {
  return s.replace(/\r?\n/g, "⏎")
}

function formatUnifiedUiLog(processName: string, level: string, content: string): string {
  return `${uiTimestamp()} [${processName}] ${level} ${escapeLogContentSingleLine(content)}`
}

export function pushLog(line: string): void {
  logBuffer.push(line)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX)
  appendToLogFile(line)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("daemon:log", line)
  }
}

export function pushUiLog(processName: string, level: string, content: string): void {
  pushLog(formatUnifiedUiLog(processName, level, content))
}

export function broadcastLog(message: string, level: string = "INFO"): void {
  pushUiLog("Electron", level, message)
}

export function getLogBuffer(): string[] {
  return [...logBuffer]
}

export function clearLogBuffer(): void {
  logBuffer.length = 0
}

export function flushAgentStreamChunk(
  bufRef: { current: string },
  chunk: string,
  stream: "stdout" | "stderr",
): void {
  bufRef.current += chunk
  const parts = bufRef.current.split(/\r?\n/)
  bufRef.current = parts.pop() ?? ""
  const level = stream === "stderr" ? "WARN" : "INFO"
  for (const raw of parts) {
    const line = raw.trim()
    if (line) pushUiLog("Agent", level, line)
  }
}

export type SessionSource = "cli" | "sdk" | "llm"

type SessionEntry = { sessionKey: string; pid: number; startedAt: number; lastActivityAt: number; chatType: string; chatName?: string; workspaceDir?: string; source?: SessionSource; model?: string; modelParams?: string }

const sessionPartitions = new Map<SessionSource, SessionEntry[]>()

export function broadcastSessionStatus(sessionData: SessionEntry[], source?: SessionSource): void {
  sessionPartitions.set(source || "cli", sessionData)

  const merged: SessionEntry[] = []
  for (const [src, entries] of sessionPartitions) {
    for (const e of entries) merged.push({ ...e, source: src })
  }

  const taskStatuses: Record<string, { running: boolean; pid?: number; startedAt?: number }> = {}
  for (const s of merged) {
    if (s.chatType === "task") taskStatuses[s.sessionKey] = { running: true, pid: s.pid, startedAt: s.startedAt }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("agent:sessions", merged)
    win.webContents.send("scheduled-tasks:status", taskStatuses)
  }
}


export function logCursorAgentInvocation(logLabel: string, agentArgs: string[], cwd?: string): void {
  const cwdSuffix = cwd != null && cwd !== "" ? `${cwd} ` : ""
  pushUiLog("Agent", "INFO", `[CLI ${logLabel}] ${cwdSuffix}agent ${agentArgs.join(" ")}`)
}

const CLI_RESPONSE_LOG_MAX = 200

/** 在对应的 [CLI xxx] 发起日志之后，追加一行合并后的 stdout/stderr 摘要（过长截断） */
export function logCursorAgentResponse(logLabel: string, result: { ok: boolean; stdout: string; stderr: string; error?: string }): void {
  const parts: string[] = [`ok=${result.ok}`]
  if (result.error) parts.push(`⏎err=${escapeLogContentSingleLine(result.error)}`)
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  if (combined) {
    let body = combined
    if (body.length > CLI_RESPONSE_LOG_MAX) {
      body = `${body.slice(0, CLI_RESPONSE_LOG_MAX)} …(+${body.length - CLI_RESPONSE_LOG_MAX} chars)`
    }
    parts.push(`⏎${escapeLogContentSingleLine(body)}`)
  } else if (!result.error) {
    parts.push("(empty stdout/stderr)")
  }
  pushUiLog("Agent", result.ok ? "INFO" : "WARN", `[CLI ${logLabel} →] ${parts.join(" ")}`)
}
