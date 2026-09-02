import { readLockFile, httpPost } from "./daemon-client"
import { resolveChannelForSession } from "./config-store"
import { pushUiLog } from "./ui-logger"

export interface StreamToolEntry {
  callId: string
  name: string
  status: "running" | "completed" | "error"
  summary: string
  startedAt?: number
  ms?: number
}

export type StreamSegment =
  | { type: "thinking"; text: string; startedAt?: number; ms?: number }
  | { type: "tools"; tools: StreamToolEntry[] }
  | { type: "reply"; text: string }
  | { type: "todos"; items: StreamTodoItem[] }

export interface StreamTodoItem {
  id?: string
  content: string
  status: string
}

export interface StreamAgg {
  segments: StreamSegment[]
  dirty: boolean
  timer: ReturnType<typeof setTimeout> | null
  ensured: boolean
  cardId?: string
  lastFlushAt: number
  inflight: Promise<void>
  finished: boolean
  gateOpen: boolean
  forceNewThinking: boolean
  /** 断线挂起：刷帧但不 finish，Resume 后续写同卡 */
  suspended?: boolean
  bornAt: number
}

export interface StreamCardPayload {
  segments: Array<
    | { type: "thinking"; text: string; ms?: number }
    | { type: "tools"; tools: { name: string; status: string; summary?: string; ms?: number }[] }
    | { type: "reply"; text: string }
    | { type: "todos"; items: { content: string; status: string }[] }
  >
}

export interface StreamPollPhaseState {
  blocking: boolean
  nonBlocking: boolean
  questionPause: boolean
}

export interface StreamCardHost {
  sessionKey: string
  streamAgg: StreamAgg | null
  pollPhase: StreamPollPhaseState
  seenMessageIds: Set<string>
  /** SDK todos 跨换卡快照 */
  todoSnapshot?: StreamTodoItem[] | null
  /** Resume 持久化 cardId（SDK/LLM 各自实现） */
  patchStreamCardId?: (cardId: string | undefined, opts?: { onlyIf?: string }) => void
}

export interface PollPhaseEventPayload {
  blocking?: boolean
  reason?: string
  messageIds?: string[]
  directive?: string
}

const STREAM_FLUSH_MS = 400
const STREAM_MIN_INTERVAL_MS = 200
const STREAM_THINKING_TAIL = 1500
const MAX_STREAM_TOOL_STEPS = 40
const TOOL_ARG_SUMMARY_KEYS = [
  "command", "path", "target_notebook", "pattern", "glob_pattern", "file_path",
  "image_path", "url", "query", "question", "text", "description", "name",
  "toolName", "tool_name", "serverName", "server",
]
const TOOL_SUMMARY_MAX = 120
const POLL_DIRECTIVE_END_MARK = "安静退出"
const POLL_DIRECTIVE_TIMEOUT_MARK = "轮询正常超时"
const OUTBOUND_MCP_RE = /^(?:send_(?:text|question|image|file)|project_\w+)$/i
const MEDIA_MCP_RE = /^send_(?:file|image)$/i

export { POLL_DIRECTIVE_END_MARK, POLL_DIRECTIVE_TIMEOUT_MARK }

export function isFeishuStreamEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return !!ch && ch.type === "feishu" && ch.showThinking !== false
}

function isShowThinkingEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return ch?.showThinking !== false
}

export { isShowThinkingEnabled }

export function newStreamAgg(gateOpen = false): StreamAgg {
  return {
    segments: [],
    dirty: false,
    timer: null,
    ensured: false,
    lastFlushAt: 0,
    inflight: Promise.resolve(),
    finished: false,
    gateOpen,
    forceNewThinking: false,
    suspended: false,
    bornAt: Date.now(),
  }
}

function dropEmptyTail(stream: StreamAgg): void {
  while (stream.segments.length) {
    const last = stream.segments[stream.segments.length - 1]
    if (last.type === "thinking" && !last.text.trim()) { stream.segments.pop(); continue }
    if (last.type === "reply" && !last.text.trim()) { stream.segments.pop(); continue }
    if (last.type === "tools" && !last.tools.length) { stream.segments.pop(); continue }
    break
  }
}

export function sealLastThinking(stream: StreamAgg): void {
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type !== "thinking" || last.ms != null) return
  last.ms = last.startedAt != null ? Date.now() - last.startedAt : 0
}

export function sealAllThinking(agg: StreamAgg): void {
  for (const seg of agg.segments) {
    if (seg.type !== "thinking") continue
    if (seg.ms != null || seg.startedAt == null) continue
    seg.ms = Date.now() - seg.startedAt
  }
}

