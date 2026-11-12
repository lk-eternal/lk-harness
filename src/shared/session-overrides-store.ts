import * as fs from "node:fs"
import * as path from "node:path"
import { ensureSessionLayoutMigrated } from "./session-layout-migrate.js"
import {
  STATE_FILE,
  ensureSessionEntry,
  globalLastModelsPath,
  globalRecentPath,
  listSessionEntries,
  sessionEntryDir,
  sessionStatePath,
} from "./session-entry-paths.js"
import { sessionStateDir } from "./data-paths.js"

/** 单会话扁平记录：模型/供应商/推理 + SDK·Pi 续聊元数据（不含 senderOpenId） */
export interface SessionOverrideRecord {
  /** 裸 temp_/task_ 等会话绑定的 chatKey（ch_xxx|oc_…） */
  chatId?: string
  model?: string
  modelParams?: string
  resourceId?: string
  thinkingLevel?: string
  agentId?: string
  /** SDK 续聊记录里的 cwd：上次拉起时 Agent 实际所在的目录（不是用户选的，见 boundDir） */
  workspaceDir?: string
  /**
   * 用户给这个会话选的工作目录：只用于应用内的临时会话（会话键里的目录只是它自己的临时文件夹）。
   * 有它就用它当 Agent 的 cwd，所以多个会话可以共用同一个目录；会话开始后不再更换（SDK 的续聊要求 cwd 不变）。
   */
  boundDir?: string
  rulesHash?: string
  /** SDK 会话：这个账本里 AI 已经拿到的 Skill 名单的指纹（名单变了才补发） */
  skillsHash?: string
  daemonPort?: number
  streamCardId?: string
  updatedAt: number
}

export interface RecentModelEntry {
  model: string
  modelParams?: string
  resourceId?: string
  usedAt: number
}

interface OverrideFile {
  sessions: Record<string, SessionOverrideRecord>
  recent: RecentModelEntry[]
}

/** @deprecated 单文件 overrides 已迁为 sessions/{id}/state.json */
export const OVERRIDES_FILE_NAME = "session-overrides.json"
export const RESUME_ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000

const LEGACY_FILES = [
  "session-model-overrides.json",
  "session-resource-overrides.json",
  "session-thinking.json",
  "sdk-resume-map.json",
  "pi-resume-map.json",
] as const

let dataDir: string | null = null
let legacyMigrationDone = false

export function initSessionOverridesStore(dir: string): void {
  dataDir = dir
  legacyMigrationDone = false
  ensureLegacyFiveFileMigrated()
}

export function resetSessionOverridesStoreForTests(): void {
  dataDir = null
  legacyMigrationDone = false
}

function resolveDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR
  throw new Error("session-overrides-store: data dir not initialized")
}

function emptyStore(): OverrideFile {
  return { sessions: {}, recent: [] }
}

function loadRecent(): RecentModelEntry[] {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  try {
    const raw = JSON.parse(fs.readFileSync(globalRecentPath(root), "utf8")) as RecentModelEntry[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function saveRecent(recent: RecentModelEntry[]): void {
  const root = resolveDataDir()
  const target = globalRecentPath(root)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(recent), "utf8")
  fs.renameSync(tmp, target)
}

function readStateFile(statePath: string): SessionOverrideRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as SessionOverrideRecord
  } catch {
    return undefined
  }
}

function writeStateFile(statePath: string, rec: SessionOverrideRecord): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const tmp = statePath + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(rec), "utf8")
  fs.renameSync(tmp, statePath)
}

/** withOverridesSnapshot 作用域内复用的同一份快照；作用域外为 null */
let scopedSnapshot: OverrideFile | null = null

/**
 * 在 fn 执行期间所有读取（getSessionRecord / 模型 / 供应商覆盖的解析）共用同一份快照，只读一遍磁盘。
 *
 * 不用的话，每次 getSessionRecord 都会把全部会话的 state.json 读一遍，
 * 给 N 个会话各解析一次有效模型就是 N×N 次读文件（会话管理页一次列几百个会话就明显卡）。
 * 只读用：作用域内写会话记录会抛错（写了也读不到新值，悄悄读到旧值比报错更糟）。
 * fn 必须是同步的：快照只在 fn 返回前有效。
 */
