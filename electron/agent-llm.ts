import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { complete, type Model, type Api } from "@mariozechner/pi-ai/compat"
import { app } from "electron"
import { readLockFile, httpPost, notifySessionLaunched as notifyDaemonSessionLaunched } from "./daemon-client"
import { broadcastLog, pushUiLog, broadcastSessionStatus } from "./ui-logger"
import type { ChatType, LaunchMeta } from "./agent-session-types"
import type { AgentResource } from "../src/shared/channel-types"
import { workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { resolveLlmModel, llmApiKey, llmProviderId } from "./llm-config"
import { getChannel, resolveChannelModel, getConfig } from "./config-store"
import {
  resolveModelForSession,
  initSessionModelStore,
  setSessionOverride,
  pushRecentModel,
} from "../src/shared/session-model-store.js"
import { createHarnessPiSession, hasPersistedPiSession, clearPiSession, readPiSessionTurns } from "./pi-embedded"
import { takeLastTurns, turnsFromPiMessages, readMirrorTurns, mergeLegacyTurns, clearMirror } from "./carryover"
import type { TranscriptTurn } from "./agent-engine/types"
import {
  hashSystemPrompt,
  computePromptHash,
  resolveDaemonPortForPrompt,
} from "./prompt-assembler"
import {
  forgetPiResumable,
  getPiResumable,
  rememberPiResumable,
  patchPiResumableStreamCard,
} from "./pi-resume-store"
import { syncMainProcessProxyEnv } from "./agent-env"
import { llmProxyConfigured, withLlmProxyOptions } from "./llm-proxy"
import {
  type PollPhaseEventPayload,
  type StreamAgg,
  type StreamCardHost,
  type StreamPollPhaseState,
  buildStreamPayload,
  enqueueTool,
  enqueueThinking,
  enqueueReply,
  endStreamRound,
  flushStreamCard,
  handleStreamPollPhaseEvent,
  isFeishuStreamEnabled,
  isStreamSilenced,
  isToolStreamSilenced,
  newStreamAgg,
  postStreamCard,
  scheduleFlushStreamCard,
  sealAllThinking,
  sealLastThinking,
  sealRunningTools,
  shouldOmitFromStreamCard,
} from "./stream-card"

export interface LlmLaunchOptions {
  sessionKey: string
  chatType: ChatType
  meta?: LaunchMeta
  workspaceDir: string
  resource: AgentResource
  channelId?: string
  model?: string
  modelParams?: string
  useMainWorkspace?: boolean
  /** 主用户私聊：协议内嵌 admin 段 */
  includeAdmin?: boolean
  digitalIdentityOverride?: string
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  notifySessionKey?: string
  keepSession?: boolean
  persistentPoll?: boolean
  pendingMessageIds?: string[]
  /** 切供应商搬运：清本家文件后全新起（旧家在导出时已留档） */
  newSession?: boolean
}

interface LlmSession extends StreamCardHost {
  channelId?: string
  resource: AgentResource
  model: Model<Api>
  piSession: AgentSession
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  chatName?: string
  senderOpenId?: string
  persistentPoll: boolean
  keepSession: boolean
  channelModel: string
  channelModelParams: string
  rulesHash: string
  daemonPort?: number
  abort: AbortController
  runPromise: Promise<void>
  /** poll 已见 messageId：非阻塞 poll 区分新消息 vs 重投 */
  seenMessageIds: Set<string>
  /** 已成功跑完 worker 回合的 messageId：黑洞重投时跳过重复处理 */
  processedMessageIds: Set<string>
  piUnsubscribe: (() => void) | null
  /** 流式日志聚合：连续同类型(thinking/text)增量合并成一条打印 */
  logAgg: { kind: "thinking" | "text" | null; buf: string }
}

export type LlmWorkerSession = LlmSession

const llmSessions = new Map<string, LlmSession>()
const pendingLaunches = new Set<string>()
let idleHandler: ((sessionKey: string) => void) | null = null

const llmFailStreak = new Map<string, {
  count: number
  lastFailAt: number
  network?: boolean
  permanent?: boolean
}>()
const PERMANENT_FAIL_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 300_000]
const lastFailLogSignature = new Map<string, string>()
const FAIL_LOG_FOLD_EVERY = 10

export function setLlmIdleHandler(fn: (sessionKey: string) => void): void {
  idleHandler = fn
}

export function clearLlmFailStreak(sessionKey: string): void {
  llmFailStreak.delete(sessionKey)
  lastFailLogSignature.delete(sessionKey)
}

export function clearAllLlmFailStreaks(): void {
  llmFailStreak.clear()
  lastFailLogSignature.clear()
}

