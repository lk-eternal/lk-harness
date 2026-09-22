import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { resolve as resolvePath } from "node:path"
import { transcriptDir } from "./data-paths.js"
import { sessionStateDir } from "./data-paths.js"
import {
  CARRYOVER_FILE,
  MIRROR_FILE,
  PI_SUBDIR,
  QUEUE_SUBDIR,
  SDK_JSONL_SUBDIR,
  SESSION_KEY_FILE,
  STATE_FILE,
  ensureSessionEntry,
  globalCardQuestionsPath,
  globalCommandsDir,
  globalRecentPath,
  globalRoutingPath,
  layoutMarkerPath,
  legacyPiDirId,
  legacyQueueDirId,
  listSessionEntryDirPaths,
  normalizedSessionKey,
  readSessionKeyFromEntryDir,
  sessionCarryoverPath,
  sessionEntryDir,
  sessionEntryId,
  sessionGlobalDir,
  sessionMirrorPath,
} from "./session-entry-paths.js"
import type { RecentModelEntry, SessionOverrideRecord } from "./session-overrides-store.js"
import { OVERRIDES_FILE_NAME } from "./session-overrides-store.js"

const MIRROR_FILE_PREFIX = "transcript-"

function moveDirContents(from: string, to: string): void {
  if (!fs.existsSync(from)) return
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name)
    const dest = path.join(to, name)
    if (fs.existsSync(dest)) continue
    fs.renameSync(src, dest)
  }
  try {
    if (fs.readdirSync(from).length === 0) fs.rmdirSync(from)
  } catch { /* ignore */ }
}

