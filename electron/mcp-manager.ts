import { spawn } from "node:child_process"
import * as path from "node:path"
import { quoteArg } from "./agent-cli"
import {
  listClawMcpServers,
  saveClawMcpServer,
  deleteClawMcpServer,
  setClawMcpServerEnabled,
  readClawMcpStoreRaw,
  writeClawMcpStoreRaw,
  clawMcpStoreDir,
  CLAW_MCP_KEY,
  ADMIN_MCP_KEY,
} from "../src/shared/claw-mcp-store.js"

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "claw"
  authenticated?: boolean
  rawConfig?: Record<string, unknown>
  enabled?: boolean
}

export interface McpToolInfo {
  name: string
  description?: string
  params?: { name: string; type?: string; description?: string; required?: boolean }[]
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

interface McpListCache { enabled: Record<string, boolean>; status: Record<string, string>; ts: number }
let mcpListCache: McpListCache | null = null
const mcpToolsCache = new Map<string, { tools: McpToolInfo[]; error?: string }>()

function buildEntry(name: string, raw: Record<string, unknown>): McpServerEntry {
  const type: "command" | "url" = raw.url ? "url" : "command"
  return {
    name,
    type,
    command: raw.command as string | undefined,
    args: raw.args as string[] | undefined,
    url: raw.url as string | undefined,
    env: raw.env as Record<string, string> | undefined,
    source: "claw",
    authenticated: false,
    rawConfig: raw,
    enabled: raw.disabled !== true,
  }
}

function fetchMcpListFromStore(): McpListCache {
  const enabled: Record<string, boolean> = {}
  const status: Record<string, string> = {}
  for (const s of getMcpServerList()) {
    const on = s.enabled !== false
    enabled[s.name] = on
    status[s.name] = on ? "ready" : "disabled"
  }
  return { enabled, status, ts: Date.now() }
}

async function fetchMcpList(_force = false): Promise<McpListCache> {
  const result = fetchMcpListFromStore()
  mcpListCache = result
  return result
}

export async function getMcpEnabledMap(force = false): Promise<Record<string, boolean>> {
  if (force) invalidateMcpEnabledCache()
  return (await fetchMcpList(force)).enabled
}

export async function getMcpStatusMap(force = false): Promise<Record<string, string>> {
  if (force) invalidateMcpEnabledCache()
  return (await fetchMcpList(force)).status
}

export function invalidateMcpEnabledCache(): void {
  mcpListCache = null
  mcpToolsCache.clear()
}

export function warmupMcpCache(): void {
  void fetchMcpList(false).catch(() => { /* ignore */ })
}

export async function toggleMcpServer(serverName: string, enabled: boolean): Promise<{ ok: boolean; output: string }> {
  if ([CLAW_MCP_KEY, ADMIN_MCP_KEY].includes(serverName)) {
    return { ok: false, output: `${serverName} 为内置 MCP，不可切换` }
  }
  const ok = setClawMcpServerEnabled(serverName, enabled)
  if (ok) invalidateMcpEnabledCache()
  return ok
    ? { ok: true, output: `${serverName} ${enabled ? "enabled" : "disabled"}` }
    : { ok: false, output: `${serverName} 不存在` }
}

export function getMcpServerList(): McpServerEntry[] {
  return listClawMcpServers().map((s) => buildEntry(s.name, s.config))
}

export function getMcpJsonPath(_scope: "global" | "project" = "global"): string {
  return path.join(clawMcpStoreDir(), "servers.json")
}

export function readMcpJson(_scope: "global" | "project" = "global"): Record<string, unknown> | null {
  const raw = readClawMcpStoreRaw()
  if (!raw) return null
  return { mcpServers: raw.servers, order: raw.order }
}

export function writeMcpJson(_scope: "global" | "project", data: Record<string, unknown>): boolean {
  try {
    const servers = (data.mcpServers ?? data.servers ?? {}) as Record<string, Record<string, unknown>>
    const order = Array.isArray(data.order) ? data.order as string[] : Object.keys(servers)
    writeClawMcpStoreRaw({ order, servers })
    invalidateMcpEnabledCache()
    return true
  } catch {
    return false
  }
}

export function saveMcpServer(name: string, config: Record<string, unknown>, _scope: "global" | "project" = "global"): { ok: boolean; error?: string } {
  const ok = saveClawMcpServer(name, config)
  if (ok) invalidateMcpEnabledCache()
  return ok ? { ok: true } : { ok: false, error: "写入失败或为保留名称" }
}

export function deleteMcpServer(name: string, _scope: "global" | "project" = "global"): { ok: boolean; error?: string } {
  const ok = deleteClawMcpServer(name)
  if (ok) invalidateMcpEnabledCache()
  return ok ? { ok: true } : { ok: false, error: `${name} 不存在` }
}

export async function loginMcpServer(_serverName: string): Promise<{ ok: boolean; output: string }> {
  return { ok: false, output: "Claw 独立 MCP 暂不支持 CLI OAuth；请在配置中手动填写 token/headers" }
}

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
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lk-harness", version: "1.0.0" } },
    }) + "\n")
  })
}

async function queryToolsViaHttp(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params })
  const post = (body: string): Promise<any> => new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === "https:" ? require("node:https") : require("node:http")
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
    const initRes = await post(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lk-harness", version: "1.0.0" } }))
    if (!initRes?.result) return { ok: false, tools: [], error: "initialize 失败" }
    const listRes = await post(rpc(2, "tools/list"))
    if (!listRes?.result?.tools) return { ok: false, tools: [], error: "tools/list 无结果" }
    const tools: McpToolInfo[] = (listRes.result.tools as any[]).map((t: any) => ({ name: t.name, description: t.description, params: extractParams(t.inputSchema) }))
    return { ok: true, tools }
  } catch (e: any) {
    return { ok: false, tools: [], error: e?.message ?? "HTTP 请求失败" }
  }
}

export async function getMcpServerTools(serverName: string, force = false): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  if (!force) {
    const cached = mcpToolsCache.get(serverName)
    if (cached) return { ok: !cached.error, tools: cached.tools, error: cached.error }
  }

  const server = getMcpServerList().find((s) => s.name === serverName)
  if (!server) return { ok: false, tools: [], error: "MCP 服务器未找到" }

  let result: { ok: boolean; tools: McpToolInfo[]; error?: string } = { ok: false, tools: [], error: "无法连接 MCP 服务器" }

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

  result = { ok: false, tools: [], error: result?.error ?? "无法连接 MCP 服务器" }
  mcpToolsCache.set(serverName, { tools: result.tools, error: result.error })
  return result
}
