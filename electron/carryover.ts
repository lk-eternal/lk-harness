import * as fs from "node:fs"
import * as path from "node:path"
import type { TranscriptTurn } from "./agent-engine/types"

/** 搬运块：最近原文轮次，一整块，不做摘要 */

export const CARRYOVER_TURNS = 10
export const CARRYOVER_CHARS = 8000

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

/** [宿主交付] JSON 里包着真用户正文；冷启动/唤醒类系统回合直接扔掉 */
function splitUserText(raw: string): string[] {
  const t = raw.trim()
  if (!t) return []
  if (t.startsWith("[冷启动]") || t.startsWith("[SESSION_RESUME")) return []
  const m = t.match(/\[宿主交付\]\s*```json\s*([\s\S]*?)```/)
  if (m) {
    try {
      const payload = JSON.parse(m[1]) as { messages?: { text?: string }[] }
      const out = (payload.messages ?? []).map((x) => x.text?.trim()).filter(Boolean) as string[]
      if (out.length > 0) return out
    } catch { /* 非法 JSON 则当普通正文 */ }
  }
  return [t]
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

export function buildCarryoverBlock(turns: TranscriptTurn[], fromLabel: string, toLabel: string): string {
  const lines = [
    `[历史搬运 · 从 ${fromLabel} → ${toLabel} · 共 ${turns.length} 轮]`,
    ...turns.flatMap((t) => [`[${t.role === "user" ? "用户" : "助手"}] ${t.text}`]),
    `[搬运结束] 基于以上继续，直接干活，不要复述搬运内容。`,
  ]
  return lines.join("\n")
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

function mirrorPath(sessionKey: string): string {
  const safe = Buffer.from(sessionKey, "utf8").toString("base64url")
  return path.join(resolveDataDir(), `${MIRROR_FILE_PREFIX}${safe}.jsonl`)
}

/** 回合结束记一笔（用户轮 + 助手轮）；失败只记用户轮 */
export function appendMirrorTurns(sessionKey: string, turns: TranscriptTurn[]): void {
  const fresh = turns.filter((t) => t.text?.trim()).map((t) => ({ role: t.role, text: t.text.trim(), at: Date.now() }))
  if (fresh.length === 0) return
  try {
    const dir = resolveDataDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const p = mirrorPath(sessionKey)
    const prev: string[] = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()) : []
    const next = [...prev, ...fresh.map((t) => JSON.stringify(t))].slice(-MIRROR_KEEP_TURNS)
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
          const r = JSON.parse(l) as { role?: unknown; text?: unknown }
          if ((r.role === "user" || r.role === "assistant") && typeof r.text === "string" && r.text.trim()) {
            return [{ role: r.role, text: r.text.trim() }]
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

/** 老账本回填合并：镜像在先，老账本去重（按 原文精确匹配）后拼前面 */
export function mergeLegacyTurns(legacy: TranscriptTurn[], mirror: TranscriptTurn[]): TranscriptTurn[] {
  if (mirror.length === 0) return legacy
  if (legacy.length === 0) return mirror
  const seen = new Set(mirror.map((t) => `${t.role}\0${t.text}`))
  return [...legacy.filter((t) => !seen.has(`${t.role}\0${t.text}`)), ...mirror]
}

// ── 待消费搬运（磁盘交接：切换与下次拉起解耦，单次消费，7 天过期）──

interface PendingCarryover {
  block: string
  turns: number
  fromLabel: string
  toLabel: string
  at: number
}

interface CarryoverFile {
  sessions: Record<string, PendingCarryover>
}

const FILE_NAME = "carryover-pending.json"
const CARRYOVER_TTL_MS = 7 * 24 * 60 * 60 * 1000

let dataDir: string | null = null
let cache: CarryoverFile | null = null

export function initCarryoverStore(dir: string): void {
  dataDir = dir
  cache = null
}

export function resetCarryoverStoreForTests(): void {
  dataDir = null
  cache = null
}

function resolveDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR
  throw new Error("carryover-store: data dir not initialized")
}

function storePath(): string {
  return path.join(resolveDataDir(), FILE_NAME)
}

function load(): CarryoverFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as CarryoverFile
    cache = { sessions: raw.sessions ?? {} }
  } catch {
    cache = { sessions: {} }
  }
  // 读时顺手清过期
  const now = Date.now()
  let swept = false
  for (const [k, v] of Object.entries(cache.sessions)) {
    if (!v || now - (v.at ?? 0) > CARRYOVER_TTL_MS) { delete cache.sessions[k]; swept = true }
  }
  if (swept) save()
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

export function stashCarryover(sessionKey: string, entry: Omit<PendingCarryover, "at">): void {
  const s = load()
  s.sessions[sessionKey] = { ...entry, at: Date.now() }
  save()
}

/** 读取并删除；无则返回 undefined */
export function consumeCarryover(sessionKey: string): PendingCarryover | undefined {
  const s = load()
  const e = s.sessions[sessionKey]
  if (!e) return undefined
  delete s.sessions[sessionKey]
  save()
  return e
}
