import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { normalizeSessionKey } from "./channel-types.js"
import { sessionStateDir } from "./data-paths.js"

export const SESSION_GLOBAL_DIR = "_global"
export const SESSION_KEY_FILE = "session-key.txt"
export const STATE_FILE = "state.json"
export const CARRYOVER_FILE = "carryover.json"
export const MIRROR_FILE = "mirror.jsonl"
export const QUEUE_SUBDIR = "queue"
export const PI_SUBDIR = "pi"
export const SDK_JSONL_SUBDIR = "sdk-jsonl"
export const LAYOUT_MARKER = ".layout-v2"

export const GLOBAL_ROUTING_FILE = "routing.json"
export const GLOBAL_RECENT_FILE = "recent.json"
export const GLOBAL_CARD_QUESTIONS_FILE = "card-questions.json"
export const GLOBAL_COMMANDS_SUBDIR = "commands"

export function normalizedSessionKey(sessionKey: string): string {
  return normalizeSessionKey(sessionKey) || sessionKey
}

export function sessionEntryId(sessionKey: string): string {
  const norm = normalizedSessionKey(sessionKey)
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16)
}

/** 旧 file-queue 子目录名（迁移用） */
export function legacyQueueDirId(sessionKey: string): string {
  const norm = normalizedSessionKey(sessionKey)
  return createHash("md5").update(norm).digest("hex").slice(0, 16)
}

/** 旧 pi-sessions 子目录名（迁移用） */
export function legacyPiDirId(sessionKey: string): string {
  const norm = normalizedSessionKey(sessionKey)
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 32)
}

export function isReservedSessionDirName(name: string): boolean {
  return name === SESSION_GLOBAL_DIR || name.startsWith(".")
}

export function sessionGlobalDir(root: string): string {
  return path.join(sessionStateDir(root), SESSION_GLOBAL_DIR)
}

export function globalRoutingPath(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_ROUTING_FILE)
}

export function globalRecentPath(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_RECENT_FILE)
}

export function globalCardQuestionsPath(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_CARD_QUESTIONS_FILE)
}

export function globalCommandsDir(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_COMMANDS_SUBDIR)
}

export function ensureGlobalCommandsDir(root: string): string {
  const dir = globalCommandsDir(root)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function layoutMarkerPath(root: string): string {
  return path.join(sessionStateDir(root), LAYOUT_MARKER)
}

export function sessionEntryDir(root: string, sessionKey: string): string {
  return path.join(sessionStateDir(root), sessionEntryId(sessionKey))
}

export function sessionStatePath(root: string, sessionKey: string): string {
  return path.join(sessionEntryDir(root, sessionKey), STATE_FILE)
}

export function sessionQueueDir(root: string, sessionKey: string): string {
  return path.join(sessionEntryDir(root, sessionKey), QUEUE_SUBDIR)
}

export function sessionMirrorPath(root: string, sessionKey: string): string {
  return path.join(sessionEntryDir(root, sessionKey), MIRROR_FILE)
}

export function sessionCarryoverPath(root: string, sessionKey: string): string {
  return path.join(sessionEntryDir(root, sessionKey), CARRYOVER_FILE)
}

export function sessionPiDir(root: string, sessionKey: string): string {
  return path.join(sessionEntryDir(root, sessionKey), PI_SUBDIR)
}

export function sessionSdkJsonlDir(root: string, sessionKey: string): string {
  return path.join(sessionEntryDir(root, sessionKey), SDK_JSONL_SUBDIR)
}

export function ensureSessionEntry(root: string, sessionKey: string): string {
  const dir = sessionEntryDir(root, sessionKey)
  fs.mkdirSync(path.join(dir, QUEUE_SUBDIR), { recursive: true })
  const keyFile = path.join(dir, SESSION_KEY_FILE)
  const norm = normalizedSessionKey(sessionKey)
  fs.writeFileSync(keyFile, norm, "utf8")
  return dir
}

export function readSessionKeyFromEntryDir(entryDir: string): string | undefined {
  try {
    const t = fs.readFileSync(path.join(entryDir, SESSION_KEY_FILE), "utf8").trim()
    return t || undefined
  } catch {
    return undefined
  }
}

export function listSessionEntryDirPaths(root: string): string[] {
  const base = sessionStateDir(root)
  try {
    return fs
      .readdirSync(base)
      .filter((d) => !isReservedSessionDirName(d))
      .map((d) => path.join(base, d))
      .filter((full) => {
        try {
          return fs.statSync(full).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

export function listSessionQueueDirs(root: string): string[] {
  const out: string[] = []
  for (const entry of listSessionEntryDirPaths(root)) {
    const q = path.join(entry, QUEUE_SUBDIR)
    if (fs.existsSync(q)) out.push(q)
  }
  return out
}

export function purgeSessionEntry(root: string, sessionKey: string): void {
  const dir = sessionEntryDir(root, sessionKey)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}
