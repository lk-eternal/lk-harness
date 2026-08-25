import { spawn } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { BrowserWindow } from "electron"
import { getConfig, primaryWorkspaceForCli } from "./config-store"
import { broadcastLog, logCursorAgentInvocation, logCursorAgentResponse } from "./ui-logger"
import { resolveAgentBinary, applyProxyEnv, quoteArg, getAgentPaths } from "./agent-cli"

// ── Types ────────────────────────────────────────────────

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "global" | "project"
  authenticated?: boolean
  rawConfig?: Record<string, unknown>
  enabled?: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
  params?: { name: string; type?: string; description?: string; required?: boolean }[]
}

// ── Internal helpers ─────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function isEnabledStatus(status: string): boolean {
  return status.toLowerCase() !== "disabled"
}

function spawnAsync(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const mcpLabel = args.length >= 2 && args[0] === "mcp" ? `mcp-${args[1]}` : `mcp-${args[0] ?? "spawn"}`
    logCursorAgentInvocation(mcpLabel, args, cwd)
    let stdout = "", stderr = "", settled = false, didTimeout = false
    let spawnErr: string | undefined
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const ok = code === 0 && !didTimeout && !spawnErr
      logCursorAgentResponse(mcpLabel, {
        ok,
        stdout,
        stderr,
        error: didTimeout ? "timeout (30s)" : spawnErr,
      })
      resolve({ code, stdout, stderr, timedOut: didTimeout || undefined })
    }
    const { agentNodePath: np, agentIndexPath: ip } = getAgentPaths()
    const child = np && ip
      ? spawn(np, [ip, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env })
      : spawn("agent", args.map(quoteArg), { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd, env })
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", (e) => {
      spawnErr = e instanceof Error ? e.message : String(e)
      done(1)
    })
    child.on("exit", (code) => done(code ?? 1))
    const timer = setTimeout(() => { didTimeout = true; try { child.kill() } catch { /* */ }; done(1) }, 30_000)
  })
}

// ── OAuth & Project helpers ──────────────────────────────

function findProjectDir(workspaceDir: string): string | null {
  const projectsBase = path.join(os.homedir(), ".cursor", "projects")
  if (!fs.existsSync(projectsBase)) return null

  const expected = workspaceDir.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "")
  const exactPath = path.join(projectsBase, expected)
  if (fs.existsSync(exactPath)) return exactPath

  try {
    const lower = expected.toLowerCase()
    const match = fs.readdirSync(projectsBase).find((d) => d.toLowerCase() === lower)
    if (match) return path.join(projectsBase, match)
  } catch { /* ignore */ }
  return null
}

function readApprovedServers(workspaceDir: string): Set<string> {
  const dir = findProjectDir(workspaceDir)
  if (!dir) return new Set()
  const approvalPath = path.join(dir, "mcp-approvals.json")
  try {
    if (!fs.existsSync(approvalPath)) return new Set()
    const entries: string[] = JSON.parse(fs.readFileSync(approvalPath, "utf-8"))
    const approved = new Set<string>()
    for (const entry of entries) {
      const match = entry.match(/^(.+)-[0-9a-f]{16}$/)
      if (match) approved.add(match[1])
    }
    return approved
  } catch { /* ignore */ }
  return new Set()
}


// ── MCP Enabled Cache ────────────────────────────────────

interface McpListCache { enabled: Record<string, boolean>; status: Record<string, string>; ts: number; ws: string }
let mcpListCache: McpListCache | null = null
let mcpListInflight: Promise<McpListCache> | null = null

interface McpToolsCacheEntry { tools: McpToolInfo[]; error?: string }
const mcpToolsCache = new Map<string, McpToolsCacheEntry>()

async function fetchMcpList(force = false): Promise<McpListCache> {
  const ws = primaryWorkspaceForCli()
  const empty: McpListCache = { enabled: {}, status: {}, ts: 0, ws }
  if (!force && mcpListCache && mcpListCache.ws === ws) return mcpListCache

  if (!resolveAgentBinary()) {
    const fromJson = fetchMcpListFromJson(ws)
    mcpListCache = fromJson
    return fromJson
  }
  if (mcpListInflight) return mcpListInflight

  const p = (async (): Promise<McpListCache> => {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(env, getConfig())
    try {
      const r = await spawnAsync(["mcp", "list"], ws, env)
      const clean = r.stdout.replace(ANSI_RE, "").replace(/\r/g, "")
      const enabled: Record<string, boolean> = {}
      const status: Record<string, string> = {}
      for (const line of clean.split("\n")) {
        const m = line.match(/^(.+?):\s+(.+)$/)
        if (m) {
          const name = m[1].trim(), raw = m[2].trim()
          enabled[name] = isEnabledStatus(raw)
          status[name] = raw.toLowerCase()
        }
      }
      const result: McpListCache = { enabled, status, ts: Date.now(), ws }
      mcpListCache = result
      return result
    } catch {
      return empty
    } finally {
      mcpListInflight = null
    }
  })()
  mcpListInflight = p
  return p
}

