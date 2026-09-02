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
  hostSendText,
  isPollEndDirective,
  isPollTimeoutDirective,
  type PollMessage,
} from "./poll-host"
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
): Promise<{ ok: boolean; error?: string; replyText?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | undefined

    const finish = (result: { ok: boolean; error?: string; replyText?: string }) => {
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

    void executeLlmPiTurn(session, prompt).then(finish, (e: unknown) => {
      finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
    })
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

  registerLlmSession(session)

  try {
    while (!abort.signal.aborted) {
      state.phase = "listening"
      pushUiLog("LLM", "DEBUG", `[${sessionKey}] worker listening (blocking poll)`)

      let pollResult
      try {
        pollResult = await hostBlockingPoll(sessionKey, abort.signal)
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
        errored = true
        errorDetail = turnResult.error
        const msg = errorDetail ?? "unknown"
        networkFail = /fetch failed|ECONNRESET|timeout|network/i.test(msg)
        permanentFail = !networkFail && /401|403|api key|quota|rate limit/i.test(msg)
        pushUiLog("LLM", "WARN", `[${sessionKey}] Pi 回合失败: ${msg}`)
        break
      }

      for (const m of fresh) {
        if (m.messageId) session.processedMessageIds.add(m.messageId)
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
