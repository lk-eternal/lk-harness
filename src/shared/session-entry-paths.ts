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
/** 每个通道里「我自己」上一次用的模型，新建会话时拿来当默认模型 */
export const GLOBAL_LAST_MODELS_FILE = "last-models.json"
/** 聊天键 → 查到过的聊天名 / 用户名（重启后还能认出别人的会话是谁；daemon 不读它） */
export const GLOBAL_CHAT_NAMES_FILE = "chat-names.json"
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

/** routing.json 里主进程关心的两张表（其余字段如 messageSession 不暴露） */
export interface RoutingFileView {
  sessionToChat?: Record<string, string>
  chatType?: Record<string, string>
}

/** 文件刚改过的这段时间内不缓存：mtime 粒度粗（部分文件系统 1~2 秒）时，同大小的改写会被误认为没变 */
const ROUTING_CACHE_RACY_MS = 1500
const routingViewCache = new Map<string, { mtimeNs: bigint; size: bigint; view: RoutingFileView }>()

/**
 * 读 routing.json。文件由 daemon 写、体积可到几百 KB（messageSession 封顶 5000 条），
 * 会话列表每刷新一次每个通道都解析一遍很浪费；按 mtime + 大小缓存，文件没动就复用上次解析结果。
 * 返回的对象是缓存共享的，只读，调用方不要改。读不到或内容不是对象时返回 undefined。
 */
export function readRoutingFileView(root: string): RoutingFileView | undefined {
  const file = globalRoutingPath(root)
  let st: fs.BigIntStats
  try {
    st = fs.statSync(file, { bigint: true })
  } catch {
    routingViewCache.delete(file)
    return undefined
  }
  const hit = routingViewCache.get(file)
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) return hit.view
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    routingViewCache.delete(file)
    return undefined
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    routingViewCache.delete(file)
    return undefined
  }
  const { sessionToChat, chatType } = raw as RoutingFileView
  const view: RoutingFileView = { sessionToChat, chatType }
  const ageMs = Date.now() - Number(st.mtimeNs / 1_000_000n)
  if (ageMs > ROUTING_CACHE_RACY_MS) routingViewCache.set(file, { mtimeNs: st.mtimeNs, size: st.size, view })
  else routingViewCache.delete(file)
  return view
}

export function resetRoutingViewCacheForTests(): void {
  routingViewCache.clear()
}

export function globalRecentPath(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_RECENT_FILE)
}

export function globalLastModelsPath(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_LAST_MODELS_FILE)
}

export function globalChatNamesPath(root: string): string {
  return path.join(sessionGlobalDir(root), GLOBAL_CHAT_NAMES_FILE)
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
    const out: string[] = []
    // withFileTypes：目录项自带类型，不用再对每个目录 stat 一次（几千个会话目录时这一项就是几十毫秒）
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (isReservedSessionDirName(e.name)) continue
      const full = path.join(base, e.name)
      if (e.isDirectory()) {
        out.push(full)
      } else if (e.isSymbolicLink()) {
        // 链接 / 联接点：目录项不跟随，要 stat 才知道指向的是不是目录
        try {
          if (fs.statSync(full).isDirectory()) out.push(full)
        } catch { /* 断链 */ }
      }
    }
    return out
  } catch {
    return []
  }
}

/** 会话目录名 → 会话键（目录名就是键的哈希，键不会变；按根目录缓存） */
const entryKeyCache = new Map<string, Map<string, string>>()

/**
 * 磁盘上的会话目录及各自的会话键。
 * 目录集合没变时不重读 session-key.txt：读它是一个目录一次文件打开，几千个目录时每轮几百毫秒，
 * 而会话列表、会话管理页每隔几秒就要问一次。新出现的目录读一次后记住；
 * 读不出键的（刚建到一半、还没写 session-key.txt）不记，下次再读，不会因为缓存永远丢掉它。
 */
export function listSessionEntries(root: string): { dir: string; sessionKey: string }[] {
  const base = sessionStateDir(root)
  const prev = entryKeyCache.get(base)
  const next = new Map<string, string>()
  const out: { dir: string; sessionKey: string }[] = []
  for (const dir of listSessionEntryDirPaths(root)) {
    const name = path.basename(dir)
    const sessionKey = prev?.get(name) ?? readSessionKeyFromEntryDir(dir)
    if (!sessionKey) continue
    next.set(name, sessionKey)
    out.push({ dir, sessionKey })
  }
  entryKeyCache.set(base, next)
  return out
}

/** 测试用：清掉会话键缓存（测试会手写目录和 session-key.txt） */
export function resetSessionEntryKeyCacheForTests(): void {
  entryKeyCache.clear()
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