export function llmFailCooldownRemaining(sessionKey: string): number {
  const st = llmFailStreak.get(sessionKey)
  if (!st?.permanent) return 0
  const idx = Math.min(st.count - 1, PERMANENT_FAIL_BACKOFF_MS.length - 1)
  const wait = PERMANENT_FAIL_BACKOFF_MS[Math.max(idx, 0)]
  return Math.max(0, st.lastFailAt + wait - Date.now())
}

function shouldLogRepeatedFailure(sessionKey: string, errorDetail: string | undefined, count: number): boolean {
  const signature = (errorDetail || "unknown").slice(0, 200)
  const repeated = lastFailLogSignature.get(sessionKey) === signature
  lastFailLogSignature.set(sessionKey, signature)
  return !repeated || count % FAIL_LOG_FOLD_EVERY === 0
}

function scheduleLlmIdle(
  sessionKey: string,
  errored: boolean,
  opts?: { network?: boolean; silent?: boolean; permanent?: boolean },
): void {
  if (errored) {
    const st = llmFailStreak.get(sessionKey) ?? { count: 0, lastFailAt: 0, network: false }
    st.count += 1
    st.lastFailAt = Date.now()
    st.network = !!opts?.network
    st.permanent = !!opts?.permanent
    llmFailStreak.set(sessionKey, st)
    if (!opts?.silent) {
      const waitMs = llmFailCooldownRemaining(sessionKey)
      pushUiLog("LLM", st.count > 8 ? "ERROR" : "WARN",
        `[${sessionKey}] 异常结束×${st.count}，${waitMs > 0 ? `${Math.round(waitMs / 1000)}s 后重试` : "立即重试"}`)
    }
  } else {
    const prev = llmFailStreak.get(sessionKey)
    clearLlmFailStreak(sessionKey)
    if (prev && prev.count >= 2) {
      pushUiLog("LLM", "INFO", `[${sessionKey}] 已恢复（曾连续失败 ${prev.count} 次）`)
    }
  }
  idleHandler?.(sessionKey)
}

function broadcastLlmSessionStatus(): void {
  const list = [...llmSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    pid: 0,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType as string,
    workspaceDir: workspaceDirFromSessionKey(s.sessionKey),
    model: s.model.id,
    modelParams: s.channelModelParams,
  }))
  broadcastSessionStatus(list, "llm")
}

/** 模型解析唯一入口：会话 override/pending 恒优先于传入的 ref */
function resolveModelRef(sessionKey: string, ref: { model?: string; modelParams?: string }): { modelId: string; modelParams: string } {
  initSessionModelStore(app.getPath("userData"))
  const trimmed = ref.model?.trim() ?? ""
  const usable = trimmed && trimmed !== "auto"
  const resolved = resolveModelForSession(sessionKey, usable
    ? { model: trimmed, modelParams: ref.modelParams ?? "" }
    : { model: "", modelParams: "" })
  return { modelId: resolved.model, modelParams: resolved.modelParams ?? "" }
}

/** 通道当前配置的主模型（live 读 config，未配置返空） */
function channelModelRef(channelId?: string, resourceId?: string): { model: string; modelParams: string } {
  if (!channelId) return { model: "", modelParams: "" }
  const channel = getChannel(channelId)
  // 通道已换绑其它 Agent：它的模型属于另一个引擎，不能拿过来喂本 worker
  if (resourceId && channel?.agentResourceId && channel.agentResourceId !== resourceId) {
    return { model: "", modelParams: "" }
  }
  const resolved = resolveChannelModel(channel, "primary")
  return { model: resolved.model ?? "", modelParams: resolved.modelParams ?? "" }
}

/** 通道绑定的资源已不是本会话所用资源：旧引擎 worker 必须让路，新消息由新引擎重新拉起 */
export function channelResourceSwitched(channelId: string | undefined, resourceId: string): boolean {
  if (!channelId) return false
  const bound = getChannel(channelId)?.agentResourceId
  return !!bound && bound !== resourceId
}

function resolveLlmModelRef(opts: LlmLaunchOptions): { modelId: string; modelParams: string } {
  // opts.model 已由上层按场景（primary/others）+ override 解析，通道模型只作兜底
  const ref = opts.model?.trim() && opts.model.trim() !== "auto"
    ? { model: opts.model, modelParams: opts.modelParams }
    : channelModelRef(opts.channelId, opts.resource?.id)
  return resolveModelRef(opts.sessionKey, ref)
}

