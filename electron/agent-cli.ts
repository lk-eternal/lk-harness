import { spawn, spawnSync, execSync, exec, type ChildProcess } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { promisify } from "node:util"
import { getConfig } from "./config-store"
import { pushUiLog, broadcastLog, logCursorAgentInvocation, logCursorAgentResponse } from "./ui-logger"
import { createUtf8Decoder, decodeUtf8Chunk, finishUtf8Decoder } from "../src/shared/utf8-stream.js"

const execAsync = promisify(exec)

let agentNodePath = ""
let agentIndexPath = ""

export function getAgentPaths() {
  return { agentNodePath, agentIndexPath }
}

export function quoteArg(a: string): string {
  if (process.platform !== "win32") return a
  if (/[\s"&|<>^()!%]/.test(a) || /[^\x20-\x7E]/.test(a)) return `"${a.replace(/"/g, '\\"')}"`
  return a
}

// ── PATH 刷新（GUI 进程继承的 PATH 可能过旧，从系统/登录 shell 重新读取）──

function pathRefreshCommand(): string {
  if (os.platform() === "win32") {
    return 'powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"'
  }
  const shell = process.env.SHELL || "/bin/zsh"
  return `${shell} -ilc 'echo $PATH'`
}

function applyFreshPath(stdout: string): void {
  const freshPath = stdout.trim()
  if (freshPath) process.env.PATH = freshPath
}

function refreshPath(): void {
  try {
    applyFreshPath(execSync(pathRefreshCommand(), { encoding: "utf-8", timeout: 5000 }))
  } catch { /* ignore */ }
}

export async function refreshPathAsync(): Promise<void> {
  try {
    const { stdout } = await execAsync(pathRefreshCommand(), { timeout: 5000, maxBuffer: 2_000_000 })
    applyFreshPath(String(stdout ?? ""))
  } catch { /* ignore */ }
}

// ── CLI 发现 ─────────────────────────────────────────────

export function resolveAgentBinary(): boolean {
  const isWin = process.platform === "win32"
  if (isWin) {
    const base = path.join(process.env.LOCALAPPDATA ?? "", "cursor-agent")
    const versionsDir = path.join(base, "versions")
    if (!fs.existsSync(versionsDir)) return false
    const dirs = fs.readdirSync(versionsDir)
      .filter((d) => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(d))
      .sort()
      .reverse()
    if (dirs.length === 0) return false
    agentNodePath = path.join(versionsDir, dirs[0], "node.exe")
    agentIndexPath = path.join(versionsDir, dirs[0], "index.js")
    return fs.existsSync(agentNodePath) && fs.existsSync(agentIndexPath)
  }
  try {
    execSync("agent --version", { stdio: "ignore", timeout: 5000 })
    return true
  } catch { return false }
}

/** 确保 CLI 可用的统一守卫——消除"resolve → refresh → resolve"的重复模式 */
export async function ensureAgentBinary(): Promise<boolean> {
  if (resolveAgentBinary()) return true
  await refreshPathAsync()
  return resolveAgentBinary()
}

function ensureAgentBinarySync(): boolean {
  if (resolveAgentBinary()) return true
  refreshPath()
  return resolveAgentBinary()
}

// ── Proxy / Env 构建 ────────────────────────────────────

const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
] as const

export function applyProxyEnv(env: Record<string, string>, config: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): void {
  for (const key of PROXY_ENV_KEYS) delete env[key]
  if (config.httpProxy) {
    env.HTTP_PROXY = config.httpProxy
    env.http_proxy = config.httpProxy
  }
  if (config.httpsProxy) {
    env.HTTPS_PROXY = config.httpsProxy
    env.https_proxy = config.httpsProxy
    env.ALL_PROXY = config.httpsProxy
    env.all_proxy = config.httpsProxy
  }
  if (config.noProxy) {
    env.NO_PROXY = config.noProxy
    env.no_proxy = config.noProxy
  }
}

/**
 * 把代理同步到 Electron 主进程 process.env。
 * @cursor/sdk 在主进程内联跑 fetch，不会走 CLI spawn 的 env；不设的话 IDE 能通、Claw 却频繁 key-exchange fetch failed。
 */
export function syncMainProcessProxyEnv(config: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): void {
  const env = process.env as Record<string, string>
  applyProxyEnv(env, config)
  const hasProxy = !!(config.httpProxy?.trim() || config.httpsProxy?.trim())
  if (hasProxy) env.NODE_USE_ENV_PROXY = "1"
  else delete env.NODE_USE_ENV_PROXY
}

/**
 * 进程启动最早期注入代理环变量。
 * Node 读 `NODE_USE_ENV_PROXY` 是一次性的：发出首个请求后再改 process.env 不再生效，
 * 所以不能等到 initDaemonManager。读配置失败时静默跳过，不能阻断启动。
 */
export function bootstrapProxyEnv(): void {
  try {
    syncMainProcessProxyEnv(getConfig())
  } catch { /* 配置尚未就绪：后续 initDaemonManager 会再同步一次 */ }
}

export function createAgentEnv(extras?: Record<string, string>): Record<string, string> {
  const config = getConfig()
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CURSOR_INVOKED_AS: "agent",
    ...extras,
  }
  delete env.NODE_USE_ENV_PROXY
  applyProxyEnv(env, config)
  return env
}

// ── 统一 Spawn 封装 ─────────────────────────────────────

export type ExecAgentResult = { ok: boolean; stdout: string; stderr: string; error?: string }
export type ExecAgentOptions = { timeoutMs?: number; cwd?: string; logLabel?: string }

export function spawnAgentChild(args: string[], env: Record<string, string>, opts?: { cwd?: string; stdio?: any }): ChildProcess {
  if (agentNodePath && agentIndexPath) {
    return spawn(agentNodePath, [agentIndexPath, ...args], {
      windowsHide: true,
      env,
      cwd: opts?.cwd,
      stdio: opts?.stdio ?? ["ignore", "pipe", "pipe"],
    })
  }
  return spawn("agent", args.map(quoteArg), {
    shell: process.platform === "win32",
    windowsHide: true,
    env,
    cwd: opts?.cwd,
    stdio: opts?.stdio ?? ["ignore", "pipe", "pipe"],
  })
}

export function execAgentSync(
  agentArgs: string[],
  env: Record<string, string>,
  timeoutOrOpts: number | ExecAgentOptions = 30_000,
): ExecAgentResult {
  const opts: ExecAgentOptions =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts
  const timeoutMs = opts.timeoutMs ?? 30_000
  const cwd = opts.cwd

  if (!ensureAgentBinarySync()) {
    return { ok: false, stdout: "", stderr: "", error: "未找到 Cursor CLI（agent），请先安装并完成登录" }
  }

  logCursorAgentInvocation(opts.logLabel ?? "invoke-sync", agentArgs, cwd)
  const mergedEnv = { ...process.env as Record<string, string>, ...env }
  if (agentNodePath && agentIndexPath) {
    const r = spawnSync(agentNodePath, [agentIndexPath, ...agentArgs], {
      encoding: "utf-8", timeout: timeoutMs, env: mergedEnv, windowsHide: true, cwd,
    })
    const result = processSpawnSyncResult(r)
    logCursorAgentResponse(opts.logLabel ?? "invoke-sync", result)
    return result
  }
  const r = spawnSync("agent", agentArgs.map(quoteArg), {
    encoding: "utf-8", timeout: timeoutMs, env: mergedEnv,
    shell: process.platform === "win32", windowsHide: true, cwd,
  })
  const result = processSpawnSyncResult(r)
  logCursorAgentResponse(opts.logLabel ?? "invoke-sync", result)
  return result
}

export async function execAgentAsync(
  agentArgs: string[],
  env: Record<string, string>,
  timeoutOrOpts: number | ExecAgentOptions = 30_000,
): Promise<ExecAgentResult> {
  const opts: ExecAgentOptions =
    typeof timeoutOrOpts === "number" ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts
  const timeoutMs = opts.timeoutMs ?? 30_000
  const cwd = opts.cwd

  if (!(await ensureAgentBinary())) {
    return { ok: false, stdout: "", stderr: "", error: "未找到 Cursor CLI（agent），请先安装并完成登录" }
  }

  logCursorAgentInvocation(opts.logLabel ?? "invoke-async", agentArgs, cwd)
  const mergedEnv = { ...process.env as Record<string, string>, ...env }

  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (r: ExecAgentResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      logCursorAgentResponse(opts.logLabel ?? "invoke-async", r)
      resolve(r)
    }

    const child = spawnAgentChild(agentArgs, mergedEnv, { cwd })

    let stdout = ""
    let stderr = ""
    timer = setTimeout(() => {
      try { child.kill("SIGTERM") } catch { /* ignore */ }
      finish({ ok: false, stdout, stderr, error: "命令超时" })
    }, timeoutMs)

    const outDec = createUtf8Decoder()
    const errDec = createUtf8Decoder()
    child.stdout?.on("data", (d: Buffer) => { stdout += decodeUtf8Chunk(outDec, d) })
    child.stderr?.on("data", (d: Buffer) => { stderr += decodeUtf8Chunk(errDec, d) })
    child.on("error", (e) => finish({ ok: false, stdout, stderr, error: e.message }))
    child.on("close", (code) => {
      stdout += finishUtf8Decoder(outDec)
      stderr += finishUtf8Decoder(errDec)
      if (code === 0) { finish({ ok: true, stdout, stderr }); return }
      const hint = (stderr || stdout).trim().slice(0, 500) || `进程退出码 ${code}`
      finish({ ok: false, stdout, stderr, error: hint })
    })
  })
}