// ── Public API: Cache ────────────────────────────────────

export async function getMcpEnabledMap(force = false): Promise<Record<string, boolean>> {
  return (await fetchMcpList(force)).enabled
}

export async function getMcpStatusMap(force = false): Promise<Record<string, string>> {
  return (await fetchMcpList(force)).status
}

export function invalidateMcpEnabledCache(): void {
  mcpListCache = null
  mcpToolsCache.clear()
}

/** 应用启动时后台预热 MCP 列表缓存，避免首次进入设置页等待 CLI */
export function warmupMcpCache(): void {
  void fetchMcpList(false).catch(() => { /* ignore */ })
}

function toggleMcpServerInJson(serverName: string, enabled: boolean): { ok: boolean; output: string } {
  const server = getMcpServerList().find((s) => s.name === serverName)
  if (!server) return { ok: false, output: `${serverName} 不存在` }

  const existing = readMcpJson(server.source)
  if (!existing) return { ok: false, output: "配置文件不存在" }

  const servers = (existing.mcpServers ?? existing.servers ?? {}) as Record<string, Record<string, unknown>>
  const entry = servers[serverName]
  if (!entry) return { ok: false, output: `${serverName} 不存在` }

  if (enabled) delete entry.disabled
  else entry.disabled = true

  servers[serverName] = entry
  existing.mcpServers = servers
  if (existing.servers) delete existing.servers

  const success = writeMcpJson(server.source, existing)
  if (success) invalidateMcpEnabledCache()
  return success
    ? { ok: true, output: `${serverName} ${enabled ? "enabled" : "disabled"}` }
    : { ok: false, output: "写入失败" }
}

function fetchMcpListFromJson(ws: string): McpListCache {
  const enabled: Record<string, boolean> = {}
  const status: Record<string, string> = {}
  for (const s of getMcpServerList()) {
    const on = s.enabled !== false
    enabled[s.name] = on
    status[s.name] = on ? "ready" : "disabled"
  }
  return { enabled, status, ts: Date.now(), ws }
}

export async function toggleMcpServer(serverName: string, enabled: boolean, workspaceDirOverride?: string): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  const ws = (workspaceDirOverride ?? primaryWorkspaceForCli()).trim()
  if (!ws) return { ok: false, output: "工作目录未配置" }

  const jsonResult = toggleMcpServerInJson(serverName, enabled)
  if (!jsonResult.ok) return jsonResult

  if (resolveAgentBinary()) {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    applyProxyEnv(env, getConfig())
    const action = enabled ? "enable" : "disable"
    await spawnAsync(["mcp", action, serverName], ws, env)
  }
  return jsonResult
}

// ── Public API: CRUD ─────────────────────────────────────

export function getMcpServerList(): McpServerEntry[] {
  const ws = primaryWorkspaceForCli()
  const approved = readApprovedServers(ws)
  const result: McpServerEntry[] = []

  const globalPath = path.join(os.homedir(), ".cursor", "mcp.json")
  try {
    if (fs.existsSync(globalPath)) {
      const cfg = JSON.parse(fs.readFileSync(globalPath, "utf-8"))
      const servers = cfg.mcpServers ?? cfg.servers ?? {}
      for (const [name, raw] of Object.entries(servers) as [string, Record<string, unknown>][]) {
        result.push(buildEntry(name, raw, "global", approved))
      }
    }
  } catch { /* ignore */ }

  return result
}

function buildEntry(name: string, raw: Record<string, unknown>, source: "global" | "project", approved: Set<string>): McpServerEntry {
  const type: "command" | "url" = raw.url ? "url" : "command"
  return {
    name,
    type,
    command: raw.command as string | undefined,
    args: raw.args as string[] | undefined,
    url: raw.url as string | undefined,
    env: raw.env as Record<string, string> | undefined,
    source,
    authenticated: approved.has(name),
    rawConfig: raw,
    enabled: raw.disabled !== true,
  }
}

export function getMcpJsonPath(scope: "global" | "project"): string | null {
  if (scope === "project") return null
  return path.join(os.homedir(), ".cursor", "mcp.json")
}