async function refreshLlmModel(session: LlmSession): Promise<void> {
  // 资源对象每回合从配置重取：设置里改协议/默认模型不用重启会话就生效
  const resource = getConfig().agentResources?.find((r) => r.id === session.resource.id) ?? session.resource
  session.resource = resource
  const live = channelModelRef(session.channelId, resource.id)
  const { modelId } = resolveModelRef(session.sessionKey, live.model
    ? live
    : { model: session.channelModel, modelParams: session.channelModelParams })
  const llmModel = resolveLlmModel(resource, modelId)
  if (!llmModel || llmModel.id === session.model.id) return
  session.model = llmModel
  await session.piSession.setModel(llmModel)
}

function formatLlmError(e: unknown, agentErr?: string): string {
  if (agentErr?.trim()) return agentErr.trim()
  if (e instanceof Error) return e.message
  return String(e)
}

function classifyLlmFailure(errorDetail: string): { networkFail: boolean; permanentFail: boolean } {
  const networkFail = /fetch failed|ECONNRESET|socket hang up|timeout|network|unauthenticated/i.test(errorDetail)
  const permanentFail = !networkFail && /invalid[_ ]api[_ ]key|api key not valid|401|403|forbidden|quota|rate limit|insufficient|model .*not (found|available)/i.test(errorDetail)
  return { networkFail, permanentFail }
}

function promptHashForLlm(opts: Pick<LlmLaunchOptions, "meta" | "sessionKey" | "useMainWorkspace" | "digitalIdentityOverride" | "includeAdmin">): string {
  return computePromptHash({
    meta: opts.meta,
    sessionKey: opts.sessionKey,
    useMainWorkspace: opts.useMainWorkspace,
    includeAdmin: opts.includeAdmin,
    digitalIdentityOverride: opts.digitalIdentityOverride,
  }, resolveDaemonPortForPrompt())
}

async function notifySessionLaunched(sessionKey: string, resumed: boolean): Promise<void> {
  await notifyDaemonSessionLaunched(sessionKey, { resumed, runtime: "llm" })
}

function toolSummaryFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  for (const key of ["command", "path", "text", "tool", "toolName", "tool_name", "query"]) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120)
  }
  const nested = rec.args
  if (nested && typeof nested === "object") return toolSummaryFromArgs(nested)
  return ""
}

const STARTUP_NOTIFY_TEXT = "正在启动Agent，请稍等..."
const LOG_FLUSH_LEN = 400

function isStartupNotifyDelta(delta: string): boolean {
  const t = delta.trim()
  return t === STARTUP_NOTIFY_TEXT || t.includes(STARTUP_NOTIFY_TEXT)
}

function flushLlmLog(session: LlmSession): void {
  const agg = session.logAgg
  const text = agg.buf.trim()
  if (agg.kind && text) {
    if (agg.kind === "thinking") {
      pushUiLog("LLM", "DEBUG", `[${session.sessionKey}] [thinking] ${text}`)
    } else {
      pushUiLog("LLM", "INFO", `[${session.sessionKey}] [text] ${text}`)
    }
  }
  agg.kind = null
  agg.buf = ""
}

function appendLlmLog(session: LlmSession, kind: "thinking" | "text", delta: string): void {
  const agg = session.logAgg
  if (agg.kind && agg.kind !== kind) flushLlmLog(session)
  agg.kind = kind
  agg.buf += delta
  if (agg.buf.length >= LOG_FLUSH_LEN) flushLlmLog(session)
}

/** 用户可见阶段结束：assistant 正常收束且无后续 toolCall（Pi stopReason=stop） */
function isAssistantVisibleComplete(message: AgentMessage): boolean {
  return message.role === "assistant" && message.stopReason === "stop"
}