/** 已结束的 thinking 段写入固定 ms，避免后续 flush 继续涨表 */
export function sealClosedThinking(agg: StreamAgg): void {
  const last = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type !== "thinking") continue
    if (seg.ms != null || seg.startedAt == null) continue
    if (i === last) continue
    seg.ms = Date.now() - seg.startedAt
  }
}

export function sealRunningTools(agg: StreamAgg): void {
  for (const seg of agg.segments) {
    if (seg.type !== "tools") continue
    for (const t of seg.tools) {
      if (t.status !== "running") continue
      t.status = "completed"
      if (t.startedAt != null) t.ms = Date.now() - t.startedAt
    }
  }
}

export function enqueueThinking(stream: StreamAgg, text: string): void {
  if (!text) return
  dropEmptyTail(stream)
  if (stream.forceNewThinking) {
    stream.forceNewThinking = false
    sealLastThinking(stream)
    stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
    stream.dirty = true
    return
  }
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type === "thinking" && last.ms == null) {
    last.text += text
    stream.dirty = true
    return
  }
  if (last?.type === "thinking") {
    stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
    stream.dirty = true
    return
  }
  sealLastThinking(stream)
  stream.segments.push({ type: "thinking", text, startedAt: Date.now() })
  stream.dirty = true
}

/** 入队正文：与上一块 reply 合并，否则新开 */
export function enqueueReply(stream: StreamAgg, text: string): void {
  if (!text) return
  dropEmptyTail(stream)
  sealLastThinking(stream)
  const last = stream.segments[stream.segments.length - 1]
  if (last?.type === "reply") {
    last.text += text
    stream.dirty = true
    return
  }
  stream.segments.push({ type: "reply", text })
  stream.dirty = true
}

export function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  let text = ""
  for (const key of TOOL_ARG_SUMMARY_KEYS) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) { text = v.trim(); break }
  }
  if (!text) {
    const nested = mcpCallPayload(args).inner
    if (nested) text = summarizeToolArgs(nested)
  }
  if (!text) {
    try { text = JSON.stringify(rec) } catch { return "" }
    if (text === "{}") return ""
  }
  text = text.replace(/\s+/g, " ")
  return text.length > TOOL_SUMMARY_MAX ? `${text.slice(0, TOOL_SUMMARY_MAX)}…` : text
}

function mcpCallPayload(args: unknown): { tool?: string; server?: string; inner?: Record<string, unknown> } {
  if (!args || typeof args !== "object") return {}
  const rec = args as Record<string, unknown>
  let tool: string | undefined
  for (const key of ["tool", "toolName", "tool_name"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) { tool = v.trim(); break }
  }
  const server = (typeof rec.serverName === "string" ? rec.serverName
    : typeof rec.server === "string" ? rec.server : undefined)?.trim()
  const inner = rec.args && typeof rec.args === "object" && !Array.isArray(rec.args)
    ? rec.args as Record<string, unknown>
    : undefined
  return { tool, server, inner }
}

function formatPrefixedMcpToolName(raw: string): string | null {
  const name = raw.trim()
  if (!name || name === "mcp") return null

  if (name.startsWith("mcp__")) {
    const rest = name.slice(5)
    const idx = rest.indexOf("_")
    if (idx > 0) return `${rest.slice(0, idx)} · ${rest.slice(idx + 1)}`
  }

  const knownServers = ["lk-harness-admin", "lk-harness"]
  for (const srv of knownServers.sort((a, b) => b.length - a.length)) {
    const prefix = `${srv}_`
    if (name.startsWith(prefix)) return `${srv} · ${name.slice(prefix.length)}`
  }

  const idx = name.indexOf("_")
  if (idx > 0 && idx < name.length - 1) {
    return `${name.slice(0, idx)} · ${name.slice(idx + 1)}`
  }
  return null
}

function bareToolNameFromDisplay(name: string, args?: unknown): string {
  const fromArgs = mcpToolName(args)
  if (fromArgs) return fromArgs
  const formatted = formatPrefixedMcpToolName(name)
  if (formatted) {
    const sep = formatted.indexOf(" · ")
    if (sep >= 0) return formatted.slice(sep + 3)
  }
  return name.trim()
}