export function withOverridesSnapshot<T>(fn: () => T): T {
  if (scopedSnapshot) return fn()
  scopedSnapshot = readOverridesSnapshot()
  try {
    return fn()
  } finally {
    scopedSnapshot = null
  }
}

function assertNotInSnapshotScope(op: string): void {
  if (scopedSnapshot) throw new Error(`session-overrides-store: ${op} 不能在 withOverridesSnapshot 的只读作用域内调用`)
}

export function readOverridesSnapshot(): OverrideFile {
  if (scopedSnapshot) return scopedSnapshot
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  const sessions: Record<string, SessionOverrideRecord> = {}
  // 会话键走缓存（目录集合不变就不重读）；每个目录只剩「读 state.json」一次系统调用，没有 state 的直接跳过
  for (const { dir, sessionKey } of listSessionEntries(root)) {
    const rec = readStateFile(path.join(dir, STATE_FILE))
    if (rec) sessions[sessionKey] = rec
  }
  return { sessions, recent: loadRecent() }
}

/**
 * 单个会话键在磁盘上登记的那个键：先按键本身直接找它的目录（不用扫全部会话），
 * 找不到再在 Windows 上按大小写不敏感对齐（路径大小写写得不一致时，沿用已有的那份记录，不另起一份）。
 * 只认有 state.json 的；都没有返回 undefined。
 */
function findStoredOnDisk(root: string, sessionKey: string): { key: string; rec: SessionOverrideRecord } | undefined {
  const direct = readStateFile(sessionStatePath(root, sessionKey))
  if (direct) return { key: sessionKey, rec: direct }
  if (process.platform !== "win32") return undefined
  const lower = sessionKey.toLowerCase()
  for (const { sessionKey: k } of listSessionEntries(root)) {
    if (k === sessionKey || k.toLowerCase() !== lower) continue
    const rec = readStateFile(sessionStatePath(root, k))
    if (rec) return { key: k, rec }
  }
  return undefined
}

/** Windows 路径大小写不一致时，用已有 key 对齐 */
export function findStoredSessionKey(
  sessions: Record<string, unknown>,
  sessionKey: string,
): string | undefined {
  if (sessionKey in sessions) return sessionKey
  if (process.platform !== "win32") return undefined
  const lower = sessionKey.toLowerCase()
  for (const k of Object.keys(sessions)) {
    if (k.toLowerCase() === lower) return k
  }
  return undefined
}

function mergeRecord(
  prev: SessionOverrideRecord | undefined,
  patch: Partial<SessionOverrideRecord>,
): SessionOverrideRecord {
  const next: SessionOverrideRecord = { ...(prev ?? { updatedAt: 0 }) }
  for (const [k, v] of Object.entries(patch)) {
    if (k === "updatedAt") continue
    if (v === undefined || v === null) {
      delete (next as unknown as Record<string, unknown>)[k]
    } else {
      ;(next as unknown as Record<string, unknown>)[k] = v
    }
  }
  next.updatedAt = patch.updatedAt ?? Date.now()
  return next
}

function isRecordEmpty(r: SessionOverrideRecord): boolean {
  return (
    !r.chatId
    && !r.model
    && !r.modelParams
    && !r.resourceId
    && !r.thinkingLevel
    && !r.agentId
    && !r.workspaceDir
    && !r.boundDir
    && !r.rulesHash
    && !r.skillsHash
    && r.daemonPort === undefined
    && !r.streamCardId
  )
}

function resolveEntryDirForKey(sessionKey: string): { root: string; entryDir: string; canonicalKey: string } {
  assertNotInSnapshotScope("patchSessionRecord")
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  // 不再为了对齐一个键把全部会话的 state.json 读一遍：每次写记录都会走到这里
  const storedKey = findStoredOnDisk(root, sessionKey)?.key ?? sessionKey
  ensureSessionEntry(root, storedKey)
  return { root, entryDir: sessionEntryDir(root, storedKey), canonicalKey: storedKey }
}

