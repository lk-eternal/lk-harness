import * as fs from "node:fs"
import * as path from "node:path"

/** 会话级供应商（Agent 资源）覆盖：只影响当前会话，不碰通道默认 */

interface OverrideFile {
  sessions: Record<string, { resourceId: string; updatedAt: number }>
}

const FILE_NAME = "session-resource-overrides.json"

let dataDir: string | null = null
let cache: OverrideFile | null = null

export function initSessionResourceStore(dir: string): void {
  dataDir = dir
  cache = null
}

export function resetSessionResourceStoreForTests(): void {
  dataDir = null
  cache = null
}

function resolveDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR
  throw new Error("session-resource-store: data dir not initialized")
}

function storePath(): string {
  return path.join(resolveDataDir(), FILE_NAME)
}

function load(): OverrideFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as OverrideFile
    cache = { sessions: raw.sessions ?? {} }
  } catch {
    cache = { sessions: {} }
  }
  return cache
}

function save(): void {
  if (!cache) return
  const dir = resolveDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = storePath() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(cache), "utf8")
  fs.renameSync(tmp, storePath())
}

/** Windows 路径大小写不一致时，用已有 key 对齐 */
function findStoredSessionKey(sessions: Record<string, unknown>, sessionKey: string): string | undefined {
  if (sessionKey in sessions) return sessionKey
  if (process.platform !== "win32") return undefined
  const lower = sessionKey.toLowerCase()
  for (const k of Object.keys(sessions)) {
    if (k.toLowerCase() === lower) return k
  }
  return undefined
}

export function setSessionResourceOverride(sessionKey: string, resourceId: string): void {
  const s = load()
  const prev = findStoredSessionKey(s.sessions, sessionKey)
  if (prev && prev !== sessionKey) delete s.sessions[prev]
  s.sessions[sessionKey] = { resourceId, updatedAt: Date.now() }
  save()
}

export function getSessionResourceOverride(sessionKey: string): string | undefined {
  const s = load()
  const key = findStoredSessionKey(s.sessions, sessionKey)
  return key ? s.sessions[key]?.resourceId : undefined
}

export function clearSessionResourceOverride(sessionKey: string): void {
  const s = load()
  const key = findStoredSessionKey(s.sessions, sessionKey)
  if (!key) return
  delete s.sessions[key]
  save()
}

/** 会话有效资源：override > 通道默认 */
export function resolveResourceForSession(sessionKey: string, channelResourceId: string | undefined): string | undefined {
  return getSessionResourceOverride(sessionKey) ?? channelResourceId
}