function collectSessionKeys(root: string): Set<string> {
  const keys = new Set<string>()

  const unified = path.join(sessionStateDir(root), OVERRIDES_FILE_NAME)
  if (fs.existsSync(unified)) {
    try {
      const raw = JSON.parse(fs.readFileSync(unified, "utf8")) as { sessions?: Record<string, unknown> }
      for (const k of Object.keys(raw.sessions ?? {})) keys.add(normalizedSessionKey(k))
    } catch { /* ignore */ }
  }

  const legacyQueue = path.join(root, "file-queue")
  if (fs.existsSync(legacyQueue)) {
    for (const d of fs.readdirSync(legacyQueue)) {
      const dir = path.join(legacyQueue, d)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".qmsg") && !f.endsWith(".claimed")) continue
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { sessionKey?: string }
          if (parsed.sessionKey) keys.add(normalizedSessionKey(parsed.sessionKey))
        } catch { /* ignore */ }
      }
    }
  }

  const carryPath = path.join(transcriptDir(root), "carryover-pending.json")
  if (fs.existsSync(carryPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(carryPath, "utf8")) as { sessions?: Record<string, unknown> }
      for (const k of Object.keys(raw.sessions ?? {})) keys.add(normalizedSessionKey(k))
    } catch { /* ignore */ }
  }

  const wmPath = path.join(transcriptDir(root), "carryover-watermark.json")
  if (fs.existsSync(wmPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wmPath, "utf8")) as { sessions?: Record<string, unknown> }
      for (const k of Object.keys(raw.sessions ?? {})) keys.add(normalizedSessionKey(k))
    } catch { /* ignore */ }
  }

  try {
    for (const f of fs.readdirSync(transcriptDir(root))) {
      if (!f.startsWith(MIRROR_FILE_PREFIX) || !f.endsWith(".jsonl")) continue
      const b64 = f.slice(MIRROR_FILE_PREFIX.length, -".jsonl".length)
      try {
        const sk = Buffer.from(b64, "base64url").toString("utf8")
        if (sk) keys.add(normalizedSessionKey(sk))
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  for (const entry of listSessionEntryDirPaths(root)) {
    const sk = readSessionKeyFromEntryDir(entry)
    if (sk) keys.add(normalizedSessionKey(sk))
  }

  return keys
}

function workspaceStoreDirKey(workspaceDir: string): string {
  const cwd = resolvePath(workspaceDir)
  const sanitized = cwd.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (sanitized.length <= 120) return sanitized
  return createHash("sha256").update(workspaceDir).digest("hex").slice(0, 16)
}

function migrateLegacyCommands(root: string): void {
  fs.mkdirSync(globalCommandsDir(root), { recursive: true })
  const legacyRoot = path.join(root, "file-queue")
  if (!fs.existsSync(legacyRoot)) return
  let names: string[]
  try {
    names = fs.readdirSync(legacyRoot)
  } catch {
    return
  }
  for (const f of names) {
    if (!f.endsWith(".fcmd")) continue
    const src = path.join(legacyRoot, f)
    const dest = path.join(globalCommandsDir(root), f)
    if (fs.existsSync(dest)) continue
    try {
      fs.renameSync(src, dest)
    } catch { /* ignore */ }
  }
}

function migrateGlobalFiles(root: string): void {
  fs.mkdirSync(sessionGlobalDir(root), { recursive: true })
  const sessDir = sessionStateDir(root)

  const routingOld = path.join(sessDir, "session-routing.json")
  const routingNew = globalRoutingPath(root)
  if (fs.existsSync(routingOld) && !fs.existsSync(routingNew)) {
    fs.renameSync(routingOld, routingNew)
  }

  const cardOld = path.join(sessDir, "card-questions.json")
  const cardNew = globalCardQuestionsPath(root)
  if (fs.existsSync(cardOld) && !fs.existsSync(cardNew)) {
    fs.renameSync(cardOld, cardNew)
  }
}

function migrateOverridesToStateFiles(root: string): RecentModelEntry[] {
  const unified = path.join(sessionStateDir(root), OVERRIDES_FILE_NAME)
  let recent: RecentModelEntry[] = []
  if (!fs.existsSync(unified)) return recent

  const raw = JSON.parse(fs.readFileSync(unified, "utf8")) as {
    sessions?: Record<string, SessionOverrideRecord>
    recent?: RecentModelEntry[]
  }
  recent = Array.isArray(raw.recent) ? raw.recent : []

  for (const [sessionKey, rec] of Object.entries(raw.sessions ?? {})) {
    if (!rec) continue
    ensureSessionEntry(root, sessionKey)
    const statePath = path.join(sessionEntryDir(root, sessionKey), STATE_FILE)
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(statePath, JSON.stringify(rec), "utf8")
    }
  }

  try {
    fs.unlinkSync(unified)
  } catch { /* ignore */ }

  return recent
}

function migrateQueue(root: string, sessionKey: string): void {
  const legacyRoot = path.join(root, "file-queue")
  const legacySub = path.join(legacyRoot, legacyQueueDirId(sessionKey))
  const dest = path.join(sessionEntryDir(root, sessionKey), QUEUE_SUBDIR)
  moveDirContents(legacySub, dest)
}

function migrateMirror(root: string, sessionKey: string): void {
  const norm = normalizedSessionKey(sessionKey)
  const b64 = Buffer.from(norm, "utf8").toString("base64url")
  const legacy = path.join(transcriptDir(root), `${MIRROR_FILE_PREFIX}${b64}.jsonl`)
  const dest = sessionMirrorPath(root, sessionKey)
  if (fs.existsSync(legacy) && !fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(legacy, dest)
  }
}

interface SessionCarryoverFile {
  pending?: Record<string, unknown>
  mirrorWatermark?: { len: number; at: number }
}

function migrateCarryover(root: string, sessionKey: string): void {
  const dest = sessionCarryoverPath(root, sessionKey)
  if (fs.existsSync(dest)) return

  const out: SessionCarryoverFile = {}
  const carryPath = path.join(transcriptDir(root), "carryover-pending.json")
  if (fs.existsSync(carryPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(carryPath, "utf8")) as { sessions?: Record<string, unknown> }
      const norm = normalizedSessionKey(sessionKey)
      const pending = raw.sessions?.[sessionKey] ?? raw.sessions?.[norm]
      if (pending) out.pending = pending as Record<string, unknown>
    } catch { /* ignore */ }
  }

  const wmPath = path.join(transcriptDir(root), "carryover-watermark.json")
  if (fs.existsSync(wmPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wmPath, "utf8")) as {
        sessions?: Record<string, { len: number; at: number }>
      }
      const norm = normalizedSessionKey(sessionKey)
      const wm = raw.sessions?.[sessionKey] ?? raw.sessions?.[norm]
      if (wm) out.mirrorWatermark = wm
    } catch { /* ignore */ }
  }

  if (out.pending || out.mirrorWatermark) {
    ensureSessionEntry(root, sessionKey)
    fs.writeFileSync(dest, JSON.stringify(out), "utf8")
  }
}

