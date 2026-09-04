import * as fs from "node:fs"
import * as path from "node:path"
import { modelSlug } from "./model-utils.js"

export interface ModelRef {
  model: string
  modelParams?: string
}

export interface ModelEntry extends ModelRef {
  label?: string
  usedAt?: number
}

interface OverrideFile {
  sessions: Record<string, ModelRef & { updatedAt: number }>
  pending: Record<string, ModelRef & { updatedAt: number }>
  recent: (ModelRef & { usedAt: number })[]
}

const FILE_NAME = "session-model-overrides.json"
const DEFAULT_RECENT_CAP = 8

let dataDir: string | null = null
let cache: OverrideFile | null = null

export function initSessionModelStore(dir: string): void {
  dataDir = dir
  cache = null
}

export function resetSessionModelStoreForTests(): void {
  dataDir = null
  cache = null
}

function resolveDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR
  throw new Error("session-model-store: data dir not initialized")
}

function storePath(): string {
  return path.join(resolveDataDir(), FILE_NAME)
}

function emptyStore(): OverrideFile {
  return { sessions: {}, pending: {}, recent: [] }
}

function load(): OverrideFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as OverrideFile
    cache = {
      sessions: raw.sessions ?? {},
      pending: raw.pending ?? {},
      recent: Array.isArray(raw.recent) ? raw.recent : [],
    }
  } catch {
    cache = emptyStore()
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

export function modelEntryKey(e: ModelRef): string {
  return `${e.model}\0${e.modelParams ?? ""}`
}

export function pendingKey(chatKey: string, workspaceDir: string): string {
  return `${chatKey}::${workspaceDir}`
}

/** sessionKey 形如 chatKey::workspace；无 :: 时整段当�?chatKey */
export function pendingKeyFromSession(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return sessionKey
  return sessionKey
}

/** Windows 路径大小写不一致时，用已有 key 对齐，避�?override 写了读不�?*/
function findStoredSessionKey(sessions: Record<string, unknown>, sessionKey: string): string | undefined {
  if (sessionKey in sessions) return sessionKey
  if (process.platform !== "win32") return undefined
  const lower = sessionKey.toLowerCase()
  for (const k of Object.keys(sessions)) {
    if (k.toLowerCase() === lower) return k
  }
  return undefined
}

export function setSessionOverride(sessionKey: string, ref: ModelRef): void {
  const s = load()
  const prev = findStoredSessionKey(s.sessions, sessionKey)
  if (prev && prev !== sessionKey) delete s.sessions[prev]
  s.sessions[sessionKey] = { model: ref.model, modelParams: ref.modelParams ?? "", updatedAt: Date.now() }
  save()
}

export function getSessionOverride(sessionKey: string): ModelRef | undefined {
  const s = load()
  const key = findStoredSessionKey(s.sessions, sessionKey)
  if (!key) return undefined
  const e = s.sessions[key]
  if (!e?.model) return undefined
  return { model: e.model, modelParams: e.modelParams ?? "" }
}

export function clearSessionOverride(sessionKey: string): void {
  const s = load()
  const key = findStoredSessionKey(s.sessions, sessionKey)
  if (!key) return
  delete s.sessions[key]
  save()
}

/** 通道保存新模型时清掉该通道下所有会�?override，避免仍用旧 /m 或历史模�?*/
export function clearSessionOverridesForChannel(channelId: string): number {
  const s = load()
  const prefix = `${channelId}|`
  let n = 0
  for (const key of Object.keys(s.sessions)) {
    if (key.startsWith(prefix)) {
      delete s.sessions[key]
      n++
    }
  }
  if (n) save()
  return n
}

export function setPendingOverride(key: string, ref: ModelRef): void {
  const s = load()
  s.pending[key] = { model: ref.model, modelParams: ref.modelParams ?? "", updatedAt: Date.now() }
  save()
}

export function getPendingOverride(key: string): ModelRef | undefined {
  const e = load().pending[key]
  if (!e?.model) return undefined
  return { model: e.model, modelParams: e.modelParams ?? "" }
}

/** 读取并删�?pending；不存在返回 undefined */
export function consumePendingOverride(key: string): ModelRef | undefined {
  const s = load()
  const e = s.pending[key]
  if (!e?.model) return undefined
  delete s.pending[key]
  save()
  return { model: e.model, modelParams: e.modelParams ?? "" }
}

/**
 * 解析会话有效模型：session override > pending(消费并写�?override) > fallback
 * pending key �?sessionKey 同形（chatKey::workspace�?
 */
export function resolveModelForSession(sessionKey: string, fallback: ModelRef): ModelRef {
  const ov = getSessionOverride(sessionKey)
  if (ov) return ov

  const pending = consumePendingOverride(pendingKeyFromSession(sessionKey))
  if (pending) {
    setSessionOverride(sessionKey, pending)
    return pending
  }

  return { model: fallback.model, modelParams: fallback.modelParams ?? "" }
}

export function getRecentModels(): ModelEntry[] {
  return load().recent.map((r) => ({
    model: r.model,
    modelParams: r.modelParams ?? "",
    usedAt: r.usedAt,
  }))
}

export function pushRecentModel(ref: ModelRef, cap = DEFAULT_RECENT_CAP): void {
  const s = load()
  const key = modelEntryKey(ref)
  const next = s.recent.filter((r) => modelEntryKey(r) !== key)
  next.unshift({ model: ref.model, modelParams: ref.modelParams ?? "", usedAt: Date.now() })
  s.recent = next.slice(0, Math.max(1, cap))
  save()
}

/** 从「最近使用」去掉一条（常用栏移除时需同步，否则仍会被 listQuickModels 补回来） */
export function removeRecentModel(ref: ModelRef): void {
  const s = load()
  const key = modelEntryKey({ model: ref.model, modelParams: ref.modelParams ?? "" })
  const next = s.recent.filter((r) => modelEntryKey(r) !== key)
  if (next.length === s.recent.length) return
  s.recent = next
  save()
}

/** 收藏置顶 + 最近补充，去重，最�?limit �?*/
export function listQuickModels(favorites: ModelEntry[], limit = 6): ModelEntry[] {
  const out: ModelEntry[] = []
  const seen = new Set<string>()
  const add = (e: ModelEntry) => {
    if (!e.model || out.length >= limit) return
    const k = modelEntryKey(e)
    if (seen.has(k)) return
    seen.add(k)
    out.push({
      model: e.model,
      modelParams: e.modelParams ?? "",
      label: e.label || modelSlug(e.model, e.modelParams) || e.model,
      ...((e as { resourceId?: string }).resourceId ? { resourceId: (e as { resourceId?: string }).resourceId } : {}),
    } as ModelEntry)
  }
  for (const f of favorites) add(f)
  for (const r of getRecentModels()) add(r)
  return out
}