function handlePiSessionEvent(session: LlmSession, event: AgentSessionEvent): void {
  session.lastActivityAt = Date.now()
  const stream = session.streamAgg

  if (event.type === "message_update") {
    const ev = event.assistantMessageEvent
    if (ev.type === "thinking_delta" && ev.delta) {
      if (isStartupNotifyDelta(ev.delta)) return
      appendLlmLog(session, "thinking", ev.delta)
      if (stream && !stream.finished && !isStreamSilenced(session)) {
        enqueueThinking(stream, ev.delta)
        scheduleFlushStreamCard(session, true)
      }
    } else if (ev.type === "text_delta" && ev.delta) {
      if (isStartupNotifyDelta(ev.delta)) return
      appendLlmLog(session, "text", ev.delta)
      if (stream && !stream.finished && !isStreamSilenced(session)) {
        stream.gateOpen = true
        enqueueReply(stream, ev.delta)
        scheduleFlushStreamCard(session, true)
      }
    }
    return
  }

  if (event.type === "tool_execution_start") {
    flushLlmLog(session)
    const summary = toolSummaryFromArgs(event.args)
    pushUiLog("LLM", "INFO", `[${session.sessionKey}] [tool] ${event.toolName}: running${summary ? ` · ${summary}` : ""}`)
    if (!stream || stream.finished || isToolStreamSilenced(session)) return
    if (shouldOmitFromStreamCard(event.toolName, summary, event.args)) {
      if (event.toolName && !/poll-message/i.test(summary)) {
        stream.gateOpen = true
        sealLastThinking(stream)
        stream.forceNewThinking = true
        scheduleFlushStreamCard(session, true)
      }
      return
    }
    stream.gateOpen = true
    enqueueTool(stream, {
      call_id: event.toolCallId,
      name: event.toolName,
      args: event.args,
      status: "running",
    }, summary)
    scheduleFlushStreamCard(session, true)
    return
  }

  if (event.type === "tool_execution_end") {
    flushLlmLog(session)
    const summary = typeof event.result === "string" ? event.result.slice(0, 120) : toolSummaryFromArgs(event.result)
    pushUiLog("LLM", "INFO", `[${session.sessionKey}] [tool] ${event.toolName}: ${event.isError ? "error" : "completed"}${summary ? ` · ${summary}` : ""}`)
    if (!stream || stream.finished || isToolStreamSilenced(session)) return
    if (shouldOmitFromStreamCard(event.toolName, summary, event.result)) return
    enqueueTool(stream, {
      call_id: event.toolCallId,
      name: event.toolName,
      status: event.isError ? "error" : "completed",
    }, summary)
    scheduleFlushStreamCard(session)
    return
  }

  if (event.type === "message_end") {
    flushLlmLog(session)
    if (isAssistantVisibleComplete(event.message)) {
      void sealLlmStream(session)
    }
    return
  }

  if (event.type === "agent_end") {
    flushLlmLog(session)
    if (!stream || stream.finished) return
    sealAllThinking(stream)
    sealRunningTools(stream)
    stream.dirty = true
    scheduleFlushStreamCard(session, true)
  }
}

function openStreamForTurn(session: LlmSession): void {
  // Worker 用 fetch poll，SSE poll-phase 可能晚于本回合；先本地开门，避免 text_delta 被静默
  session.pollPhase.blocking = false
  session.pollPhase.nonBlocking = false
  if (isFeishuStreamEnabled(session.sessionKey)) {
    if (!session.streamAgg || session.streamAgg.finished) {
      session.streamAgg = newStreamAgg(true)
    } else {
      session.streamAgg.gateOpen = true
    }
  }
}

function beginLlmTurn(session: LlmSession): void {
  endStreamRound(session)
  if (session.streamAgg) session.streamAgg.gateOpen = true
}

async function sealLlmStream(session: LlmSession): Promise<void> {
  flushLlmLog(session)
  const agg = session.streamAgg
  if (!agg) return
  if (!agg.finished) {
    sealAllThinking(agg)
    sealRunningTools(agg)
    await flushStreamCard(session, true)
  }
  await agg.inflight.catch(() => undefined)
}

export async function executeLlmPiTurn(
  session: LlmSession,
  prompt: string,
): Promise<{ ok: boolean; error?: string; replyText?: string; empty?: boolean; fatal?: boolean }> {
  // 不建流、不消耗这批消息：这批任务交回给新引擎重新拉起
  if (channelResourceSwitched(session.channelId, session.resource.id)) {
    return { ok: false, error: "通道已换 Agent 资源，本会话改用新引擎重新拉起", fatal: true }
  }
  openStreamForTurn(session)
  return runPiAgentTurn(session, prompt)
}

export function registerLlmSession(session: LlmSession): void {
  llmSessions.set(session.sessionKey, session)
  broadcastLlmSessionStatus()
}

export async function unregisterLlmSession(session: LlmSession, aborted: boolean): Promise<void> {
  session.piUnsubscribe?.()
  session.piUnsubscribe = null
  await sealLlmStream(session)

  if (!aborted) {
    rememberPiResumable(
      session.sessionKey,
      session.rulesHash,
      session.daemonPort,
      getPiResumable(session.sessionKey)?.streamCardId,
    )
  }

  llmSessions.delete(session.sessionKey)
  broadcastLlmSessionStatus()
  await session.piSession.abort().catch(() => undefined)
  session.piSession.dispose()
}