function resolveToolDisplayName(name: string, args: unknown): string {
  const raw = name.trim()
  const isTask = /^task$/i.test(raw) || /^task\b/i.test(raw)
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>
    if (isTask) {
      const desc = typeof rec.description === "string" ? rec.description.trim()
        : typeof rec.prompt === "string" ? rec.prompt.trim().slice(0, 80) : ""
      const sub = typeof rec.subagent_type === "string" ? rec.subagent_type.trim() : ""
      return desc ? `🤖 Subagent · ${desc}` : sub ? `🤖 Subagent · ${sub}` : "🤖 Subagent"
    }
    for (const key of ["tool", "toolName", "tool_name", "name"]) {
      const v = rec[key]
      if (typeof v === "string" && v.trim()) {
        const server = typeof rec.serverName === "string" ? rec.serverName
          : typeof rec.server === "string" ? rec.server : ""
        return server ? `${server} · ${v.trim()}` : v.trim()
      }
    }
    if (/^mcp$/i.test(raw)) {
      if (typeof rec.action === "string" && rec.action.trim()) {
        const server = typeof rec.server === "string" ? rec.server.trim() : ""
        return server ? `mcp · ${rec.action.trim()} (${server})` : `mcp · ${rec.action.trim()}`
      }
      if (typeof rec.connect === "string" && rec.connect.trim()) return `mcp · connect (${rec.connect.trim()})`
      if (rec.search !== undefined) return "mcp · search"
    }
  }
  const prefixed = formatPrefixedMcpToolName(raw)
  if (prefixed) return prefixed
  return isTask ? "🤖 Subagent" : raw
}

function mcpToolName(args: unknown): string {
  return mcpCallPayload(args).tool ?? ""
}

function shellCommandText(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  return ""
}

function isPollMessageInvocation(name: string, summary: string, args?: unknown): boolean {
  const cmd = shellCommandText(args)
  if (cmd && /poll-message/i.test(cmd)) return true
  if (mcpToolName(args)) return false
  return /poll-message/i.test(summary)
}

/** 仅阻塞 poll 才换卡。必须看完整 command（摘要 120 字会裁掉 wait=false） */
export function isBlockingPollMessage(name: string, summary: string, args?: unknown): boolean {
  if (!isPollMessageInvocation(name, summary, args)) return false
  const full = shellCommandText(args) || summary
  if (/wait\s*=\s*false/i.test(full)) return false
  if (/["']wait["']\s*:\s*false/i.test(full)) return false
  if (/wait%3[Dd]false/i.test(full)) return false
  return true
}

export function isPollMessageTool(name: string, summary: string, args?: unknown): boolean {
  return isPollMessageInvocation(name, summary, args)
}

export function shouldOmitFromStreamCard(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return OUTBOUND_MCP_RE.test(mcp)
  if (OUTBOUND_MCP_RE.test(name.trim())) return true
  if (isPollMessageInvocation(name, summary, args)) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:text|question|image|file)/i.test(cmd)
}

export function isMediaSendInvocation(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return MEDIA_MCP_RE.test(mcp)
  if (MEDIA_MCP_RE.test(name.trim())) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:file|image)/i.test(cmd)
}

export function isSendQuestionInvocation(name: string, summary: string, args?: unknown): boolean {
  const mcp = mcpToolName(args)
  if (mcp) return /^send_question$/i.test(mcp)
  if (/^send_question$/i.test(name.trim())) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-question/i.test(cmd)
}

function isTodoUpdateInvocation(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[_-]/g, "")
  return n === "updatetodos" || n === "todowrite" || n === "writetodos"
}

function normalizeTodoStatus(s: unknown): string {
  const n = String(s ?? "").trim().replace(/[-_\s]/g, "").toLowerCase()
  if (n === "inprogress") return "in_progress"
  if (n === "completed" || n === "done") return "completed"
  if (n === "cancelled" || n === "canceled") return "cancelled"
  return "pending"
}

