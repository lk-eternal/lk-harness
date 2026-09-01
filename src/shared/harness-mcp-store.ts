import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomic, readJsonFile } from "./atomic-json.js"

export interface HarnessMcpServer {
  name: string
  config: Record<string, unknown>
  enabled: boolean
}

export interface StoreFile {
  order: string[]
  servers: Record<string, Record<string, unknown>>
}

export const CLAW_MCP_KEY = "lk-harness"
export const ADMIN_MCP_KEY = "lk-harness-admin"

const RESERVED = new Set([CLAW_MCP_KEY, ADMIN_MCP_KEY])

let userDataRoot = ""

export function initHarnessMcpStore(root: string): void {
  userDataRoot = root
}

function migrateLegacyMcpDir(): void {
  if (!userDataRoot) return
  const newDir = path.join(userDataRoot, "harness-mcp")
  const oldDir = path.join(userDataRoot, "claw-mcp")
  if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return
  try {
    fs.renameSync(oldDir, newDir)
  } catch {
    try { fs.cpSync(oldDir, newDir, { recursive: true }) } catch { /* ignore */ }
  }
}

function storePath(): string {
  migrateLegacyMcpDir()
  return path.join(userDataRoot, "harness-mcp", "servers.json")
}

function ensureDir(): void {
  const dir = path.dirname(storePath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readStore(): StoreFile {
  if (!userDataRoot) return { order: [], servers: {} }
  try {
    const raw = readJsonFile(storePath(), { order: [], servers: {} })
    return { order: Array.isArray(raw.order) ? raw.order : [], servers: raw.servers ?? {} }
  } catch {
    return { order: [], servers: {} }
  }
}

function writeStore(data: StoreFile): void {
  try {
    readJsonFile(storePath(), { order: [], servers: {} })
  } catch {
    return
  }
  ensureDir()
  writeJsonAtomic(storePath(), data)
}

export function listHarnessMcpServers(): HarnessMcpServer[] {
  const { order, servers } = readStore()
  const seen = new Set<string>()
  const result: HarnessMcpServer[] = []
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

export function listEnabledHarnessMcpConfigs(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const s of listHarnessMcpServers()) {
    if (!s.enabled) continue
    const { disabled: _d, ...rest } = s.config
    out[s.name] = rest
  }
  return out
}

export function saveHarnessMcpServer(name: string, config: Record<string, unknown>): boolean {
  const trimmed = name.trim()
  if (!trimmed || RESERVED.has(trimmed)) return false
  const store = readStore()
  if (!store.order.includes(trimmed)) store.order.push(trimmed)
  store.servers[trimmed] = config
  writeStore(store)
  return true
}

export function deleteHarnessMcpServer(name: string): boolean {
  const store = readStore()
  if (!(name in store.servers)) return false
  delete store.servers[name]
  store.order = store.order.filter((n) => n !== name)
  writeStore(store)
  return true
}

export function setHarnessMcpServerEnabled(name: string, enabled: boolean): boolean {
  const store = readStore()
  const cfg = store.servers[name]
  if (!cfg) return false
  if (enabled) delete cfg.disabled
  else cfg.disabled = true
  store.servers[name] = cfg
  writeStore(store)
  return true
}

export function readHarnessMcpStoreRaw(): StoreFile | null {
  const s = readStore()
  if (!s.order.length && !Object.keys(s.servers).length) return null
  return s
}

export function writeHarnessMcpStoreRaw(data: StoreFile): void {
  writeStore(data)
}

/** 合并 MCP：跳过本地已存在的 server 名，保留本地配置 */
export function mergeHarnessMcpStoreRaw(incoming: StoreFile): string[] {
  const notes: string[] = []
  const current = readStore()
  const order = [...current.order]
  const servers = { ...current.servers }
  const seen = new Set(Object.keys(servers))

  const addServer = (name: string, cfg: Record<string, unknown> | undefined) => {
    if (!cfg || RESERVED.has(name)) return
    if (seen.has(name)) {
      notes.push(`${name}：已跳过（本地已存在）`)
      return
    }
    if (!order.includes(name)) order.push(name)
    servers[name] = cfg
    seen.add(name)
  }

  for (const name of incoming.order) addServer(name, incoming.servers[name])
  for (const name of Object.keys(incoming.servers)) {
    if (!incoming.order.includes(name)) addServer(name, incoming.servers[name])
  }
  writeStore({ order, servers })
  return notes
}

export function harnessMcpStoreDir(): string {
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
  return { ...buildBuiltinMcpServers(port, includeAdmin), ...listEnabledHarnessMcpConfigs() }
}