export function onLlmWorkerFinished(
  sessionKey: string,
  errored: boolean,
  opts?: { network?: boolean; permanent?: boolean; errorDetail?: string },
): void {
  if (errored) {
    scheduleLlmIdle(sessionKey, true, { network: opts?.network, silent: true, permanent: opts?.permanent })
    const st = llmFailStreak.get(sessionKey)
    const waitMs = llmFailCooldownRemaining(sessionKey)
    const retryTip = waitMs > 0 ? `→ ${Math.round(waitMs / 1000)}s 后重试` : "→ 立即重试"
    if (shouldLogRepeatedFailure(sessionKey, opts?.errorDetail, st?.count ?? 1)) {
      pushUiLog("LLM", (st?.count ?? 0) > 8 ? "ERROR" : "WARN",
        `[${sessionKey}] worker 异常结束×${st?.count ?? 1} ${retryTip} | ${opts?.errorDetail || "unknown"}`)
    }
    broadcastLog(`[LLM] 会话 ${sessionKey} worker 异常: ${opts?.errorDetail}`, "ERROR")
  } else {
    pushUiLog("LLM", "INFO", `[${sessionKey}] worker 已退出`)
    scheduleLlmIdle(sessionKey, false)
  }
}

function extractAssistantTextSince(piSession: AgentSession, fromIndex: number): string {
  const parts: string[] = []
  for (const msg of piSession.messages.slice(fromIndex)) {
    if (msg.role !== "assistant") continue
    const content = msg.content as unknown
    if (typeof content === "string" && content.trim()) {
      parts.push(content.trim())
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as { type?: string; text?: string }
      if (b.type === "text" && b.text?.trim()) parts.push(b.text.trim())
    }
  }
  return parts.join("\n\n").trim()
}

async function runPiAgentTurn(session: LlmSession, prompt: string): Promise<{ ok: boolean; error?: string; replyText?: string; empty?: boolean }> {
  beginLlmTurn(session)
  await refreshLlmModel(session)
  session.lastActivityAt = Date.now()
  // 网关 4xx/5xx 只看这行：协议与端点以实际交给 Pi 的 Model 为准，不靠配置推猜
  const modelRef = `${session.model.id} · ${session.model.api} · ${session.model.baseUrl ?? "provider 默认"}${session.model.reasoning ? " · reasoning" : ""}`
  pushUiLog("LLM", "INFO", `[${session.sessionKey}] 本回合模型: ${modelRef}`)
  const msgBefore = session.piSession.messages.length
  let result: { ok: boolean; error?: string }
  // 收口日志与下一次挂 poll 之间能差到分钟级：先孨清这三个 await 各占多少

  const turnT0 = Date.now()
  let tIdle = turnT0
  let tSeal = turnT0
  try {
    await session.piSession.prompt(prompt)
    tIdle = Date.now()
    await session.piSession.agent.waitForIdle()
    tSeal = Date.now()
    const agentErr = session.piSession.state.errorMessage?.trim()
    result = agentErr ? { ok: false, error: agentErr } : { ok: true }
  } catch (e: unknown) {
    result = { ok: false, error: formatLlmError(e, session.piSession.state.errorMessage) }
  }
  // 回合终结就必须收口（失败也算终结），卡片不能挂在“思考中”等 worker 退出才收
  await sealLlmStream(session)
  pushUiLog(
    "LLM",
    "INFO",
    `[${session.sessionKey}] 回合耗时 prompt=${Math.round((tIdle - turnT0) / 100) / 10}s waitForIdle=${Math.round((tSeal - tIdle) / 100) / 10}s seal=${Math.round((Date.now() - tSeal) / 100) / 10}s`,
  )
  if (!result.ok) return { ...result, error: `${result.error}（${modelRef}）` }
  if (!isFeishuStreamEnabled(session.sessionKey)) {
    const replyText = extractAssistantTextSince(session.piSession, msgBefore)
    if (!replyText.trim()) return { ok: true, empty: true }
    return { ok: true, replyText }
  }
  // 流式通道：未建卡 = 零出站（ensure 要求非空 payload），Daemon 会判黑洞，必须显式标空
  const agg = session.streamAgg
  if (!agg || (!agg.ensured && !agg.cardId && buildStreamPayload(agg, session.sessionKey).segments.length === 0)) {
    return { ok: true, empty: true }
  }
  return { ok: true }
}

export function isLlmSessionRunning(sessionKey: string): boolean {
  if (llmSessions.has(sessionKey) || pendingLaunches.has(sessionKey)) return true
  try {
    const { isLlmWorkerActive } = require("./llm-session-worker.js") as typeof import("./llm-session-worker.js")
    return isLlmWorkerActive(sessionKey)
  } catch {
    return false
  }
}