export function readMcpJson(scope: "global" | "project"): Record<string, unknown> | null {
  const p = getMcpJsonPath(scope)
  if (!p) return null
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"))
  } catch { /* ignore */ }
  return null
}

export function writeMcpJson(scope: "global" | "project", data: Record<string, unknown>): boolean {
  const p = getMcpJsonPath(scope)
  if (!p) return false
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8")
    return true
  } catch { return false }
}

export function saveMcpServer(name: string, config: Record<string, unknown>, scope: "global" | "project"): { ok: boolean; error?: string } {
  const existing = readMcpJson(scope) ?? { mcpServers: {} }
  const servers = (existing.mcpServers ?? existing.servers ?? {}) as Record<string, unknown>
  servers[name] = config
  existing.mcpServers = servers
  if (existing.servers) delete existing.servers
  const success = writeMcpJson(scope, existing)
  if (success) invalidateMcpEnabledCache()
  return success ? { ok: true } : { ok: false, error: "写入失败" }
}

export function deleteMcpServer(name: string, scope: "global" | "project"): { ok: boolean; error?: string } {
  const existing = readMcpJson(scope)
  if (!existing) return { ok: false, error: "配置文件不存在" }
  const servers = (existing.mcpServers ?? existing.servers ?? {}) as Record<string, unknown>
  if (!(name in servers)) return { ok: false, error: `${name} 不存在` }
  delete servers[name]
  existing.mcpServers = servers
  if (existing.servers) delete existing.servers
  const success = writeMcpJson(scope, existing)
  if (success) invalidateMcpEnabledCache()
  return success ? { ok: true } : { ok: false, error: "写入失败" }
}

// ── Public API: OAuth login ──────────────────────────────

export async function loginMcpServer(serverName: string): Promise<{ ok: boolean; output: string }> {
  const config = getConfig()
  const cwd = primaryWorkspaceForCli()
  if (!cwd) return { ok: false, output: "工作目录未配置" }
  if (!resolveAgentBinary()) return { ok: false, output: "Cursor CLI 未安装" }

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, getConfig())

  logCursorAgentInvocation("mcp-login", ["mcp", "login", serverName], cwd)

  try {
    const child = spawn("agent", ["mcp", "login", serverName].map(quoteArg), {
      shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      cwd, env,
    })

    let stdout = "", stderr = ""
    let loginTimedOut = false
    let spawnErr: string | undefined
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      const urlMatch = chunk.match(/https?:\/\/[^\s]+/)
      if (urlMatch) {
        const { shell } = require("electron")
        shell.openExternal(urlMatch[0])
      }
    })

    const code = await new Promise<number>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (c: number) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        const ok = c === 0 && !loginTimedOut && !spawnErr
        logCursorAgentResponse("mcp-login", {
          ok,
          stdout,
          stderr,
          error: loginTimedOut ? "timeout (60s)" : spawnErr,
        })
        resolve(c)
      }
      timer = setTimeout(() => {
        loginTimedOut = true
        try { child.kill() } catch { /* */ }
        finish(1)
      }, 60_000)
      child.on("exit", (c) => finish(c ?? 1))
      child.on("error", (err) => {
        spawnErr = err instanceof Error ? err.message : String(err)
        finish(1)
      })
    })

    const out = (stdout + stderr).replace(ANSI_RE, "").replace(/\r/g, "").trim()
    if (code === 0) {
      invalidateMcpEnabledCache()
    }
    return { ok: code === 0, output: out || (code === 0 ? "认证完成" : "认证失败") }
  } catch (e: any) {
    const msg = e?.message ?? "启动失败"
    logCursorAgentResponse("mcp-login", { ok: false, stdout: "", stderr: "", error: msg })
    return { ok: false, output: msg }
  }
}

// ── Public API: Tools Query ──────────────────────────────

function extractParams(schema: any): McpToolInfo["params"] {
  if (!schema?.properties) return undefined
  const required = new Set<string>(schema.required ?? [])
  return Object.entries(schema.properties).map(([k, v]: [string, any]) => ({
    name: k,
    type: v.type,
    description: v.description,
    required: required.has(k),
  }))
}

