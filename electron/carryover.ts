import * as fs from "node:fs"
import * as path from "node:path"
import { ensureSessionLayoutMigrated } from "../src/shared/session-layout-migrate.js"
import {
  ensureSessionEntry,
  sessionCarryoverPath,
  sessionMirrorPath,
} from "../src/shared/session-entry-paths.js"
import type { TranscriptTurn } from "./agent-engine/types"

/** 搬运块：最近原文轮次，一整块，不做摘要 */

export const CARRYOVER_TURNS = 30
export const CARRYOVER_CHARS = 128 * 1024
export const MIRROR_MAX_BYTES = 128 * 1024

interface PiContentBlock {
  type?: string
  text?: string
}

interface PiMessage {
  role?: string
  content?: string | PiContentBlock[]
}

function textOfContent(content: PiMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && b.text?.trim())
    .map((b) => b.text!.trim())
    .join("\n")
}

/** [本轮投递] JSON 里包着真用户正文；冷启动/唤醒类系统回合直接扔掉 */
function splitUserText(raw: string): string[] {
  const t = raw.trim()
  if (!t) return []
  if (t.startsWith("[冷启动]") || t.startsWith("[SESSION_RESUME")) return []
  const m = t.match(/\[本轮投递\]\s*```json\s*([\s\S]*?)```/)
  if (m) {
    try {
      const payload = JSON.parse(m[1]) as { messages?: { text?: string }[] }
      const out = (payload.messages ?? []).map((x) => x.text?.trim()).filter(Boolean) as string[]
      if (out.length > 0) return out
    } catch { /* 非法 JSON 则当普通正文 */ }
  }
  return [t]
}

/** 账本口径：物理 Pi 消息数（1 个 prompt = 1 轮，不展开[本轮投递]；搬运重放不再算负债） */
export function countPiPhysicalTurns(messages: PiMessage[]): number {
  let n = 0
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue
    if (!textOfContent(msg.content).trim()) continue
    n += 1
  }
  return n
}

/** pi 消息（live 或 jsonl 落盘）→ 正文轮次：跳过工具块与报错空回合 */
export function turnsFromPiMessages(messages: PiMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue
    const text = textOfContent(msg.content)
    if (!text) continue
    if (msg.role === "assistant") {
      turns.push({ role: "assistant", text })
    } else {
      for (const part of splitUserText(text)) turns.push({ role: "user", text: part })
    }
  }
  return turns
}

/** 取最近 N 轮（总字符封顶，超了砍最旧的） */
export function takeLastTurns(turns: TranscriptTurn[], maxTurns = CARRYOVER_TURNS, maxChars = CARRYOVER_CHARS): TranscriptTurn[] {
  const tail = turns.slice(-maxTurns)
  let chars = 0
  const out: TranscriptTurn[] = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i]
    if (out.length > 0 && chars + t.text.length > maxChars) break
    out.unshift(t)
    chars += t.text.length
  }
  return out
}

/** 流式段里取正文（搬运镜像用；结构化入参，不依赖 stream-card 运行时） */
export function replyTexts(segments: { type?: string; text?: string }[]): string[] {
  return (segments ?? [])
    .filter((s) => s && s.type === "reply" && s.text?.trim())
    .map((s) => s.text!.trim())
}

// ── 逐回合镜像（双引擎统一 transcript 源：用户原文 + 助手正文，落盘 JSONL）──

const MIRROR_FILE_PREFIX = "transcript-"
/** 滚动存储：只留最近 N 轮，切了直接整包注入，不用临时提取 */
const MIRROR_KEEP_TURNS = CARRYOVER_TURNS

function trimMirrorLines(lines: string[], maxTurns: number, maxBytes: number): string[] {
  let next = lines.slice(-maxTurns)
  while (next.length > 0 && Buffer.byteLength(`${next.join("\n")}\n`, "utf8") > maxBytes) {
    next = next.slice(1)
  }
  return next
}

function mirrorPath(sessionKey: string): string {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  ensureSessionEntry(root, sessionKey)
  return sessionMirrorPath(root, sessionKey)
}

/** 回合结束记一笔（用户轮 + 助手轮，含引用）；失败只记用户轮 */
export function appendMirrorTurns(sessionKey: string, turns: TranscriptTurn[]): void {
  const fresh = turns.filter((t) => t.text?.trim()).map((t) => ({ role: t.role, text: t.text.trim(), ...(t.quoted_message ? { quoted_message: t.quoted_message } : {}), at: Date.now() }))
  if (fresh.length === 0) return
  try {
    const p = mirrorPath(sessionKey)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const prev: string[] = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()) : []
    const next = trimMirrorLines(
      [...prev, ...fresh.map((t) => JSON.stringify(t))],
      MIRROR_KEEP_TURNS,
      MIRROR_MAX_BYTES,
    )
    fs.writeFileSync(p, next.join("\n") + "\n", "utf8")
  } catch { /* 镜像失败不影响正事 */ }
}