export function applyTodoUpdate(host: StreamCardHost, stream: StreamAgg, args: unknown): void {
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch { return }
  }
  if (!args || typeof args !== "object") return
  const rec = args as { todos?: unknown }
  if (!Array.isArray(rec.todos)) return
  const incoming: StreamTodoItem[] = []
  for (const t of rec.todos) {
    if (!t || typeof t !== "object") continue
    const item = t as { id?: unknown; content?: unknown; status?: unknown }
    const content = typeof item.content === "string" ? item.content.trim() : ""
    if (!content) continue
    incoming.push({
      id: typeof item.id === "string" ? item.id : undefined,
      content,
      status: normalizeTodoStatus(item.status),
    })
  }
  if (!incoming.length) return

  const snapshot = host.todoSnapshot ?? []
  const sameItem = (a: StreamTodoItem, b: StreamTodoItem): boolean =>
    (!!a.id && a.id === b.id) || a.content === b.content
  const overlap = incoming.filter((inc) => snapshot.some((x) => sameItem(inc, x))).length
  if (snapshot.length && overlap === 0) {
    host.todoSnapshot = incoming
  } else {
    for (const inc of incoming) {
      const hit = snapshot.find((x) => sameItem(inc, x))
      if (hit) {
        hit.status = inc.status
        if (inc.id && !hit.id) hit.id = inc.id
      } else {
        snapshot.push(inc)
      }
    }
    host.todoSnapshot = snapshot
  }

  let seg = stream.segments.find((s): s is Extract<StreamSegment, { type: "todos" }> => s.type === "todos")
  if (!seg) {
    dropEmptyTail(stream)
    sealLastThinking(stream)
    seg = { type: "todos", items: [] }
    stream.segments.push(seg)
  }
  seg.items = (host.todoSnapshot ?? []).map((t) => ({ ...t }))
  stream.dirty = true
}

export { isTodoUpdateInvocation }

export function enqueueTool(
  stream: StreamAgg,
  event: { call_id: string; name: string; args?: unknown; status: StreamToolEntry["status"] },
  summary: string,
): void {
  for (const seg of stream.segments) {
    if (seg.type !== "tools") continue
    const hit = seg.tools.find((x) => x.callId === event.call_id)
    if (!hit) continue
    hit.status = event.status
    if (summary) hit.summary = summary
    if (event.status === "running") {
      hit.startedAt = Date.now()
      hit.ms = undefined
    } else if (hit.startedAt != null && (event.status === "completed" || event.status === "error")) {
      hit.ms = Date.now() - hit.startedAt
    }
    stream.dirty = true
    return
  }
  if (event.status !== "running") return
  dropEmptyTail(stream)
  sealLastThinking(stream)
  let toolsSeg = stream.segments[stream.segments.length - 1]
  if (toolsSeg?.type !== "tools") {
    toolsSeg = { type: "tools", tools: [] }
    stream.segments.push(toolsSeg)
  }
  toolsSeg.tools.push({
    callId: event.call_id,
    name: resolveToolDisplayName(event.name, event.args),
    status: event.status,
    summary,
    startedAt: Date.now(),
  })
  stream.dirty = true
}

function buildStreamPayload(agg: StreamAgg, sessionKey: string): StreamCardPayload {
  const showThinking = isShowThinkingEnabled(sessionKey)
  sealClosedThinking(agg)
  const segments: StreamCardPayload["segments"] = []
  const lastIdx = agg.segments.length - 1
  for (let i = 0; i < agg.segments.length; i++) {
    const seg = agg.segments[i]
    if (seg.type === "thinking") {
      const text = seg.text.trim()
      if (!text || !showThinking) continue
      let thinking = text
      if (thinking.length > STREAM_THINKING_TAIL) {
        thinking = "…" + thinking.slice(-STREAM_THINKING_TAIL)
      }
      const ms = seg.ms ?? (i === lastIdx && seg.startedAt != null ? Date.now() - seg.startedAt : undefined)
      segments.push({ type: "thinking", text: thinking, ms })
    } else if (seg.type === "tools") {
      if (!seg.tools.length) continue
      const tools = seg.tools.length > MAX_STREAM_TOOL_STEPS
        ? seg.tools.slice(-MAX_STREAM_TOOL_STEPS)
        : seg.tools
      const prev = segments[segments.length - 1]
      if (prev?.type === "tools") {
        prev.tools.push(...tools.map((t) => ({
          name: t.name,
          status: t.status,
          summary: t.summary || undefined,
          ms: t.ms,
        })))
      } else {
        segments.push({
          type: "tools",
          tools: tools.map((t) => ({
            name: t.name,
            status: t.status,
            summary: t.summary || undefined,
            ms: t.ms,
          })),
        })
      }
    } else if (seg.type === "todos") {
      if (!seg.items.length) continue
      segments.push({ type: "todos", items: seg.items.map((t) => ({ content: t.content, status: t.status })) })
    } else if (seg.type === "reply") {
      const text = seg.text.trim()
      if (!text) continue
      const prev = segments[segments.length - 1]
      if (prev?.type === "reply") {
        prev.text = prev.text.trim() ? `${prev.text}\n\n${text}` : text
      } else {
        segments.push({ type: "reply", text })
      }
    }
  }
  return { segments }
}