export function hasPersistedLlmSession(sessionKey: string): boolean {
  return hasPersistedPiSession(sessionKey)
}

export function resetLlmSessionContext(sessionKey: string): void {
  clearPiSession(sessionKey)
  forgetPiResumable(sessionKey)
  try { clearMirror(sessionKey) } catch { /* ignore */ }
}

/** 搬运用导出：镜像优先（双引擎统一源），老账本回填；取不到返回 [] */
export async function exportLlmTranscript(sessionKey: string): Promise<TranscriptTurn[]> {
  try {
    const mirror = readMirrorTurns(sessionKey)
    if (mirror.length > 0) {
      let legacy: TranscriptTurn[] = []
      try { legacy = readPiSessionTurns(sessionKey) } catch { /* 仅镜像 */ }
      return takeLastTurns(mergeLegacyTurns(legacy, mirror))
    }
  } catch { /* 旧路径 */ }
  try {
    const live = llmSessions.get(sessionKey)
    if (live) {
      const turns = turnsFromPiMessages((live.piSession.messages ?? []) as unknown as Parameters<typeof turnsFromPiMessages>[0])
      if (turns.length > 0) return takeLastTurns(turns)
    }
  } catch { /* 落盘兜底 */ }
  try {
    return takeLastTurns(readPiSessionTurns(sessionKey))
  } catch { return [] }
}

export function handleLlmPollPhaseEvent(
  sessionKey: string,
  phase: "start" | "end",
  payload: PollPhaseEventPayload,
): void {
  const session = llmSessions.get(sessionKey)
  if (!session) return
  if (phase === "end" && payload.messageIds?.length) {
    void import("./llm-session-worker.js").then(({ getLlmWorkerPhase }) => {
      if (getLlmWorkerPhase(sessionKey) !== "processing") {
        handleStreamPollPhaseEvent(session, phase, payload)
        return
      }
      session.pollPhase.blocking = false
      session.pollPhase.nonBlocking = false
      if (session.streamAgg && !session.streamAgg.finished) session.streamAgg.gateOpen = true
    }).catch(() => handleStreamPollPhaseEvent(session, phase, payload))
    return
  }
  handleStreamPollPhaseEvent(session, phase, payload)
}

export async function stopLlmSession(sessionKey: string): Promise<void> {
  pendingLaunches.delete(sessionKey)
  const { stopLlmWorker, isLlmWorkerActive } = await import("./llm-session-worker.js")
  if (isLlmWorkerActive(sessionKey)) {
    await stopLlmWorker(sessionKey)
    return
  }
  const s = llmSessions.get(sessionKey)
  if (!s) return
  llmSessions.delete(sessionKey)
  broadcastLlmSessionStatus()
  s.abort.abort()
  s.piUnsubscribe?.()
  s.piUnsubscribe = null
  await sealLlmStream(s)
  await s.piSession.abort().catch(() => undefined)
  s.piSession.dispose()
  await Promise.race([
    s.runPromise.catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ])
}

export async function stopAllLlmSessions(): Promise<void> {
  pendingLaunches.clear()
  const { stopAllLlmWorkers } = await import("./llm-session-worker.js")
  await stopAllLlmWorkers()
  for (const key of [...llmSessions.keys()]) {
    const s = llmSessions.get(key)
    if (!s) continue
    llmSessions.delete(key)
    s.abort.abort()
    s.piUnsubscribe?.()
    await sealLlmStream(s).catch(() => undefined)
    await s.piSession.abort().catch(() => undefined)
    s.piSession.dispose()
  }
  broadcastLlmSessionStatus()
}

export function getLlmSessionCount(): number {
  return llmSessions.size
}

export function getLlmSessionList() {
  let workerPhase: ((sk: string) => import("./llm-session-worker.js").LlmWorkerPhase | null) | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    workerPhase = require("./llm-session-worker.js").getLlmWorkerPhase
  } catch { /* worker 未加载 */ }
  return [...llmSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType,
    chatName: s.chatName,
    senderOpenId: s.senderOpenId,
    workspaceDir: workspaceDirFromSessionKey(s.sessionKey),
    model: s.model.id,
    modelParams: s.channelModelParams,
    workerPhase: workerPhase?.(s.sessionKey) ?? undefined,
  }))
}