function migratePi(root: string, sessionKey: string): void {
  const legacy = path.join(root, "pi-sessions", legacyPiDirId(sessionKey))
  const dest = path.join(sessionEntryDir(root, sessionKey), PI_SUBDIR)
  moveDirContents(legacy, dest)
}

function migrateSdkJsonl(root: string, sessionKey: string, rec?: SessionOverrideRecord): void {
  if (!rec?.workspaceDir) return
  const wsKey = workspaceStoreDirKey(rec.workspaceDir)
  const sessKey = sessionEntryId(sessionKey)
  const legacy = path.join(root, "sdk-jsonl-stores", wsKey, sessKey)
  const dest = path.join(sessionEntryDir(root, sessionKey), SDK_JSONL_SUBDIR)
  moveDirContents(legacy, dest)
}

function deleteEmptyLegacyTree(root: string, rel: string): void {
  const p = path.join(root, rel)
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch { /* ignore */ }
}

/** 只清 legacy 会话子目录（消息已迁到 sessions/{id}/queue/） */
function deleteLegacyFileQueueSessionDirs(root: string): void {
  const legacyRoot = path.join(root, "file-queue")
  if (!fs.existsSync(legacyRoot)) return
  try {
    for (const name of fs.readdirSync(legacyRoot)) {
      const full = path.join(legacyRoot, name)
      try {
        if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function deleteEmptyLegacyTrees(root: string): void {
  deleteLegacyFileQueueSessionDirs(root)
  for (const rel of ["pi-sessions", "sdk-jsonl-stores"]) {
    deleteEmptyLegacyTree(root, rel)
  }
  for (const f of ["carryover-pending.json", "carryover-watermark.json"]) {
    try {
      fs.unlinkSync(path.join(transcriptDir(root), f))
    } catch { /* ignore */ }
  }
}

let layoutDoneForRoot: string | null = null

/** 幂等：将会话相关数据迁入 sessions/{entryId}/ 扁平布局 */
export function ensureSessionLayoutMigrated(root: string): void {
  if (!root) return
  migrateLegacyCommands(root)
  if (layoutDoneForRoot === root && fs.existsSync(layoutMarkerPath(root))) return
  if (fs.existsSync(layoutMarkerPath(root))) {
    layoutDoneForRoot = root
    return
  }

  migrateGlobalFiles(root)
  const recent = migrateOverridesToStateFiles(root)

  fs.mkdirSync(sessionGlobalDir(root), { recursive: true })
  const recentPath = globalRecentPath(root)
  if (recent.length > 0 && !fs.existsSync(recentPath)) {
    fs.writeFileSync(recentPath, JSON.stringify(recent), "utf8")
  }

  const keys = collectSessionKeys(root)
  const stateByKey = new Map<string, SessionOverrideRecord>()
  for (const sessionKey of keys) {
    const statePath = path.join(sessionEntryDir(root, sessionKey), STATE_FILE)
    if (fs.existsSync(statePath)) {
      try {
        stateByKey.set(sessionKey, JSON.parse(fs.readFileSync(statePath, "utf8")) as SessionOverrideRecord)
      } catch { /* ignore */ }
    }
  }

  for (const sessionKey of keys) {
    ensureSessionEntry(root, sessionKey)
    migrateQueue(root, sessionKey)
    migrateMirror(root, sessionKey)
    migrateCarryover(root, sessionKey)
    migratePi(root, sessionKey)
    migrateSdkJsonl(root, sessionKey, stateByKey.get(sessionKey))
  }

  deleteEmptyLegacyTrees(root)

  fs.writeFileSync(layoutMarkerPath(root), `${Date.now()}\n`, "utf8")
  layoutDoneForRoot = root
}

export function resetSessionLayoutMigrationForTests(): void {
  layoutDoneForRoot = null
}
