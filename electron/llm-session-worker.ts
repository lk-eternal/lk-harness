import type { LlmLaunchOptions } from "./agent-llm"
import {
  executeLlmPiTurn,
  onLlmWorkerFinished,
  registerLlmSession,
  unregisterLlmSession,
  type LlmWorkerSession,
} from "./agent-llm"
import {
  hostBlockingPoll,
  hostConfirmClaimed,
  hostNonBlockingPoll,
  hostSendText,
  hostTouchSessionReply,
  markMessagesProcessed,
  type HostPollResult,
  type PollMessage,
} from "./poll-host"
import { classifyAgentFailure, type AgentFailureKind } from "./agent-failure"
import { reportAgentFailure } from "./agent-failure-notice"
import { appendMirrorTurns, replyTexts } from "./carryover"
import { assembleTurnPrompt, type HistoryTurn, type PromptAssemblyContext } from "./prompt-assembler"
import { pushUiLog } from "./ui-logger"
import { noteAgentActivity } from "./agent-activity"
import { WORKER_IDLE_EXIT_MS } from "../src/shared/poll-protocol.js"

export type LlmWorkerPhase = "listening" | "processing" | "stopping"

/** 宿主提示词（规则、Skill 名单）的指纹：launched 是拉起时放进系统提示词的那一版，current 现算当前这一版 */
export interface HostPromptProbe {
  launched: string
  current: () => string
}

interface WorkerState {
  session: LlmWorkerSession
  phase: LlmWorkerPhase
  persistentPoll: boolean
  promptCtx: PromptAssemblyContext
  hostPrompt: HostPromptProbe
  taskMessage?: string
  historyTurns?: HistoryTurn[]
  firstTurn: boolean
  /** 记忆只随新账本的第一轮给：账本续上的拉起不再重发 */
  withMemory: boolean
  abort: AbortController
  loopPromise: Promise<void>
}

const workers = new Map<string, WorkerState>()

/** 无 Pi 事件（thinking/tool/text）超过此时间才判超时；有活动则一直等 */
const TURN_NO_ACTIVITY_MS = 30 * 60_000
const TURN_IDLE_CHECK_MS = 15_000

function racePiTurnWithIdleTimeout(
  session: LlmWorkerSession,
  prompt: string,
  abort: AbortSignal,
): Promise<{ ok: boolean; error?: string; replyText?: string; empty?: boolean; resumable?: boolean; fatal?: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | undefined

    const finish = (result: { ok: boolean; error?: string; replyText?: string; empty?: boolean; resumable?: boolean; fatal?: boolean }) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      resolve(result)
    }

    session.lastActivityAt = Date.now()
    timer = setInterval(() => {
      if (abort.aborted) {
        finish({ ok: false, error: "aborted" })
        return
      }
      const idleMs = Date.now() - session.lastActivityAt
      if (idleMs >= TURN_NO_ACTIVITY_MS) {
        const mins = Math.round(TURN_NO_ACTIVITY_MS / 60_000)
        finish({ ok: false, error: `Pi 回合无活动超时（${mins}min）` })
      }
    }, TURN_IDLE_CHECK_MS)

    abort.addEventListener("abort", () => finish({ ok: false, error: "aborted" }), { once: true })

    // resumable：executeLlmPiTurn 自己结算了（含报错），该回合已终止，长连接可以接着用；
    // 超时/abort 早退的不算，那种情况下可能还有 in-flight 回合，只能退出重建
    void executeLlmPiTurn(session, prompt).then(
      (r) => finish({ ...r, resumable: true }),
      (e: unknown) => finish({ ok: false, error: e instanceof Error ? e.message : String(e), resumable: true }),
    )
  })
}

export function isLlmWorkerActive(sessionKey: string): boolean {
  return workers.has(sessionKey)
}

export function getLlmWorkerPhase(sessionKey: string): LlmWorkerPhase | null {
  return workers.get(sessionKey)?.phase ?? null
}

export function listLlmWorkerPhases(): Map<string, LlmWorkerPhase> {
  const out = new Map<string, LlmWorkerPhase>()
  for (const [k, w] of workers) out.set(k, w.phase)
  return out
}