export async function switchLlmSessionModel(
  sessionKey: string,
  model: string,
  modelParams?: string,
): Promise<{ ok: boolean; deferred?: boolean; error?: string }> {
  const mid = model?.trim()
  if (!mid) return { ok: false, error: "model 不能为空" }
  initSessionModelStore(app.getPath("userData"))
  const params = modelParams ?? ""
  setSessionOverride(sessionKey, { model: mid, modelParams: params })
  pushRecentModel({ model: mid, modelParams: params })

  const live = llmSessions.get(sessionKey)
  if (live) {
    pushUiLog("LLM", "INFO", `[${sessionKey}] 换模 → ${mid}，停止当前 Agent`)
    await stopLlmSession(sessionKey)
  } else {
    pushUiLog("LLM", "INFO", `[${sessionKey}] 已记下模型 ${mid}`)
  }
  return { ok: true, deferred: true }
}

async function disposeOrphanPi(
  pi: AgentSession | undefined,
  unsub?: (() => void) | null,
): Promise<void> {
  try { unsub?.() } catch { /* ignore */ }
  if (!pi) return
  try { await pi.abort().catch(() => undefined) } catch { /* ignore */ }
  try { pi.dispose() } catch { /* ignore */ }
}

export async function launchLlmAgent(opts: LlmLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, resource } = opts
  if (isLlmSessionRunning(sessionKey)) return { ok: true }

  pendingLaunches.add(sessionKey)
  let piSession: AgentSession | undefined
  let session: LlmSession | undefined
  try {
    const apiKey = llmApiKey(resource)
    if (!apiKey) return { ok: false, error: "未配置 API Key（设置 → Agent）" }

    syncMainProcessProxyEnv(getConfig())
    if (llmProxyConfigured()) {
      pushUiLog("LLM", "INFO", `[${sessionKey}] LLM 请求走 HTTP 代理`)
    }

    initSessionModelStore(app.getPath("userData"))
    const { initCarryoverStore } = await import("./carryover.js")
    initCarryoverStore(app.getPath("userData"))
    const { modelId, modelParams } = resolveLlmModelRef(opts)
    const model = resolveLlmModel(resource, modelId)
    if (!model) return { ok: false, error: "无法解析模型，请检查 Agent 配置或通道模型设置" }

    // 切供应商搬运：清本家文件后全新起（旧家轮次已在切换时导出）
    if (opts.newSession) {
      clearPiSession(sessionKey)
      forgetPiResumable(sessionKey)
      pushUiLog("LLM", "INFO", `[${sessionKey}] 搬运全新起（已清旧上下文）`)
    }

    const created = await createHarnessPiSession(opts, model, apiKey)
    piSession = created.session
    const resumed = created.resumed

    const currentDaemonPort = resolveDaemonPortForPrompt()
    const stored = getPiResumable(sessionKey)
    const rulesHash = promptHashForLlm(opts)
    pushUiLog("LLM", "INFO", `[${sessionKey}] system prompt hash=${hashSystemPrompt(piSession.systemPrompt)} (${piSession.systemPrompt.length} chars, rulesHash=${rulesHash})`)

    const rulesUpdated = resumed && !!stored?.rulesHash && stored.rulesHash !== rulesHash
    const portChanged = resumed && !!stored?.daemonPort && !!currentDaemonPort
      && stored.daemonPort !== currentDaemonPort
    if (rulesUpdated) pushUiLog("LLM", "INFO", `[${sessionKey}] 检测到协议/规则变更（已反映于 system prompt，rulesHash ${stored!.rulesHash} → ${rulesHash}）`)
    if (portChanged) pushUiLog("LLM", "INFO", `[${sessionKey}] 检测到 Daemon 端口变更 ${stored!.daemonPort} → ${currentDaemonPort}`)

    const promptCtx = {
      meta: opts.meta,
      sessionKey: opts.sessionKey,
      useMainWorkspace: opts.useMainWorkspace,
      notifySessionKey: opts.notifySessionKey,
      digitalIdentityOverride: opts.digitalIdentityOverride,
      taskMessage: opts.taskMessage,
    }
    const persistentPoll = opts.keepSession !== false && (opts.persistentPoll ?? true)

    pushUiLog("LLM", "INFO", `[${sessionKey}] ${resumed ? "恢复" : "启动"} Session Worker (persistentPoll=${persistentPoll})`)

    const abort = new AbortController()
    session = {
      sessionKey,
      channelId: opts.channelId,
      resource,
      model,
      piSession,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      chatType: opts.chatType,
      chatName: opts.chatName,
      senderOpenId: opts.senderOpenId,
      persistentPoll,
      keepSession: opts.keepSession ?? true,
      channelModel: modelId,
      channelModelParams: modelParams,
      rulesHash,
      daemonPort: currentDaemonPort ?? undefined,
      abort,
      runPromise: Promise.resolve(),
      streamAgg: isFeishuStreamEnabled(sessionKey) ? newStreamAgg() : null,
      pollPhase: { blocking: false, nonBlocking: false, questionPause: false },
      seenMessageIds: new Set((opts.pendingMessageIds ?? []).filter(Boolean)),
      processedMessageIds: new Set<string>(),
      piUnsubscribe: null,
      logAgg: { kind: null, buf: "" },
      patchStreamCardId: (cardId, patchOpts) => patchPiResumableStreamCard(sessionKey, cardId, patchOpts),
    }

    // pack/进程重启后 daemon 内存无卡，飞书旧流式卡仍在：Resume 前先收口孤儿卡
    if (resumed && stored?.streamCardId && session.streamAgg) {
      pushUiLog("LLM", "INFO", `[${sessionKey}] Resume 收口孤儿流式卡 card=${stored.streamCardId}`)
      await postStreamCard(sessionKey, "finish", { segments: [] }, { cardId: stored.streamCardId })
      patchPiResumableStreamCard(sessionKey, undefined, { onlyIf: stored.streamCardId })
    }

    session.piUnsubscribe = piSession.subscribe((event) => handlePiSessionEvent(session!, event))
    await notifySessionLaunched(sessionKey, resumed)

    const { startLlmWorkerLoop, isLlmWorkerActive } = await import("./llm-session-worker.js")
    if (isLlmWorkerActive(sessionKey)) {
      await disposeOrphanPi(piSession, session.piUnsubscribe)
      session.piUnsubscribe = null
      return { ok: true }
    }

    registerLlmSession(session)
    session.runPromise = startLlmWorkerLoop(session, {
      persistentPoll,
      promptCtx,
      taskMessage: opts.taskMessage,
      firstTurn: !resumed || !!(opts.pendingMessageIds?.length),
    })
    rememberPiResumable(sessionKey, rulesHash, currentDaemonPort ?? undefined, session.streamAgg?.cardId)
    const history = piSession.messages.length
    broadcastLog(`[LLM] 会话 ${sessionKey} 已${resumed ? "恢复" : "启动"} worker (${llmProviderId(resource)} / ${model.id}, history=${history})`)
    return { ok: true }
  } catch (e: unknown) {
    await disposeOrphanPi(piSession, session?.piUnsubscribe)
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  } finally {
    pendingLaunches.delete(sessionKey)
  }
}

