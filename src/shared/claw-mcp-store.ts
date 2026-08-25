import * as fs from "node:fs"
import * as path from "node:path"

export interface ClawMcpServer {
  name: string
  config: Record<string, unknown>
  enabled: boolean
}

export interface StoreFile {
  order: string[]
  servers: Record<string, Record<string, unknown>>
}

export const CLAW_MCP_KEY = "cursor-claw"
export const ADMIN_MCP_KEY = "cursor-claw-admin"

const RESERVED = new Set([CLAW_MCP_KEY, ADMIN_MCP_KEY])

let userDataRoot = ""

export function initClawMcpStore(root: string): void {
  userDataRoot = root
}

function storePath(): string {
  return path.join(userDataRoot, "claw-mcp", "servers.json")
}

function ensureDir(): void {
  const dir = path.dirname(storePath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readStore(): StoreFile {
  if (!userDataRoot) return { order: [], servers: {} }
  try {
    if (fs.existsSync(storePath())) {
      const raw = JSON.parse(fs.readFileSync(storePath(), "utf-8")) as StoreFile
      return { order: Array.isArray(raw.order) ? raw.order : [], servers: raw.servers ?? {} }
    }
  } catch { /* empty */ }
  return { order: [], servers: {} }
}

function writeStore(data: StoreFile): void {
  ensureDir()
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), "utf-8")
}

export function listClawMcpServers(): ClawMcpServer[] {
  const { order, servers } = readStore()
  const seen = new Set<string>()
  const result: ClawMcpServer[] = []
  for (const name of order) {
    if (seen.has(name) || RESERVED.has(name)) continue
    const cfg = servers[name]
    if (!cfg) continue
    seen.add(name)
    result.push({ name, config: cfg, enabled: cfg.disabled !== true })
  }
  for (const name of Object.keys(servers)) {
    if (seen.has(name) || RESERVED.has(name)) continue
    const cfg = servers[name]
    result.push({ name, config: cfg, enabled: cfg.disabled !== true })
  }
  return result
}

export function listEnabledClawMcpConfigs(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const s of listClawMcpServers()) {
    if (!s.enabled) continue
    const { disabled: _d, ...rest } = s.config
    out[s.name] = rest
  }
  return out
}

export function saveClawMcpServer(name: string, config: Record<string, unknown>): boolean {
  const trimmed = name.trim()
  if (!trimmed || RESERVED.has(trimmed)) return false
  const store = readStore()
  if (!store.order.includes(trimmed)) store.order.push(trimmed)
  store.servers[trimmed] = config
  writeStore(store)
  return true
}

export function deleteClawMcpServer(name: string): boolean {
  const store = readStore()
  if (!(name in store.servers)) return false
  delete store.servers[name]
  store.order = store.order.filter((n) => n !== name)
  writeStore(store)
  return true
}

export function setClawMcpServerEnabled(name: string, enabled: boolean): boolean {
  const store = readStore()
  const cfg = store.servers[name]
  if (!cfg) return false
  if (enabled) delete cfg.disabled
  else cfg.disabled = true
  store.servers[name] = cfg
  writeStore(store)
  return true
}

export function readClawMcpStoreRaw(): StoreFile | null {
  const s = readStore()
  if (!s.order.length && !Object.keys(s.servers).length) return null
  return s
}

export function writeClawMcpStoreRaw(data: StoreFile): void {
  writeStore(data)
}

export function clawMcpStoreDir(): string {
  ensureDir()
  return path.dirname(storePath())
}

export function shouldIncludeAdminMcp(meta?: { chatType?: string }, sessionKey?: string): boolean {
  const ct = meta?.chatType
  if (ct === "project" || ct === "task" || ct === "temp") return false
  if (sessionKey?.includes("::project_")) return false
  return true
}

export function buildBuiltinMcpServers(port: number | null, includeAdmin: boolean): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  if (port) {
    const base = `http://127.0.0.1:${port}`
    servers[CLAW_MCP_KEY] = { url: `${base}/mcp` }
    if (includeAdmin) servers[ADMIN_MCP_KEY] = { url: `${base}/mcp-admin` }
  }
  return servers
}

export function buildSdkMcpServers(port: number | null, includeAdmin: boolean): Record<string, Record<string, unknown>> {
  return { ...buildBuiltinMcpServers(port, includeAdmin), ...listEnabledClawMcpConfigs() }
}