export { buildStreamPayload }

export async function postStreamCard(
  sessionKey: string,
  action: "ensure" | "update" | "finish",
  payload: StreamCardPayload,
  opts?: { cardId?: string; queueBornAt?: number },
): Promise<{ cardId?: string; gone?: boolean } | undefined> {
  const lock = readLockFile()
  if (!lock?.port) return undefined
  try {
    const r = await httpPost(
      `http://127.0.0.1:${lock.port}/api/agent-stream-card`,
      {
        session_key: sessionKey,
        action,
        segments: payload.segments,
        ...(opts?.cardId ? { card_id: opts.cardId } : {}),
        ...(opts?.queueBornAt ? { queue_born_at: opts.queueBornAt } : {}),
      },
      15_000,
    ) as { ok?: boolean; skipped?: boolean; error?: string; cardId?: string; gone?: boolean } | null
    if (r?.gone) return { gone: true }
    return r?.cardId ? { cardId: r.cardId } : undefined
  } catch { return undefined }
}

function rotateStaleStreamQueue(host: StreamCardHost, agg: StreamAgg): void {
  agg.finished = true
  if (host.streamAgg !== agg) return
  host.streamAgg = isFeishuStreamEnabled(host.sessionKey) ? newStreamAgg(true) : null
}

export function scheduleFlushStreamCard(host: StreamCardHost, immediate = false): void {
  const agg = host.streamAgg
  if (!agg || agg.finished) return
  agg.dirty = true
  if (immediate) {
    if (agg.timer) {
      clearTimeout(agg.timer)
      agg.timer = null
    }
    void flushStreamCard(host, false)
    return
  }
  if (agg.timer) return
  const elapsed = Date.now() - agg.lastFlushAt
  const delay = Math.max(STREAM_FLUSH_MS, STREAM_MIN_INTERVAL_MS - elapsed)
  agg.timer = setTimeout(() => {
    agg.timer = null
    void flushStreamCard(host, false)
  }, Math.max(0, delay))
}

export async function flushStreamCard(host: StreamCardHost, finish: boolean): Promise<void> {
  const agg = host.streamAgg
  if (!agg || agg.finished) return
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  if (!finish && !agg.dirty) return
  if (!finish && (!agg.gateOpen || host.pollPhase.blocking)) return

  const patchCard = (cardId: string | undefined, onlyIf?: string) => {
    host.patchStreamCardId?.(cardId, onlyIf ? { onlyIf } : undefined)
  }

  const pushFrame = async (opts?: { ignoreGate?: boolean }): Promise<boolean> => {
    if (agg.finished) return false
    if (!opts?.ignoreGate && (!agg.gateOpen || host.pollPhase.blocking)) return false
    const payload = buildStreamPayload(agg, host.sessionKey)
    if (!agg.ensured && payload.segments.length === 0) return false

    agg.dirty = false
    agg.lastFlushAt = Date.now()

    if (!agg.ensured) {
      const ensured = await postStreamCard(host.sessionKey, "ensure", payload, { queueBornAt: agg.bornAt })
      if (ensured?.gone) {
        rotateStaleStreamQueue(host, agg)
        return false
      }
      agg.ensured = true
      if (ensured?.cardId) {
        agg.cardId = ensured.cardId
        patchCard(ensured.cardId)
      }
      const updated = await postStreamCard(host.sessionKey, "update", payload, { cardId: agg.cardId, queueBornAt: agg.bornAt })
      if (updated?.gone) {
        rotateStaleStreamQueue(host, agg)
        return false
      }
      if (!agg.cardId && updated?.cardId) {
        agg.cardId = updated.cardId
        patchCard(updated.cardId)
      }
      return true
    }

    const updated = await postStreamCard(host.sessionKey, "update", payload, { cardId: agg.cardId, queueBornAt: agg.bornAt })
    if (updated?.gone) {
      rotateStaleStreamQueue(host, agg)
      return false
    }
    if (!agg.cardId && updated?.cardId) {
      agg.cardId = updated.cardId
      patchCard(updated.cardId)
    }
    return true
  }

  const run = async (): Promise<void> => {
    if (finish) {
      while (agg.dirty) {
        if (!await pushFrame({ ignoreGate: true })) break
      }
      if (!agg.cardId) {
        agg.dirty = true
        await pushFrame({ ignoreGate: true })
      }
      if (!agg.cardId) return
      const payload = buildStreamPayload(agg, host.sessionKey)
      agg.dirty = false
      await postStreamCard(host.sessionKey, "finish", payload, { cardId: agg.cardId })
      patchCard(undefined, agg.cardId)
      agg.finished = true
      return
    }
    if (agg.finished) return
    do {
      if (!await pushFrame()) break
    } while (agg.dirty)
  }

  agg.inflight = agg.inflight.then(run, run)
  await agg.inflight
}