function processSpawnSyncResult(r: { stdout: string | Buffer | null; stderr: string | Buffer | null; status: number | null; error?: Error }): ExecAgentResult {
  const stdout = r.stdout == null ? "" : String(r.stdout)
  const stderr = r.stderr == null ? "" : String(r.stderr)
  if (r.error) return { ok: false, stdout, stderr, error: r.error.message }
  if (r.status !== 0) {
    const hint = (stderr || stdout).trim().slice(0, 500) || `进程退出码 ${r.status}`
    return { ok: false, stdout, stderr, error: hint }
  }
  return { ok: true, stdout, stderr }
}

// ── CLI 安装 / 登录 / 检查 ──────────────────────────────

export async function checkCliInstalled(): Promise<boolean> {
  if (await ensureAgentBinary()) return true
  return new Promise((resolve) => {
    let settled = false
    const child = spawn("agent", ["--version"], {
      stdio: "ignore", shell: process.platform === "win32", windowsHide: true,
    })
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolve(false)
    }, 5000)
    child.on("error", () => { if (settled) return; settled = true; clearTimeout(t); resolve(false) })
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(t); resolve(code === 0) })
  })
}

export async function installCli(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWin = os.platform() === "win32"
    let child: ChildProcess
    if (isWin) {
      child = spawn("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "irm 'https://cursor.com/install?win32=true' | iex",
      ], { stdio: ["ignore", "pipe", "pipe"] })
    } else {
      child = spawn("bash", ["-c", "curl https://cursor.com/install -fsS | bash"], { stdio: ["ignore", "pipe", "pipe"] })
    }

    let output = ""
    const outDec = createUtf8Decoder()
    const errDec = createUtf8Decoder()
    child.stdout?.on("data", (d: Buffer) => { output += decodeUtf8Chunk(outDec, d) })
    child.stderr?.on("data", (d: Buffer) => { output += decodeUtf8Chunk(errDec, d) })
    child.on("exit", (code) => {
      output += finishUtf8Decoder(outDec) + finishUtf8Decoder(errDec)
      if (code === 0) {
        void (async () => {
          const installed = await ensureAgentBinary() || (await checkCliInstalled())
          resolve({
            ok: installed,
            output: installed
              ? "CLI 安装成功！请点击「登录授权」完成 Cursor 账号认证。"
              : output || "安装脚本执行完毕，但 agent 命令仍不可用。请重新打开终端后重试。",
          })
        })()
      } else {
        resolve({ ok: false, output: output || `安装失败 (exit code: ${code})` })
      }
    })
    child.on("error", (e) => resolve({ ok: false, output: `安装进程错误: ${e.message}` }))
  })
}
