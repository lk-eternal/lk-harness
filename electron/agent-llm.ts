import type { AgentMessage } from "@mariozechner/pi-agent-core"
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { complete, type Model, type Api } from "@mariozechner/pi-ai/compat"
import { app } from "electron"
import { readLockFile, httpPost, notifySessionLaunched as notifyDaemonSessionLaunched } from "./daemon-client"
import { broadcastLog, pushUiLog, broadcastSessionStatus } from "./ui-logger"
import type { ChatType, LaunchMeta } from "./agent-launcher"
import type { AgentResource } from "../src/shared/channel-types"
import { workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { resolveLlmModel, llmApiKey, llmProviderId } from "./llm-config"
import { getChannel, resolveChannelModel } from "./config-store"
import {
  resolveModelForSession,
  initSessionModelStore,
  setSessionOverride,
  pushRecentModel,
} from "../src/shared/session-model-store.js"
import { createHarnessPiSession, hasPersistedPiSession, clearPiSession } from "./pi-embedded"
import {
  assembleWakePrompt,
  assembleColdStartBootstrap,
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
import {
  type PollPhaseEventPayload,
  type StreamAgg,
  type StreamCardHost,
  type StreamPollPhaseState,
  enqueueTool,
  enqueueThinking,
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
  digitalIdentityOverride?: string
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  notifySessionKey?: string
  keepSession?: boolean
  persistentPoll?: boolean
  pendingMessageIds?: string[]
}

interface LlmSession extends StreamCardHost {
  channelId?: string
  resource: AgentResource
  model: Model<Api>
  piSession: AgentSession
  startedAt: number
  lastActivityAt: number
  chatType: ChatType
  persistentPoll: boolean
  keepSession: boolean
  channelModel: string
  channelModelParams: string
  rulesHash: string
  daemonPort?: number
  abort: AbortController
  runPromise: Promise<void>
  piUnsubscribe: (() => void) | null
}

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

function resolveLlmModelRef(opts: LlmLaunchOptions): { modelId: string; modelParams: string } {
  initSessionModelStore(app.getPath("userData"))
  let modelId = opts.model?.trim() && opts.model.trim() !== "auto" ? opts.model.trim() : ""
  let modelParams = opts.modelParams ?? ""
  if (opts.channelId) {
    const channel = getChannel(opts.channelId)
    if (channel) {
      const resolved = resolveChannelModel(channel, "primary")
      if (resolved.model?.trim() && resolved.model !== "auto") {
        modelId = resolved.model
        modelParams = resolved.modelParams ?? ""
      }
    }
  }
  if (modelId && modelId !== "auto") return { modelId, modelParams }
  const resolved = resolveModelForSession(opts.sessionKey, { model: modelId, modelParams })
  return { modelId: resolved.model, modelParams: resolved.modelParams ?? "" }
}

async function refreshLlmModel(session: LlmSession, fallbackModel: string): Promise<void> {
  initSessionModelStore(app.getPath("userData"))
  let modelId = fallbackModel
  if (session.channelId) {
    const channel = getChannel(session.channelId)
    if (channel) {
      const resolved = resolveChannelModel(channel, "primary")
      if (resolved.model?.trim() && resolved.model !== "auto") {
        modelId = resolved.model
      }
    }
  }
  const llmModel = resolveLlmModel(session.resource, modelId)
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

function promptHashForLlm(opts: Pick<LlmLaunchOptions, "meta" | "sessionKey" | "useMainWorkspace" | "digitalIdentityOverride">): string {
  return computePromptHash({
    meta: opts.meta,
    sessionKey: opts.sessionKey,
    useMainWorkspace: opts.useMainWorkspace,
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

function isStartupNotifyDelta(delta: string): boolean {
  const t = delta.trim()
  return t === STARTUP_NOTIFY_TEXT || t.includes(STARTUP_NOTIFY_TEXT)
}

function handlePiSessionEvent(session: LlmSession, event: AgentSessionEvent): void {
  const stream = session.streamAgg
  if (!stream || stream.finished) return

  if (event.type === "message_update") {
    const ev = event.assistantMessageEvent
    if (isStreamSilenced(session)) return
    if (ev.type === "thinking_delta" && ev.delta) {
      if (isStartupNotifyDelta(ev.delta)) return
      enqueueThinking(stream, ev.delta)
      scheduleFlushStreamCard(session)
    } else if (ev.type === "text_delta" && ev.delta) {
      if (isStartupNotifyDelta(ev.delta)) return
      enqueueThinking(stream, ev.delta)
      scheduleFlushStreamCard(session)
    }
    return
  }

  if (event.type === "tool_execution_start") {
    if (isToolStreamSilenced(session)) return
    const summary = toolSummaryFromArgs(event.args)
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
    if (isToolStreamSilenced(session)) return
    const summary = typeof event.result === "string" ? event.result.slice(0, 120) : toolSummaryFromArgs(event.result)
    if (shouldOmitFromStreamCard(event.toolName, summary, event.result)) return
    enqueueTool(stream, {
      call_id: event.toolCallId,
      name: event.toolName,
      status: event.isError ? "error" : "completed",
    }, summary)
    scheduleFlushStreamCard(session)
    return
  }

  if (event.type === "agent_end") {
    sealAllThinking(stream)
    sealRunningTools(stream)
    void flushStreamCard(session, true)
  }
}

function beginLlmTurn(session: LlmSession): void {
  endStreamRound(session)
  if (session.streamAgg) session.streamAgg.gateOpen = true
}

async function sealLlmStream(session: LlmSession): Promise<void> {
  const agg = session.streamAgg
  if (!agg || agg.finished) return
  sealAllThinking(agg)
  sealRunningTools(agg)
  await flushStreamCard(session, true)
}

async function runPiAgentTurn(session: LlmSession, prompt: string): Promise<{ ok: boolean; error?: string }> {
  beginLlmTurn(session)
  await refreshLlmModel(session, session.channelModel)
  session.lastActivityAt = Date.now()
  try {
    await session.piSession.prompt(prompt)
    await session.piSession.agent.waitForIdle()
  } catch (e: unknown) {
    return { ok: false, error: formatLlmError(e, session.piSession.state.errorMessage) }
  }
  const agentErr = session.piSession.state.errorMessage?.trim()
  if (agentErr) return { ok: false, error: agentErr }
  return { ok: true }
}

/** 单次 prompt 生命周期：模型通过 MCP 自行 poll/send，harness 不重复外层 poll 循环 */
async function runLlmLifecycle(session: LlmSession, bootstrap: string): Promise<void> {
  const { sessionKey, abort } = session
  const sig = abort.signal
  let errored = false
  let errorDetail: string | undefined
  let networkFail = false
  let permanentFail = false

  try {
    const result = await runPiAgentTurn(session, bootstrap)
    if (sig.aborted) return
    if (!result.ok) {
      errored = true
      errorDetail = result.error
      const classified = classifyLlmFailure(errorDetail ?? "")
      networkFail = classified.networkFail
      permanentFail = classified.permanentFail
    }
  } catch (e: unknown) {
    if (sig.aborted) return
    errored = true
    errorDetail = formatLlmError(e)
    const classified = classifyLlmFailure(errorDetail)
    networkFail = classified.networkFail
    permanentFail = classified.permanentFail
  } finally {
    session.piUnsubscribe?.()
    session.piUnsubscribe = null
    await sealLlmStream(session)

    if (!sig.aborted) {
      rememberPiResumable(
        sessionKey,
        session.rulesHash,
        session.daemonPort,
        getPiResumable(sessionKey)?.streamCardId,
      )
    }

    llmSessions.delete(sessionKey)
    broadcastLlmSessionStatus()

    if (errored) {
      scheduleLlmIdle(sessionKey, true, { network: networkFail, silent: true, permanent: permanentFail })
      const st = llmFailStreak.get(sessionKey)
      const waitMs = llmFailCooldownRemaining(sessionKey)
      const retryTip = waitMs > 0 ? `→ ${Math.round(waitMs / 1000)}s 后重试` : "→ 立即重试"
      if (shouldLogRepeatedFailure(sessionKey, errorDetail, st?.count ?? 1)) {
        pushUiLog("LLM", (st?.count ?? 0) > 8 ? "ERROR" : "WARN",
          `[${sessionKey}] 运行失败×${st?.count ?? 1} ${retryTip} | ${errorDetail || "unknown"}`)
      }
      broadcastLog(`[LLM] 会话 ${sessionKey} 异常: ${errorDetail}`, "ERROR")
    } else {
      pushUiLog("LLM", "INFO", `[${sessionKey}] Agent 运行结束`)
      scheduleLlmIdle(sessionKey, false)
    }
  }
}

export function isLlmSessionRunning(sessionKey: string): boolean {
  return llmSessions.has(sessionKey) || pendingLaunches.has(sessionKey)
}

export function hasPersistedLlmSession(sessionKey: string): boolean {
  return hasPersistedPiSession(sessionKey)
}

export function resetLlmSessionContext(sessionKey: string): void {
  clearPiSession(sessionKey)
  forgetPiResumable(sessionKey)
}

export function handleLlmPollPhaseEvent(
  sessionKey: string,
  phase: "start" | "end",
  payload: PollPhaseEventPayload,
): void {
  const session = llmSessions.get(sessionKey)
  if (!session) return
  handleStreamPollPhaseEvent(session, phase, payload)
}

export async function stopLlmSession(sessionKey: string): Promise<void> {
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
  await Promise.all([...llmSessions.keys()].map((k) => stopLlmSession(k)))
}

export function getLlmSessionCount(): number {
  return llmSessions.size
}

export function getLlmSessionList() {
  return [...llmSessions.values()].map((s) => ({
    sessionKey: s.sessionKey,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    chatType: s.chatType,
    workspaceDir: workspaceDirFromSessionKey(s.sessionKey),
    model: s.model.id,
    modelParams: s.channelModelParams,
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

export async function launchLlmAgent(opts: LlmLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  const { sessionKey, resource } = opts
  if (isLlmSessionRunning(sessionKey)) return { ok: true }

  pendingLaunches.add(sessionKey)
  try {
    const apiKey = llmApiKey(resource)
    if (!apiKey) return { ok: false, error: "未配置 API Key（设置 → Agent）" }

    initSessionModelStore(app.getPath("userData"))
    const { modelId, modelParams } = resolveLlmModelRef(opts)
    const model = resolveLlmModel(resource, modelId)
    if (!model) return { ok: false, error: "无法解析模型，请检查 Agent 配置或通道模型设置" }

    const { session: piSession, resumed } = await createHarnessPiSession(opts, model, apiKey)

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
    const bootstrap = resumed
      ? assembleWakePrompt(promptCtx, currentDaemonPort)
      : assembleColdStartBootstrap({
        meta: opts.meta,
        sessionKey: opts.sessionKey,
        useMainWorkspace: opts.useMainWorkspace,
        notifySessionKey: opts.notifySessionKey,
        digitalIdentityOverride: opts.digitalIdentityOverride,
        taskMessage: opts.taskMessage,
      }, currentDaemonPort)

    pushUiLog("LLM", "INFO", `[${sessionKey}] ${resumed ? "恢复" : "启动"} Prompt:\n${bootstrap}`)

    const abort = new AbortController()
    const session: LlmSession = {
      sessionKey,
      channelId: opts.channelId,
      resource,
      model,
      piSession,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      chatType: opts.chatType,
      persistentPoll: opts.keepSession !== false && (opts.persistentPoll ?? true),
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
      piUnsubscribe: null,
      patchStreamCardId: (cardId, patchOpts) => patchPiResumableStreamCard(sessionKey, cardId, patchOpts),
    }

    // pack/进程重启后 daemon 内存无卡，飞书旧流式卡仍在：Resume 前先收口孤儿卡
    if (resumed && stored?.streamCardId && session.streamAgg) {
      pushUiLog("LLM", "INFO", `[${sessionKey}] Resume 收口孤儿流式卡 card=${stored.streamCardId}`)
      await postStreamCard(sessionKey, "finish", { segments: [] }, { cardId: stored.streamCardId })
      patchPiResumableStreamCard(sessionKey, undefined, { onlyIf: stored.streamCardId })
    }

    session.piUnsubscribe = piSession.subscribe((event) => handlePiSessionEvent(session, event))
    await notifySessionLaunched(sessionKey, resumed)

    session.runPromise = runLlmLifecycle(session, bootstrap)
    llmSessions.set(sessionKey, session)
    rememberPiResumable(sessionKey, rulesHash, currentDaemonPort ?? undefined, session.streamAgg?.cardId)
    broadcastLlmSessionStatus()
    const history = piSession.messages.length
    broadcastLog(`[LLM] 会话 ${sessionKey} 已${resumed ? "恢复" : "启动"} (${llmProviderId(resource)} / ${model.id}, history=${history}, MCP=poll/send)`)
    return { ok: true }
  } catch (e: unknown) {
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
      }, { apiKey, maxTokens: 16 }),
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