export function endStreamRound(host: StreamCardHost): void {
  const agg = host.streamAgg
  if (!agg) {
    host.streamAgg = isFeishuStreamEnabled(host.sessionKey) ? newStreamAgg(true) : null
    return
  }
  if (agg.timer) {
    clearTimeout(agg.timer)
    agg.timer = null
  }
  const finishCardId = agg.cardId
  const shouldPost = !agg.finished && !!finishCardId
  agg.finished = true
  sealAllThinking(agg)
  sealRunningTools(agg)
  host.streamAgg = isFeishuStreamEnabled(host.sessionKey) ? newStreamAgg(true) : null
  if (!shouldPost) return
  const payload = buildStreamPayload(agg, host.sessionKey)
  const finishAndClear = async (): Promise<void> => {
    await postStreamCard(host.sessionKey, "finish", payload, { cardId: finishCardId })
    host.patchStreamCardId?.(undefined, { onlyIf: finishCardId })
  }
  agg.inflight = agg.inflight.then(finishAndClear, finishAndClear)
}

export function enterSilentPollPhase(host: StreamCardHost): void {
  const stream = host.streamAgg
  if (stream && !stream.finished) {
    stream.segments = []
    stream.dirty = false
    if (stream.timer) {
      clearTimeout(stream.timer)
      stream.timer = null
    }
    stream.gateOpen = false
  }
  host.pollPhase.blocking = true
}

export function handleStreamPollPhaseEvent(
  host: StreamCardHost,
  phase: "start" | "end",
  payload: PollPhaseEventPayload,
): void {
  if (phase === "start") {
    const blocking = payload.blocking === true
    if (blocking) {
      if (host.pollPhase.blocking) return
      host.pollPhase.blocking = true
      const stream = host.streamAgg
      if (stream && !stream.finished) stream.gateOpen = false
    } else {
      host.pollPhase.nonBlocking = true
    }
    return
  }

  const blocking = payload.blocking === true
  const wasNonBlocking = host.pollPhase.nonBlocking
  const wasBlocking = host.pollPhase.blocking
  host.pollPhase.nonBlocking = false

  const deliveredIds = (payload.messageIds ?? []).filter((id): id is string => !!id)
  let hasNewUserMsgs = false
  let hasFreshDelivery = false
  for (const id of deliveredIds) {
    if (!host.seenMessageIds.has(id)) {
      hasFreshDelivery = true
      if (!id.startsWith("internal_")) hasNewUserMsgs = true
      host.seenMessageIds.add(id)
    }
  }
  const hasWorkMsgs = deliveredIds.length > 0
  const directive = payload.directive ?? ""
  const isEnd = payload.reason === "end" || directive.includes(POLL_DIRECTIVE_END_MARK)
  const isTimeout = payload.reason === "timeout" || directive.includes(POLL_DIRECTIVE_TIMEOUT_MARK)
  const isAbort = payload.reason === "abort"

  if (hasFreshDelivery) host.pollPhase.questionPause = false

  if (wasBlocking || blocking) {
    if (isTimeout || isEnd || isAbort) {
      enterSilentPollPhase(host)
      return
    }
    if (hasWorkMsgs) {
      host.pollPhase.blocking = false
      host.streamAgg = isFeishuStreamEnabled(host.sessionKey) ? newStreamAgg(true) : null
      if (host.streamAgg) scheduleFlushStreamCard(host, true)
      return
    }
  }

  const stream = host.streamAgg
  if (!stream || stream.finished) return

  if (wasNonBlocking && !hasNewUserMsgs && hasWorkMsgs) {
    if (!stream.ensured) {
      stream.segments = []
      stream.dirty = false
    }
    stream.gateOpen = true
    scheduleFlushStreamCard(host, true)
    return
  }

  if (wasNonBlocking) {
    stream.gateOpen = true
    scheduleFlushStreamCard(host, true)
  }
}

export function isStreamSilenced(host: StreamCardHost): boolean {
  return host.pollPhase.blocking || host.pollPhase.questionPause
}

export function isToolStreamSilenced(host: StreamCardHost): boolean {
  return host.pollPhase.blocking || host.pollPhase.nonBlocking || host.pollPhase.questionPause
}
