// ── 会话记忆：AI 自己记、自己读的「当前会话」笔记 ─────────────
// 存在会话目录里（memory.json），和账本无关：账本滚动、切供应商、resume 回退都不动它，只有重置 / 删会话才清。
// 写入走 daemon 的 lk-harness-memory 工具，读取在 Electron 拼首轮提示词时；两个进程各自按 root 读写同一个文件，
// 这里没有进程内状态。每次读写都是同步 fs，单进程内不会交错。

import * as fs from "node:fs"
import { JsonReadError, readJsonFile, writeJsonAtomic } from "./atomic-json.js"
import { ensureSessionEntry, sessionMemoryPath } from "./session-entry-paths.js"

export const MEMORY_LIMITS = {
  maxEntries: 20,
  maxKeyChars: 40,
  maxContentChars: 500,
} as const

export interface SessionMemoryEntry {
  key: string
  content: string
}

export type SessionMemoryResult<T> = ({ ok: true } & T) | { ok: false; error: string }

function isEntry(v: unknown): v is SessionMemoryEntry {
  if (!v || typeof v !== "object") return false
  const e = v as Record<string, unknown>
  return typeof e.key === "string" && !!e.key && typeof e.content === "string"
}

/** 没有记忆（或文件读不出来）返回空数组。损坏的文件 readJsonFile 已备份成 .corrupt-*，读不出来不能挡住一轮对话 */
export function readSessionMemory(root: string, sessionKey: string): SessionMemoryEntry[] {
  let raw: unknown
  try {
    raw = readJsonFile<unknown>(sessionMemoryPath(root, sessionKey), [])
  } catch (e: unknown) {
    if (e instanceof JsonReadError) return []
    throw e
  }
  return Array.isArray(raw) ? raw.filter(isEntry) : []
}

function persist(root: string, sessionKey: string, entries: SessionMemoryEntry[]): void {
  if (entries.length === 0) {
    clearSessionMemory(root, sessionKey)
    return
  }
  ensureSessionEntry(root, sessionKey)
  writeJsonAtomic(sessionMemoryPath(root, sessionKey), entries)
}

/** 同一个 key 覆盖更新，位置不变；超出上限直接报错，不静默截断 */
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
  if (at >= 0) entries[at] = { key: k, content: c }
  else entries.push({ key: k, content: c })
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

/** 首轮 `[本轮投递]` 里的 memory 字段：key → 内容；没有记忆返回 undefined（字段不出现） */
export function memoryForPrompt(entries: SessionMemoryEntry[]): Record<string, string> | undefined {
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map((e) => [e.key, e.content]))
}