/** 按 key 合并 patch 后落盘 */
export function patchSessionRecord(sessionKey: string, patch: Partial<SessionOverrideRecord>): void {
  const { root, entryDir, canonicalKey } = resolveEntryDirForKey(sessionKey)
  if (canonicalKey !== sessionKey) {
    const wrongDir = sessionEntryDir(root, sessionKey)
    if (wrongDir !== entryDir && fs.existsSync(wrongDir)) {
      try {
        fs.rmSync(wrongDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
  }
  const statePath = path.join(entryDir, STATE_FILE)
  const prev = readStateFile(statePath)
  const next = mergeRecord(prev, patch)
  if (isRecordEmpty(next)) {
    try {
      fs.unlinkSync(statePath)
    } catch { /* ignore */ }
  } else {
    writeStateFile(statePath, next)
  }
}

export function getSessionRecord(sessionKey: string): SessionOverrideRecord | undefined {
  if (scopedSnapshot) {
    const key = findStoredSessionKey(scopedSnapshot.sessions, sessionKey)
    return key ? scopedSnapshot.sessions[key] : undefined
  }
  // 作用域外按键直接读它自己那个目录的 state.json（目录名是键的哈希），不扫全部会话：
  // 预览文件、记续聊信息、查会话所属通道……都走这里，会话目录有几千个时每次扫一遍要上百毫秒
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  return findStoredOnDisk(root, sessionKey)?.rec
}

export function deleteSessionRecord(sessionKey: string): void {
  assertNotInSnapshotScope("deleteSessionRecord")
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  const key = findStoredOnDisk(root, sessionKey)?.key
  if (!key) return
  const statePath = sessionStatePath(root, key)
  try {
    fs.unlinkSync(statePath)
  } catch { /* ignore */ }
}

export function clearSessionRecordFields(sessionKey: string, fields: (keyof SessionOverrideRecord)[]): void {
  assertNotInSnapshotScope("clearSessionRecordFields")
  const root = resolveDataDir()
  const statePath = sessionStatePath(root, sessionKey)
  const prev = readStateFile(statePath)
  if (!prev) return
  const rec = { ...prev }
  for (const f of fields) {
    if (f === "updatedAt") continue
    delete (rec as Record<string, unknown>)[f as string]
  }
  if (isRecordEmpty(rec)) {
    try {
      fs.unlinkSync(statePath)
    } catch { /* ignore */ }
  } else {
    rec.updatedAt = Date.now()
    writeStateFile(statePath, rec)
  }
}

export function getRecentModelsFromStore(): RecentModelEntry[] {
  return loadRecent().map((r) => ({
    model: r.model,
    modelParams: r.modelParams ?? "",
    ...(r.resourceId ? { resourceId: r.resourceId } : {}),
    usedAt: r.usedAt,
  }))
}

export function setRecentModelsInStore(recent: RecentModelEntry[]): void {
  saveRecent(recent)
}

function loadLastModels(): Record<string, RecentModelEntry> {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  try {
    const raw = JSON.parse(fs.readFileSync(globalLastModelsPath(root), "utf8")) as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, RecentModelEntry>) : {}
  } catch {
    return {}
  }
}

/** 通道里「我自己」上一次用的模型；没有记录返回 undefined */
export function getLastModelFromStore(channelId: string): RecentModelEntry | undefined {
  const e = loadLastModels()[channelId]
  if (!e || typeof e.model !== "string" || !e.model.trim()) return undefined
  return {
    model: e.model,
    modelParams: e.modelParams ?? "",
    ...(e.resourceId ? { resourceId: e.resourceId } : {}),
    usedAt: e.usedAt,
  }
}

export function setLastModelInStore(channelId: string, entry: RecentModelEntry): void {
  const root = resolveDataDir()
  const target = globalLastModelsPath(root)
  const all = loadLastModels()
  all[channelId] = entry
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(all), "utf8")
  fs.renameSync(tmp, target)
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
  } catch {
    return undefined
  }
}

function mergeSessionInto(
  out: Record<string, SessionOverrideRecord>,
  sessionKey: string,
  patch: Partial<SessionOverrideRecord>,
): void {
  const prev = out[sessionKey]
  const merged = mergeRecord(prev, { ...patch, updatedAt: Math.max(prev?.updatedAt ?? 0, patch.updatedAt ?? 0) })
  if (!isRecordEmpty(merged)) out[sessionKey] = merged
}

