import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomic, readJsonFile } from "./atomic-json.js"
import { filterUserMcp } from "./visitor-limits.js"

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
export const PROJECT_MCP_KEY = "lk-harness-project"
export const SCHEDULE_MCP_KEY = "lk-harness-schedule"
export const MEMORY_MCP_KEY = "lk-harness-memory"

const RESERVED = new Set([CLAW_MCP_KEY, ADMIN_MCP_KEY, PROJECT_MCP_KEY, SCHEDULE_MCP_KEY, MEMORY_MCP_KEY])

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

export function shouldIncludeAdminMcp(
  meta?: { chatType?: string },
  sessionKey?: string,
  mainUserSession?: boolean,
): boolean {
  const ct = meta?.chatType
  if (ct === "project" || ct === "task" || ct === "temp" || ct === "group") return false
  if (sessionKey?.includes("::project_")) return false
  return mainUserSession === true
}

/**
 * task：独立定时任务（有 send_result）；interactive：交互会话（提问 / 媒体 / Diff）；
 * visitor：受限的访客会话，只有 send_question（send_image / send_file 能把本机任意文件发出去，访客碰不得）。
 */
export type HarnessMcpEndpoint = "task" | "interactive" | "visitor";

/**
 * AI 自排程工具是否挂载：主用户会话 / 项目会话才有，无卡片的独立任务不挂；
 * 排程绑定调用者会话，没有调用者身份就不挂。
 * 提示词里「自排程」那一段与工具挂载共用这个判定，保证挂了的会话一定被告知、没挂的不会被误导。
 */
export function shouldMountScheduleMcp(o: {
  includeAdmin: boolean
  includeProject: boolean
  endpoint: HarnessMcpEndpoint
  sessionKey?: string
}): boolean {
  return (o.includeAdmin || o.includeProject) && o.endpoint !== "task" && !!o.sessionKey?.trim()
}

/**
 * 会话记忆工具是否挂载：交互会话才有。独立定时任务每次都是全新 Agent、没有「会话」可记；访客是受限档，不开放。
 * 记忆绑定调用者会话，没有调用者身份就不挂。
 * 提示词里「会话记忆」那一段和首轮带入记忆都与工具挂载共用这个判定。
 */
export function shouldMountMemoryMcp(o: { endpoint: HarnessMcpEndpoint; sessionKey?: string }): boolean {
  return o.endpoint === "interactive" && !!o.sessionKey?.trim()
}

/**
 * 内置 MCP 认「调用者是哪个会话」靠的请求头。
 * HTTP 头只能放 Latin-1 字符，而会话键里的目录可以是中文（如 `::D:\workspace\排查`），原样放进去客户端会直接拒发，
 * 所以放进头里的是 encodeURIComponent 之后的值，daemon 读到后再还原。两端都经过下面这一对函数，不要各写各的。
 */
export const INVOKER_SESSION_KEY_HEADER = "X-Harness-Session-Key"

export function encodeInvokerSessionKey(sessionKey: string): string {
  return encodeURIComponent(sessionKey)
}

/** 没有这个头就是没有调用者，返回 undefined；值不是合法编码会抛 URIError，由请求处理的最外层按 500 报出去 */
export function decodeInvokerSessionKey(headerValue: string | undefined): string | undefined {
  return headerValue === undefined ? undefined : decodeURIComponent(headerValue)
}

export function buildBuiltinMcpServers(
  port: number | null,
  includeAdmin: boolean,
  endpoint: HarnessMcpEndpoint = "interactive",
  includeProject = false,
  invokerSessionKey?: string,
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  if (port) {
    const base = `http://127.0.0.1:${port}`
    const sk = invokerSessionKey?.trim()
    const invokerHeaders = sk ? { headers: { [INVOKER_SESSION_KEY_HEADER]: encodeInvokerSessionKey(sk) } } : {}
    const builtinPath = endpoint === "task" ? "/mcp-task" : endpoint === "visitor" ? "/mcp-visitor" : "/mcp-interactive"
    servers[CLAW_MCP_KEY] = { url: `${base}${builtinPath}`, ...invokerHeaders }
    if (includeAdmin) {
      servers[ADMIN_MCP_KEY] = {
        url: `${base}/mcp-admin`,
        ...invokerHeaders,
      }
    }
    if (includeProject) servers[PROJECT_MCP_KEY] = { url: `${base}/mcp-project` }
    if (shouldMountScheduleMcp({ includeAdmin, includeProject, endpoint, sessionKey: sk })) {
      servers[SCHEDULE_MCP_KEY] = { url: `${base}/mcp-schedule`, ...invokerHeaders }
    }
    if (shouldMountMemoryMcp({ endpoint, sessionKey: sk })) {
      servers[MEMORY_MCP_KEY] = { url: `${base}/mcp-memory`, ...invokerHeaders }
    }
  }
  return servers
}

/**
 * userMcpAllow：只挂这些用户 MCP（访客档的「额外开放」）；缺省 = 用户装的全挂。
 * 内置 MCP 不受它影响（由 endpoint 决定里面有哪些工具）。
 */
export function buildSdkMcpServers(
  port: number | null,
  includeAdmin: boolean,
  endpoint: HarnessMcpEndpoint = "interactive",
  includeProject = false,
  invokerSessionKey?: string,
  userMcpAllow?: readonly string[],
): Record<string, Record<string, unknown>> {
  const user = listEnabledHarnessMcpConfigs()
  const picked = userMcpAllow ? filterUserMcp(user, { mcpAllow: [...userMcpAllow] }) : user
  return { ...buildBuiltinMcpServers(port, includeAdmin, endpoint, includeProject, invokerSessionKey), ...picked }
}