export function readMirrorTurns(sessionKey: string): TranscriptTurn[] {
  try {
    const p = mirrorPath(sessionKey)
    if (!fs.existsSync(p)) return []
    return fs.readFileSync(p, "utf8").split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          const r = JSON.parse(l) as { role?: unknown; text?: unknown; quoted_message?: TranscriptTurn["quoted_message"] }
          if ((r.role === "user" || r.role === "assistant") && typeof r.text === "string" && r.text.trim()) {
            return [{ role: r.role, text: r.text.trim(), ...(r.quoted_message ? { quoted_message: r.quoted_message } : {}) }]
          }
        } catch { /* 坏行跳过 */ }
        return []
      })
  } catch { return [] }
}

export function clearMirror(sessionKey: string): void {
  try {
    const p = mirrorPath(sessionKey)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch { /* ignore */ }
}

/** 老账本回填合并：镜像在先，老账本去重（原文 + 引用 id 精确匹配）后拼前面 */
export function mergeLegacyTurns(legacy: TranscriptTurn[], mirror: TranscriptTurn[]): TranscriptTurn[] {
  if (mirror.length === 0) return legacy
  if (legacy.length === 0) return mirror
  const keyOf = (t: TranscriptTurn) => `${t.role}\0${t.text}\0${t.quoted_message?.message_id ?? ""}`
  const seen = new Set(mirror.map(keyOf))
  return [...legacy.filter((t) => !seen.has(keyOf(t))), ...mirror]
}

// ── 待消费搬运（磁盘交接：切换与下次拉起解耦，单次消费，7 天过期）──

interface PendingCarryover {
  turns: number
  fromLabel: string
  toLabel: string
  at: number
  /** 结构化历史：首轮拼进 messages */
  history: TranscriptTurn[]
  /** 建块时的源/目标账本：切出零聊天回原时凭此丢弃过期块 */
  fromLedger?: string
  toLedger?: string
  /** 建块时的源/目标供应商（老数据兼容） */
  fromResourceId?: string
  toResourceId?: string
}

/** 同 sessionKey：跨供应商待搬运 + mirror 行数水位（切供应商后只取水位之后新增） */
interface SessionCarryoverFile {
  pending?: PendingCarryover
  mirrorWatermark?: { len: number; at: number }
}

const CARRYOVER_TTL_MS = 7 * 24 * 60 * 60 * 1000

let dataDir: string | null = null

export function initCarryoverStore(dir: string): void {
  dataDir = dir
  ensureSessionLayoutMigrated(dir)
}

export function resetCarryoverStoreForTests(): void {
  dataDir = null
}

function resolveDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR
  throw new Error("carryover-store: data dir not initialized")
}

function readCarryoverFile(sessionKey: string): SessionCarryoverFile {
  const root = resolveDataDir()
  ensureSessionLayoutMigrated(root)
  const p = sessionCarryoverPath(root, sessionKey)
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SessionCarryoverFile
  } catch {
    return {}
  }
}

function writeCarryoverFile(sessionKey: string, data: SessionCarryoverFile): void {
  const root = resolveDataDir()
  ensureSessionEntry(root, sessionKey)
  const target = sessionCarryoverPath(root, sessionKey)
  if (!data.pending && !data.mirrorWatermark) {
    try {
      fs.unlinkSync(target)
    } catch { /* ignore */ }
    return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8")
  fs.renameSync(tmp, target)
}

function sweepExpiredPending(sessionKey: string, file: SessionCarryoverFile): SessionCarryoverFile {
  const p = file.pending
  if (!p) return file
  if (Date.now() - (p.at ?? 0) > CARRYOVER_TTL_MS) {
    const next = { ...file }
    delete next.pending
    writeCarryoverFile(sessionKey, next)
    return next
  }
  return file
}

export function stashCarryover(sessionKey: string, entry: Omit<PendingCarryover, "at">): void {
  const file = readCarryoverFile(sessionKey)
  file.pending = { ...entry, at: Date.now() }
  writeCarryoverFile(sessionKey, file)
}

/** 预览不删除；拉起成功后才 consume，失败保留 */
export function peekCarryover(sessionKey: string): PendingCarryover | undefined {
  const file = sweepExpiredPending(sessionKey, readCarryoverFile(sessionKey))
  const e = file.pending
  if (!e) return undefined
  return { ...e }
}

/** 读取并删除 pending；mirrorWatermark 保留 */
export function consumeCarryover(sessionKey: string): PendingCarryover | undefined {
  const file = readCarryoverFile(sessionKey)
  const e = file.pending
  if (!e) return undefined
  const next = { ...file }
  delete next.pending
  writeCarryoverFile(sessionKey, next)
  return e
}

export function clearSessionCarryover(sessionKey: string): void {
  try {
    fs.unlinkSync(sessionCarryoverPath(resolveDataDir(), sessionKey))
  } catch { /* ignore */ }
}

/** 待搬运历史轮次：只认结构化 history，无即无单 */
export function pendingHistoryTurns(pending: PendingCarryover): TranscriptTurn[] {
  return (pending.history ?? []).filter((t) => t.text?.trim())
}

export function getMirrorWatermark(sessionKey: string): number | undefined {
  return readCarryoverFile(sessionKey).mirrorWatermark?.len
}

export function setMirrorWatermark(sessionKey: string, len: number): void {
  const file = readCarryoverFile(sessionKey)
  file.mirrorWatermark = { len, at: Date.now() }
  writeCarryoverFile(sessionKey, file)
}