/** 五旧文件 → 单文件 session-overrides.json（layout 迁移会再拆成 state.json） */
function ensureLegacyFiveFileMigrated(): void {
  if (legacyMigrationDone) return
  legacyMigrationDone = true
  const dir = sessionStateDir(resolveDataDir())
  const unified = path.join(dir, OVERRIDES_FILE_NAME)
  if (fs.existsSync(unified)) return

  const out: Record<string, SessionOverrideRecord> = {}
  let recent: RecentModelEntry[] = []

  type ModelRef = { model: string; modelParams?: string; resourceId?: string }
  const modelRaw = readJsonFile<{
    sessions?: Record<string, ModelRef & { updatedAt: number }>
    pending?: Record<string, ModelRef & { updatedAt: number }>
    recent?: RecentModelEntry[]
  }>(path.join(dir, "session-model-overrides.json"))
  if (modelRaw) {
    for (const [k, e] of Object.entries(modelRaw.sessions ?? {})) {
      if (!e?.model) continue
      mergeSessionInto(out, k, {
        model: e.model,
        modelParams: e.modelParams ?? "",
        ...(e.resourceId ? { resourceId: e.resourceId } : {}),
        updatedAt: e.updatedAt ?? Date.now(),
      })
    }
    for (const [k, e] of Object.entries(modelRaw.pending ?? {})) {
      if (!e?.model || out[k]?.model) continue
      mergeSessionInto(out, k, {
        model: e.model,
        modelParams: e.modelParams ?? "",
        ...(e.resourceId ? { resourceId: e.resourceId } : {}),
        updatedAt: e.updatedAt ?? Date.now(),
      })
    }
    if (Array.isArray(modelRaw.recent)) recent = modelRaw.recent
  }

  const resRaw = readJsonFile<{ sessions?: Record<string, { resourceId: string; updatedAt: number }> }>(
    path.join(dir, "session-resource-overrides.json"),
  )
  if (resRaw) {
    for (const [k, e] of Object.entries(resRaw.sessions ?? {})) {
      if (!e?.resourceId) continue
      mergeSessionInto(out, k, { resourceId: e.resourceId, updatedAt: e.updatedAt ?? Date.now() })
    }
  }

  const thinkRaw = readJsonFile<{ sessions?: Record<string, { level: string; updatedAt: number }> }>(
    path.join(dir, "session-thinking.json"),
  )
  if (thinkRaw) {
    for (const [k, e] of Object.entries(thinkRaw.sessions ?? {})) {
      if (!e?.level) continue
      mergeSessionInto(out, k, {
        thinkingLevel: e.level,
        updatedAt: e.updatedAt ?? Date.now(),
      })
    }
  }

  const sdkRaw = readJsonFile<
    Record<string, {
      agentId: string
      workspaceDir: string
      updatedAt: number
      rulesHash?: string
      daemonPort?: number
      streamCardId?: string
    }>
  >(path.join(dir, "sdk-resume-map.json"))
  if (sdkRaw) {
    for (const [k, e] of Object.entries(sdkRaw)) {
      if (!e?.agentId || !e.workspaceDir) continue
      mergeSessionInto(out, k, {
        agentId: e.agentId,
        workspaceDir: e.workspaceDir,
        ...(e.rulesHash ? { rulesHash: e.rulesHash } : {}),
        ...(e.daemonPort !== undefined ? { daemonPort: e.daemonPort } : {}),
        ...(e.streamCardId ? { streamCardId: e.streamCardId } : {}),
        updatedAt: e.updatedAt ?? Date.now(),
      })
    }
  }

  const piRaw = readJsonFile<
    Record<string, { rulesHash: string; daemonPort?: number; streamCardId?: string; updatedAt: number }>
  >(path.join(dir, "pi-resume-map.json"))
  if (piRaw) {
    for (const [k, e] of Object.entries(piRaw)) {
      if (!e?.rulesHash) continue
      mergeSessionInto(out, k, {
        rulesHash: e.rulesHash,
        ...(e.daemonPort !== undefined ? { daemonPort: e.daemonPort } : {}),
        ...(e.streamCardId ? { streamCardId: e.streamCardId } : {}),
        updatedAt: e.updatedAt ?? Date.now(),
      })
    }
  }

  const hadLegacy = LEGACY_FILES.some((f) => fs.existsSync(path.join(dir, f)))
  if (!hadLegacy && Object.keys(out).length === 0 && recent.length === 0) return

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, OVERRIDES_FILE_NAME), JSON.stringify({ sessions: out, recent }), "utf8")

  for (const f of LEGACY_FILES) {
    try {
      fs.unlinkSync(path.join(dir, f))
    } catch { /* ignore */ }
  }
}