function queryToolsViaProtocol(cmd: string, args: string[], envOverride?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...(envOverride ?? {}) }
    if (!env.PATH && env.Path) env.PATH = env.Path

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(quoteArg(cmd), args.map(quoteArg), { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: true })
    } catch (e: any) {
      resolve({ ok: false, tools: [], error: `启动失败: ${e.message}` })
      return
    }

    let stdout = ""
    let phase: "init" | "list" | "done" = "init"
    const timeout = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve({ ok: false, tools: [], error: "查询超时" })
    }, 15_000)

    const finish = (result: { ok: boolean; tools: McpToolInfo[]; error?: string }) => {
      if (phase === "done") return
      phase = "done"
      clearTimeout(timeout)
      try { child.kill() } catch { /* */ }
      resolve(result)
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
      for (const raw of stdout.split("\n")) {
        const line = raw.trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result && phase === "init") {
            phase = "list"
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
          }
          if (msg.id === 2 && msg.result?.tools) {
            const tools: McpToolInfo[] = (msg.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
            finish({ ok: true, tools })
          }
        } catch { /* not json */ }
      }
    })

    child.on("error", (err) => finish({ ok: false, tools: [], error: `启动失败: ${err.message}` }))
    child.on("close", () => finish(phase === "init" ? { ok: false, tools: [], error: "进程退出，未获取到工具" } : { ok: true, tools: [] }))

    child.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cursor-claw", version: "1.0.0" } },
    }) + "\n")
  })
}

async function queryToolsViaHttp(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
  const post = (body: string): Promise<any> => new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === "https:"
    const mod = isHttps ? require("node:https") : require("node:http")
    const req = mod.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(headers ?? {}) },
      timeout: 10_000,
    }, (res: any) => {
      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        try {
          if (res.headers["content-type"]?.includes("text/event-stream")) {
            for (const line of data.split("\n")) {
              if (line.startsWith("data:")) {
                const parsed = JSON.parse(line.slice(5).trim())
                if (parsed.id !== undefined) { resolve(parsed); return }
              }
            }
          }
          resolve(JSON.parse(data))
        } catch { resolve(null) }
      })
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")) })
    req.write(body)
    req.end()
  })

  try {
    const initRes = await post(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cursor-claw", version: "1.0.0" } }))
    if (!initRes?.result) return { ok: false, tools: [], error: "initialize 失败" }
    const listRes = await post(rpc(2, "tools/list"))
    if (!listRes?.result?.tools) return { ok: false, tools: [], error: "tools/list 无结果" }
    const tools: McpToolInfo[] = (listRes.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
    return { ok: true, tools }
  } catch (e: any) {
    return { ok: false, tools: [], error: e?.message ?? "HTTP 请求失败" }
  }
}

function queryToolsViaCli(serverName: string): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const config = getConfig()
  const ws = primaryWorkspaceForCli()
  if (!ws || !resolveAgentBinary()) return Promise.resolve({ ok: false, tools: [], error: "CLI 不可用" })
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  applyProxyEnv(env, getConfig())
  return spawnAsync(["mcp", "list-tools", serverName], ws, env).then((r) => {
    const clean = (r.stdout + r.stderr).replace(ANSI_RE, "").replace(/\r/g, "")
    if (r.code !== 0) return { ok: false, tools: [] as McpToolInfo[], error: clean.trim().split("\n").pop()?.trim() || `exit ${r.code}` }
    const tools: McpToolInfo[] = []
    for (const line of clean.split("\n")) {
      const m = line.match(/^[-–]\s+(\S+)(?:\s*\(([^)]*)\))?/)
      if (!m) continue
      const params = m[2]?.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name }))
      tools.push({ name: m[1], params: params?.length ? params : undefined })
    }
    return { ok: true, tools }
  })
}

export async function getMcpServerTools(serverName: string, force = false): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  if (!force) {
    const cached = mcpToolsCache.get(serverName)
    if (cached) return { ok: !cached.error, tools: cached.tools, error: cached.error }
  }

  const servers = getMcpServerList()
  const server = servers.find((s) => s.name === serverName)
  if (!server) return { ok: false, tools: [], error: "MCP 服务器未找到" }

  let result: { ok: boolean; tools: McpToolInfo[]; error?: string }

  if (server.type === "url" && server.url) {
    const headers = server.rawConfig?.headers as Record<string, string> | undefined
    result = await queryToolsViaHttp(server.url, headers)
    if (result.ok && result.tools.length > 0) {
      mcpToolsCache.set(serverName, { tools: result.tools })
      return result
    }
  }

  if (server.type === "command" && server.command) {
    result = await queryToolsViaProtocol(server.command, server.args ?? [], server.env)
    if (result.ok && result.tools.length > 0) {
      mcpToolsCache.set(serverName, { tools: result.tools })
      return result
    }
  }

  result = await queryToolsViaCli(serverName)
  mcpToolsCache.set(serverName, { tools: result.tools, error: result.error })
  return result
}
