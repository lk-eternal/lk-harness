// ── 会话记忆：AI 自己记、自己读的「当前会话」笔记 ─────────────
// 存在会话目录里（memory.json），和账本无关：账本滚动、切供应商、resume 回退都不动它，只有重置 / 删会话才清。
// 写入走 daemon 的 lk-harness-memory 工具，读取在 Electron 拼首轮提示词时；两个进程各自按 root 读写同一个文件，
// 这里没有进程内状态。每次读写都是同步 fs，单进程内不会交错。

import * as fs from "node:fs"
import { JsonReadError, readJsonFile, writeJsonAtomic } from "./atomic-json.js"
import { promptAttr, promptText, promptTime } from "./prompt-markup.js"
import { ensureSessionEntry, sessionMemoryPath } from "./session-entry-paths.js"

export const MEMORY_LIMITS = {
  maxEntries: 20,
  maxKeyChars: 40,
  maxContentChars: 500,
} as const

export interface SessionMemoryEntry {
  key: string
  content: string
  /** 第一次记下的时间（毫秒时间戳） */
  createdAt: number
  /** 最近一次改内容的时间（毫秒时间戳），没改过就等于 createdAt */
  updatedAt: number
}

/** 文件里的一条：key 和内容必有，时间是后加的字段，旧文件没有 */
interface StoredEntry {
  key: string
  content: string
  createdAt?: unknown
  updatedAt?: unknown
}

export type SessionMemoryResult<T> = ({ ok: true } & T) | { ok: false; error: string }

function isStoredEntry(v: unknown): v is StoredEntry {
  if (!v || typeof v !== "object") return false
  const e = v as Record<string, unknown>
  return typeof e.key === "string" && !!e.key && typeof e.content === "string"
}

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
}

/**
 * 没有记忆（或文件读不出来）返回空数组。损坏的文件 readJsonFile 已备份成 .corrupt-*，读不出来不能挡住一轮对话。
 * 旧文件的条目没有时间：用文件最后修改时间补，它只是「不晚于」的上界，不是真实时间；下一次写入会把补上的值固定下来。
 */
export function readSessionMemory(root: string, sessionKey: string): SessionMemoryEntry[] {
  const file = sessionMemoryPath(root, sessionKey)
  let raw: unknown
  try {
    raw = readJsonFile<unknown>(file, [])
  } catch (e: unknown) {
    if (e instanceof JsonReadError) return []
    throw e
  }
  if (!Array.isArray(raw)) return []
  const stored = raw.filter(isStoredEntry)
  const fileTime = stored.some((e) => !isTime(e.createdAt)) ? Math.floor(fs.statSync(file).mtimeMs) : 0
  return stored.map((e) => {
    const createdAt = isTime(e.createdAt) ? e.createdAt : fileTime
    return { key: e.key, content: e.content, createdAt, updatedAt: isTime(e.updatedAt) ? e.updatedAt : createdAt }
  })
}

function persist(root: string, sessionKey: string, entries: SessionMemoryEntry[]): void {
  if (entries.length === 0) {
    clearSessionMemory(root, sessionKey)
    return
  }
  ensureSessionEntry(root, sessionKey)
  writeJsonAtomic(sessionMemoryPath(root, sessionKey), entries)
}

/** 同一个 key 覆盖更新，位置不变，创建时间保留、修改时间更新；超出上限直接报错，不静默截断 */
export function saveSessionMemory(
  root: string,
  sessionKey: string,
  key: string,
  content: string,
): SessionMemoryResult<{ replaced: boolean; count: number }> {
  const k = key.trim()
  const c = content.trim()
  if (!k) return { ok: false, error: "key 不能为空" }
  if (k.length > MEMORY_LIMITS.maxKeyChars) return { ok: false, error: `key 太长（${k.length} 字，上限 ${MEMORY_LIMITS.maxKeyChars} 字）` }
  if (!c) return { ok: false, error: "content 不能为空；要删掉这条请用 memory_delete" }
  if (c.length > MEMORY_LIMITS.maxContentChars) {
    return { ok: false, error: `内容太长（${c.length} 字，上限 ${MEMORY_LIMITS.maxContentChars} 字）：精简，或拆成多条` }
  }
  const entries = readSessionMemory(root, sessionKey)
  const at = entries.findIndex((e) => e.key === k)
  if (at < 0 && entries.length >= MEMORY_LIMITS.maxEntries) {
    return { ok: false, error: `已经有 ${entries.length} 条（上限 ${MEMORY_LIMITS.maxEntries} 条）：先合并，或用 memory_delete 删掉不再需要的。现有 key：${entries.map((e) => e.key).join("、")}` }
  }
  const now = Date.now()
  const previous = at >= 0 ? entries[at] : undefined
  const entry: SessionMemoryEntry = { key: k, content: c, createdAt: previous?.createdAt ?? now, updatedAt: now }
  if (previous) entries[at] = entry
  else entries.push(entry)
  persist(root, sessionKey, entries)
  return { ok: true, replaced: at >= 0, count: entries.length }
}

export function deleteSessionMemory(root: string, sessionKey: string, key: string): SessionMemoryResult<{ count: number }> {
  const k = key.trim()
  const entries = readSessionMemory(root, sessionKey)
  const next = entries.filter((e) => e.key !== k)
  if (next.length === entries.length) {
    const keys = entries.length ? `现有 key：${entries.map((e) => e.key).join("、")}` : "当前会话还没有记忆"
    return { ok: false, error: `没有 key 为「${k}」的记忆。${keys}` }
  }
  persist(root, sessionKey, next)
  return { ok: true, count: next.length }
}

/** 只删文件，不为会话建目录：删会话时重置流程会调到这里，建回目录会让已删的会话以空目录的样子留在列表里 */
export function clearSessionMemory(root: string, sessionKey: string): void {
  fs.rmSync(sessionMemoryPath(root, sessionKey), { force: true })
}

/** 记忆给 AI 看的写法，每条一行 item：memory_read 和首轮的 memory 标签共用，格式只在这一处定 */
export function formatMemoryItems(entries: SessionMemoryEntry[]): string {
  return entries
    .map((e) => `<item key="${promptAttr(e.key)}" created="${promptTime(e.createdAt)}" updated="${promptTime(e.updatedAt)}">${promptText(e.content)}</item>`)
    .join("\n")
}
