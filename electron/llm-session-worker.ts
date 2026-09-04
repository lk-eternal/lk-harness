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
  isPollEndDirective,
  isPollTimeoutDirective,
  type HostPollResult,
  type PollMessage,
} from "./poll-host"
import { isFeishuStreamEnabled } from "./stream-card"
import { appendMirrorTurns, replyTexts } from "./carryover"
import { assembleTurnPrompt, type PromptAssemblyContext } from "./prompt-assembler"
import { pushUiLog } from "./ui-logger"

export type LlmWorkerPhase = "listening" | "processing" | "stopping"

interface WorkerState {
  session: LlmWorkerSession
  phase: LlmWorkerPhase
  persistentPoll: boolean
  promptCtx: PromptAssemblyContext
  taskMessage?: string
  firstTurn: boolean
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

async function pollForWorkerTurn(
  state: WorkerState,
  sessionKey: string,
  abort: AbortSignal,
): Promise<HostPollResult> {
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
    taskMessage?: string
    firstTurn: boolean
  },
): Promise<void> {
  const state: WorkerState = {
    session,
    phase: "listening",
    persistentPoll: opts.persistentPoll,
    promptCtx: opts.promptCtx,
    taskMessage: opts.taskMessage,
    firstTurn: opts.firstTurn,
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
  let networkFail = false
  let permanentFail = false

  try {
    while (!abort.signal.aborted) {
      state.phase = "listening"

      let pollResult
      try {
        pollResult = await pollForWorkerTurn(state, sessionKey, abort.signal)
      } catch (e: unknown) {
        if (abort.signal.aborted) break
        throw e
      }
      if (abort.signal.aborted) break

      if (isPollEndDirective(pollResult.directive)) {
        pushUiLog("LLM", "INFO", `[${sessionKey}] worker 收到安静退出 directive，结束`)
        break
      }
      if (isPollTimeoutDirective(pollResult.directive)) {
        pushUiLog("LLM", "DEBUG", `[${sessionKey}] poll 超时保活，继续监听`)
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

      for (const m of fresh) {
        if (m.messageId) session.seenMessageIds.add(m.messageId)
      }

      state.phase = "processing"
      const prompt = assembleTurnPrompt(fresh, state.promptCtx, {
        firstTurn: state.firstTurn,
        taskMessage: state.firstTurn ? state.taskMessage : undefined,
      })
      state.firstTurn = false
      state.taskMessage = undefined

      pushUiLog("LLM", "INFO", `[${sessionKey}] worker 处理 ${fresh.length} 条消息`)

      const turnResult = await racePiTurnWithIdleTimeout(session, prompt, abort.signal)

      if (abort.signal.aborted) break
      if (!turnResult.ok) {
        const msg = turnResult.error ?? "unknown"
        pushUiLog("LLM", "WARN", `[${sessionKey}] Pi 回合失败: ${msg}`)
        if (!turnResult.resumable || turnResult.fatal) {
          // fatal：通道已换 Agent 资源，这批消息不标已处理，退出后由新引擎重新拉起
          errored = true
          errorDetail = turnResult.error
          networkFail = /fetch failed|ECONNRESET|timeout|network/i.test(msg)
          permanentFail = !networkFail && /401|403|api key|quota|rate limit/i.test(msg)
          break
        }
        // 回合已结束（模型/网关报错）：这批消息不能重放，但 worker 也不必陪葬
        for (const m of fresh) {
          if (m.messageId) session.processedMessageIds.add(m.messageId)
        }
        // 必须确认这一次 claim：否则 daemon 把这批 .claimed 重投，worker 重启后内存里的
        // processedMessageIds 没了就会再跑一次同样的失败回合（同一错误在卡片上出现两遍）
        try { await hostConfirmClaimed(sessionKey) } catch { /* best-effort */ }
        // 流式卡片已会把 Pi 的 errorMessage 渲染进卡片，再发一条 hostSendText 会被合并进同一张卡导致重影
        if (!isFeishuStreamEnabled(sessionKey)) {
          try {
            await hostSendText(
              `⚠️ 本回合失败：${msg}\n（会话仍在线，可直接继续发送）`,
              sessionKey,
              fresh.map((m) => m.messageId).filter(Boolean).pop(),
            )
          } catch (e: unknown) {
            pushUiLog("LLM", "ERROR", `[${sessionKey}] 失败回执投递异常: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
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
      // 镜像：用户原文（兜底文本不记，避免污染）
      try {
        appendMirrorTurns(sessionKey, fresh.map((m) => ({ role: "user" as const, text: m.text })))
      } catch { /* ignore */ }
      try { await hostTouchSessionReply(sessionKey) } catch { /* best-effort */ }
      try { await hostConfirmClaimed(sessionKey) } catch { /* best-effort */ }
        for (const m of fresh) {
          if (m.messageId) session.processedMessageIds.add(m.messageId)
        }
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

      // 镜像：用户原文 + 助手正文（搬运统一源；失败不阻断）
      try {
        const at = (replyText || replyTexts(session.streamAgg?.segments ?? []).join("\n\n")).trim()
        appendMirrorTurns(sessionKey, [
          ...fresh.map((m) => ({ role: "user" as const, text: m.text })),
          ...(at ? [{ role: "assistant" as const, text: at }] : []),
        ])
      } catch { /* ignore */ }

      for (const m of fresh) {
        if (m.messageId) session.processedMessageIds.add(m.messageId)
      }
    }
  } catch (e: unknown) {
    if (!abort.signal.aborted) {
      errored = true
      errorDetail = e instanceof Error ? e.message : String(e)
      networkFail = /fetch failed|ECONNRESET|timeout|network/i.test(errorDetail)
    }
  } finally {
    state.phase = "stopping"
    if (workers.get(sessionKey) === state) workers.delete(sessionKey)
    try {
      await unregisterLlmSession(session, abort.signal.aborted)
    } catch (e: unknown) {
      pushUiLog("LLM", "WARN", `[${sessionKey}] worker unregister 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      onLlmWorkerFinished(sessionKey, errored, { network: networkFail, permanent: permanentFail, errorDetail })
    } catch (e: unknown) {
      pushUiLog("LLM", "WARN", `[${sessionKey}] worker finished 回调失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
