import * as fs from "node:fs"
import * as path from "node:path"
import { ensureSessionLayoutMigrated } from "./session-layout-migrate.js"
import {
  STATE_FILE,
  ensureSessionEntry,
  globalRecentPath,
  listSessionEntryDirPaths,
  readSessionKeyFromEntryDir,
  sessionEntryDir,
  sessionStatePath,
} from "./session-entry-paths.js"
import { sessionStateDir } from "./data-paths.js"

/** 单会话扁平记录：模型/供应商/推理 + SDK·Pi 续聊元数据（不含 senderOpenId） */
export interface SessionOverrideRecord {
  model?: string
  modelParams?: string
  resourceId?: string
  thinkingLevel?: string
  agentId?: string
  workspaceDir?: string
  rulesHash?: string
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

export function readOverridesSnapshot(): OverrideFile {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  const sessions: Record<string, SessionOverrideRecord> = {}
  for (const entryDir of listSessionEntryDirPaths(root)) {
    const statePath = path.join(entryDir, STATE_FILE)
    if (!fs.existsSync(statePath)) continue
    const rec = readStateFile(statePath)
    if (!rec) continue
    const sessionKey = readSessionKeyFromEntryDir(entryDir)
    if (!sessionKey) continue
    sessions[sessionKey] = rec
  }
  return { sessions, recent: loadRecent() }
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
    !r.model
    && !r.modelParams
    && !r.resourceId
    && !r.thinkingLevel
    && !r.agentId
    && !r.workspaceDir
    && !r.rulesHash
    && r.daemonPort === undefined
    && !r.streamCardId
  )
}

function resolveEntryDirForKey(sessionKey: string): { root: string; entryDir: string; canonicalKey: string } {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  const snap = readOverridesSnapshot()
  const storedKey = findStoredSessionKey(snap.sessions, sessionKey) ?? sessionKey
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
  const snap = readOverridesSnapshot()
  const key = findStoredSessionKey(snap.sessions, sessionKey)
  return key ? snap.sessions[key] : undefined
}

export function deleteSessionRecord(sessionKey: string): void {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  const snap = readOverridesSnapshot()
  const key = findStoredSessionKey(snap.sessions, sessionKey)
  if (!key) return
  const statePath = sessionStatePath(root, key)
  try {
    fs.unlinkSync(statePath)
  } catch { /* ignore */ }
}

export function clearSessionRecordFields(sessionKey: string, fields: (keyof SessionOverrideRecord)[]): void {
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