export async function stopLlmWorker(sessionKey: string): Promise<void> {
  const w = workers.get(sessionKey)
  if (!w) return
  w.phase = "stopping"
  w.abort.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      w.loopPromise.catch(() => undefined),
      new Promise<void>((r) => { timer = setTimeout(r, 5000) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function stopAllLlmWorkers(): Promise<void> {
  await Promise.all([...workers.keys()].map((k) => stopLlmWorker(k)))
}

function filterDeliverable(messages: PollMessage[]): PollMessage[] {
  return messages.filter((m) => m.text?.trim() && m.messageId)
}

/** resumed：上一次阻塞 poll 是挂起到点的空返回，这是静默续挂——没有消息被领走，不用再做冷启动检查，也不再写日志 */
async function pollForWorkerTurn(
  state: WorkerState,
  sessionKey: string,
  abort: AbortSignal,
  resumed: boolean,
): Promise<HostPollResult> {
  if (resumed) return hostBlockingPoll(sessionKey, abort)
  if (state.firstTurn) {
    pushUiLog("LLM", "DEBUG", `[${sessionKey}] worker bootstrap (instant poll)`)
    const instant = await hostNonBlockingPoll(sessionKey)
    if (filterDeliverable(instant.messages).length > 0) return instant
  }
  pushUiLog("LLM", "DEBUG", `[${sessionKey}] worker listening (blocking poll)`)
  return hostBlockingPoll(sessionKey, abort)
}

export function startLlmWorkerLoop(
  session: LlmWorkerSession,
  opts: {
    persistentPoll: boolean
    promptCtx: PromptAssemblyContext
    hostPrompt: HostPromptProbe
    taskMessage?: string
    historyTurns?: HistoryTurn[]
    firstTurn: boolean
    withMemory: boolean
  },
): Promise<void> {
  const state: WorkerState = {
    session,
    phase: "listening",
    persistentPoll: opts.persistentPoll,
    promptCtx: opts.promptCtx,
    hostPrompt: opts.hostPrompt,
    taskMessage: opts.taskMessage,
    historyTurns: opts.historyTurns,
    firstTurn: opts.firstTurn,
    withMemory: opts.withMemory,
    abort: session.abort,
    loopPromise: Promise.resolve(),
  }
  workers.set(session.sessionKey, state)
  state.loopPromise = runWorkerLoop(state)
  return state.loopPromise
}

async function runWorkerLoop(state: WorkerState): Promise<void> {
  const { session, abort } = state
  const { sessionKey } = session
  let errored = false
  let errorDetail: string | undefined
  let failureKind: AgentFailureKind | undefined
  /** 正在处理的这批消息：worker 出错退出时，失败提示要回复其中的最后一条 */
  let inFlight: PollMessage[] = []
  /** 上一次阻塞 poll 是挂起到点的空返回：这次是静默续挂 */
  let resumed = false
  /** 空闲从这一刻起算：worker 启动，或上一轮回合结束 */
  let idleSince = Date.now()

  try {
    while (!abort.signal.aborted) {
      // 刚收完一个回合才记一笔（poll 挂起到点后的 continue 不算动静，否则长连接会话每次超时都会刷新）
      if (state.phase === "processing") {
        noteAgentActivity()
        idleSince = Date.now()
      }
      state.phase = "listening"
      inFlight = []

      let pollResult
      try {
        pollResult = await pollForWorkerTurn(state, sessionKey, abort.signal, resumed)
      } catch (e: unknown) {
        if (abort.signal.aborted) break
        throw e
      }
      if (abort.signal.aborted) break

      if (pollResult.reason === "end") {
        pushUiLog("LLM", "INFO", `[${sessionKey}] poll 返回 end（按需唤醒，本回合结束），worker 退出`)
        break
      }
      // 挂起到点是 daemon 的心跳：静默续挂，不逐次写日志（常驻会话每几分钟一条，会成为新的刷屏）
      resumed = pollResult.reason === "timeout"
      if (resumed) {
        // 空闲够久：干净退出（不算异常），下一条消息重新拉起；到点空返回时没有消息被领走，退出不会丢消息
        if (Date.now() - idleSince >= WORKER_IDLE_EXIT_MS) {
          pushUiLog("LLM", "INFO", `[${sessionKey}] 空闲超过 ${WORKER_IDLE_EXIT_MS / 60_000} 分钟，worker 退出（下一条消息会重新拉起，上下文保留）`)
          break
        }
        continue
      }

      const deliverable = filterDeliverable(pollResult.messages)
      if (deliverable.length === 0) continue

      const fresh = deliverable.filter((m) => m.messageId && !session.processedMessageIds.has(m.messageId))
      if (fresh.length === 0) {
        pushUiLog("LLM", "INFO", `[${sessionKey}] worker 跳过已处理消息重投 (${deliverable.length}条)`)
        try { await hostConfirmClaimed(sessionKey) } catch { /* best-effort */ }
        continue
      }

      // 规则或 Skill 名单变了：Pi 的系统提示词在拉起时就定下了。这批消息不确认、不处理，直接退出：
      // daemon 把 .claimed 重投，调度器重新拉起，新 worker 带着新的系统提示词续上账本
      if (state.hostPrompt.current() !== state.hostPrompt.launched) {
        pushUiLog("LLM", "INFO", `[${sessionKey}] 规则或 Skill 名单有变化，worker 退出重建（这批消息保持未确认，由调度器重投）`)
        break
      }

      for (const m of fresh) {
        if (m.messageId) session.seenMessageIds.add(m.messageId)
      }
      // 出生对齐：预热队列早于投递收口时首 ensure 会被误杀丢头，未发过卡此刻重定无成本
      try {
        const { rebaseUnensuredQueue } = await import("./stream-card.js")
        rebaseUnensuredQueue(session)
      } catch { /* best-effort */ }

      state.phase = "processing"
      inFlight = fresh
      noteAgentActivity()
      const prompt = assembleTurnPrompt(fresh, state.promptCtx, {
        withMemory: state.withMemory,
        taskMessage: state.firstTurn ? state.taskMessage : undefined,
        historyTurns: state.firstTurn ? state.historyTurns : undefined,
      })
      state.firstTurn = false
      state.withMemory = false
      state.taskMessage = undefined
      state.historyTurns = undefined

      pushUiLog("LLM", "INFO", `[${sessionKey}] worker 处理 ${fresh.length} 条消息`)

      const turnResult = await racePiTurnWithIdleTimeout(session, prompt, abort.signal)

      if (abort.signal.aborted) break
      if (!turnResult.ok) {
        const msg = turnResult.error ?? "unknown"
        pushUiLog("LLM", "WARN", `[${sessionKey}] Pi 回合失败: ${msg}`)
        if (!turnResult.resumable || turnResult.fatal) {
          // fatal：通道已换 Agent 资源，这批消息不标已处理，退出后由新引擎重新拉起；
          // 那是用户自己的操作，不算故障，不提示
          errored = true
          errorDetail = turnResult.error
          failureKind = classifyAgentFailure(msg)
          if (turnResult.fatal) inFlight = []
          break
        }
        // 回合已结束（模型/网关报错）：这批消息不能重放，但 worker 也不必陪葬
        // 认领与内存标记一体：否则 daemon 把这批 .claimed 重投，worker 重启后内存里的
        // processedMessageIds 没了就会再跑一次同样的失败回合（同一错误在卡片上出现两遍）
        await markMessagesProcessed(session, sessionKey, fresh)
        // 提示是对用户消息的独立回复，不并进流式卡（卡片里照旧有 Pi 的原始报错），所以各通道都发
        await reportAgentFailure(sessionKey, {
          kind: classifyAgentFailure(msg),
          detail: msg,
          retry: "resend",
          replyToMessageId: fresh.map((m) => m.messageId).filter(Boolean).pop(),
        })
        // 提示算这一轮的出站：不 touch 的话，非流式通道下 Daemon 会把这一轮当成没有回复
        try { await hostTouchSessionReply(sessionKey) } catch { /* best-effort */ }
        continue
      }

      // 空回复显式化：零出站时给可见兜底 + touch，否则 Daemon 判黑洞重投后跳过即吞消息
      if (turnResult.empty) {
        pushUiLog("LLM", "WARN", `[${sessionKey}] Pi 回合空回复，已发兜底`)
        const replyToId = fresh.map((m) => m.messageId).filter(Boolean).pop()
        try {
          await hostSendText(`⚠️ 本回合模型无有效输出，请再发一次（会话仍在线）`, sessionKey, replyToId)
        } catch (e: unknown) {
          errored = true
          errorDetail = e instanceof Error ? e.message : String(e)
          pushUiLog("LLM", "ERROR", `[${sessionKey}] 空回复兜底投递失败: ${errorDetail}`)
          break
        }
        // 镜像：用户原文 + 引用（兜底文本不记，避免污染）
        try {
          appendMirrorTurns(sessionKey, fresh.map((m) => ({ role: "user" as const, text: m.text, ...(m.meta?.quoted_message ? { quoted_message: m.meta.quoted_message } : {}) })))
        } catch { /* ignore */ }
        try { await hostTouchSessionReply(sessionKey) } catch { /* best-effort */ }
        await markMessagesProcessed(session, sessionKey, fresh)
        continue
      }

      // 微信等非流式通道：卡片跳过时仍走文本投递
      const replyText = turnResult.replyText?.trim()
      if (replyText) {
        const replyToId = fresh.map((m) => m.messageId).filter(Boolean).pop()
        try {
          await hostSendText(replyText, sessionKey, replyToId)
        } catch (e: unknown) {
          errored = true
          errorDetail = e instanceof Error ? e.message : String(e)
          pushUiLog("LLM", "ERROR", `[${sessionKey}] 非流式通道投递失败: ${errorDetail}`)
          break
        }
      } else {
        // 流式成功也要 touch：finish 投递失败时同样零出站，对齐 SDK 避免黑洞误判
        try { await hostTouchSessionReply(sessionKey) } catch { /* best-effort */ }
      }

      // 镜像：用户原文 + 引用 + 助手正文（搬运统一源；失败不阻断）
      try {
        const at = (replyText || replyTexts(session.streamAgg?.segments ?? []).join("\n\n")).trim()
        appendMirrorTurns(sessionKey, [
          ...fresh.map((m) => ({ role: "user" as const, text: m.text, ...(m.meta?.quoted_message ? { quoted_message: m.meta.quoted_message } : {}) })),
          ...(at ? [{ role: "assistant" as const, text: at }] : []),
        ])
      } catch { /* ignore */ }

      await markMessagesProcessed(session, sessionKey, fresh)

      try {
        const { rolloverSessionLedgerIfNeeded } = await import("./session-retention.js")
        if (await rolloverSessionLedgerIfNeeded({ runtime: "llm", sessionKey })) {
          pushUiLog("LLM", "INFO", `[${sessionKey}] 账本超限，已清 pi 账本并用 mirror 冷启动`)
          break
        }
      } catch { /* ignore */ }
    }
  } catch (e: unknown) {
    if (!abort.signal.aborted) {
      errored = true
      errorDetail = e instanceof Error ? e.message : String(e)
      failureKind = classifyAgentFailure(errorDetail)
    }
  } finally {
    noteAgentActivity()
    state.phase = "stopping"
    if (workers.get(sessionKey) === state) workers.delete(sessionKey)
    try {
      await unregisterLlmSession(session)
    } catch (e: unknown) {
      pushUiLog("LLM", "WARN", `[${sessionKey}] worker unregister 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      onLlmWorkerFinished(sessionKey, errored, {
        kind: failureKind,
        errorDetail,
        replyToMessageId: inFlight.map((m) => m.messageId).filter(Boolean).pop(),
      })
    } catch (e: unknown) {
      pushUiLog("LLM", "WARN", `[${sessionKey}] worker finished 回调失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