export async function verifyLlmResource(resource: AgentResource): Promise<{ ok: boolean; email?: string; error?: string }> {
  const apiKey = llmApiKey(resource)
  if (!apiKey) return { ok: false, error: "请填写 API Key" }
  let model = resolveLlmModel(resource)
  if (!model && resource.type === "llm-custom" && resource.baseUrl?.trim()) {
    try {
      const { listCustomGatewayModels } = await import("./llm-config.js")
      const remote = await listCustomGatewayModels(resource)
      const pick = remote[0]?.id
      if (pick) model = resolveLlmModel(resource, pick)
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!model) return { ok: false, error: "无法解析模型，请检查 Base URL 与 API Key" }
  try {
    const res = await Promise.race([
      complete(model, {
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      }, withLlmProxyOptions({ apiKey, maxTokens: 16 })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("验证超时（30s）")), 30_000)),
    ])
    const block = res.content?.find((c: { type?: string }) => c.type === "text")
    const text = block && "text" in block ? String(block.text) : "ok"
    if (resource.type === "llm-custom") {
      const { listCustomGatewayModels } = await import("./llm-config.js")
      const remote = await listCustomGatewayModels(resource).catch(() => [])
      const hint = remote.length > 0 ? `${remote.length} 个模型` : text.slice(0, 40) || "已连接"
      return { ok: true, email: hint }
    }
    return { ok: true, email: text.slice(0, 40) || "已连接" }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function listLlmModels(
  resource: AgentResource,
  currentModel?: string,
  _currentParams?: string,
): Promise<{ ok: boolean; models: { id: string; label: string; current?: boolean }[]; error?: string }> {
  try {
    const { listLlmModelsForResource, listCustomGatewayModels, isLlmResource } = await import("./llm-config.js")
    if (!isLlmResource(resource)) return { ok: false, models: [], error: "非大模型资源" }
    const models = resource.type === "llm-custom"
      ? await listCustomGatewayModels(resource)
      : listLlmModelsForResource(resource)
    const out = models.map((m) => ({ ...m, current: m.id === currentModel }))
    if (out.length === 0) return { ok: false, models: [], error: "暂无可用模型（请检查 Base URL 与 API Key）" }
    return { ok: true, models: out }
  } catch (e: unknown) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) }
  }
}
