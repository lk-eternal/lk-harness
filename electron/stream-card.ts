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
  bornAt: number
}

export interface StreamCardPayload {
  segments: Array<
    | { type: "thinking"; text: string; ms?: number }
    | { type: "tools"; tools: { name: string; status: string; summary?: string; ms?: number }[] }
    | { type: "reply"; text: string }
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

export function isFeishuStreamEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return !!ch && ch.type === "feishu" && ch.showThinking !== false
}

function isShowThinkingEnabled(sessionKey: string): boolean {
  const ch = resolveChannelForSession(sessionKey)
  return ch?.showThinking !== false
}

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

function summarizeToolArgs(args: unknown): string {
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
  const { tool, server } = mcpCallPayload(args)
  if (tool) return server ? `${server} · ${tool}` : tool

  const prefixed = formatPrefixedMcpToolName(raw)
  if (prefixed) return prefixed

  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>
    for (const key of ["toolName", "tool_name", "name"]) {
      const v = rec[key]
      if (typeof v === "string" && v.trim()) {
        const srv = typeof rec.serverName === "string" ? rec.serverName
          : typeof rec.server === "string" ? rec.server : ""
        return srv ? `${srv} · ${v.trim()}` : v.trim()
      }
    }
  }

  if (/^mcp$/i.test(raw) && args && typeof args === "object") {
    const rec = args as Record<string, unknown>
    if (typeof rec.action === "string" && rec.action.trim()) {
      const srv = typeof rec.server === "string" ? rec.server.trim() : ""
      return srv ? `mcp · ${rec.action.trim()} (${srv})` : `mcp · ${rec.action.trim()}`
    }
    if (typeof rec.connect === "string" && rec.connect.trim()) return `mcp · connect (${rec.connect.trim()})`
    if (typeof rec.describe === "string" && rec.describe.trim()) return `mcp · describe (${rec.describe.trim()})`
    if (rec.search !== undefined) return "mcp · search"
    if (typeof rec.instructions === "string" && rec.instructions.trim()) {
      return `mcp · instructions (${rec.instructions.trim()})`
    }
    if (typeof rec.server === "string" && rec.server.trim()) return `mcp · list (${rec.server.trim()})`
  }

  return raw
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

export function shouldOmitFromStreamCard(name: string, summary: string, args?: unknown): boolean {
  const bare = bareToolNameFromDisplay(name, args)
  if (OUTBOUND_MCP_RE.test(bare)) return true
  if (OUTBOUND_MCP_RE.test(name.trim())) return true
  if (isPollMessageInvocation(name, summary, args)) return true
  const cmd = shellCommandText(args)
  return !!cmd && /\/api\/send-(?:text|question|image|file)/i.test(cmd)
}

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
      segments.push({
        type: "tools",
        tools: tools.map((t) => ({
          name: t.name,
          status: t.status,
          summary: t.summary || undefined,
          ms: t.ms,
        })),
      })
    } else if (seg.type === "reply") {
      const text = seg.text.trim()
      if (!text) continue
      segments.push({ type: "reply", text })
    }
  }
  return { segments }
}

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
  if (!finish) {
    if (!agg.dirty) return
    if (!agg.gateOpen || host.pollPhase.blocking) return
  } else {
    agg.finished = true
  }

  const patchCard = (cardId: string | undefined, onlyIf?: string) => {
    host.patchStreamCardId?.(cardId, onlyIf ? { onlyIf } : undefined)
  }

  const run = async (): Promise<void> => {
    const sendUpdate = async (): Promise<boolean> => {
      if (!finish && (!agg.gateOpen || host.pollPhase.blocking)) return false
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
      }

      const latest = buildStreamPayload(agg, host.sessionKey)
      const updated = await postStreamCard(host.sessionKey, "update", latest, { cardId: agg.cardId, queueBornAt: agg.bornAt })
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

    if (finish) {
      while (agg.dirty) await sendUpdate()
      if (!agg.cardId) return
      const payload = buildStreamPayload(agg, host.sessionKey)
      agg.dirty = false
      await postStreamCard(host.sessionKey, "finish", payload, { cardId: agg.cardId })
      patchCard(undefined, agg.cardId)
      return
    }

    do {
      if (!await sendUpdate()) break
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

function enterSilentPollPhase(host: StreamCardHost): void {
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
