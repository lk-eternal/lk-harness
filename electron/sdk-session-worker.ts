import type { SdkSessionAgent } from "./agent-sdk"
import {
  executeSdkTurn,
  onSdkWorkerFinished,
  unregisterSdkSessionForWorker,
} from "./agent-sdk"
import {
  hostBlockingPoll,
  hostConfirmClaimed,
  isPollEndDirective,
  isPollTimeoutDirective,
  type PollMessage,
} from "./poll-host"
import { assembleSdkWorkerTurnPrompt, type PromptAssemblyContext } from "./prompt-assembler"
import { pushUiLog } from "./ui-logger"

export type SdkWorkerPhase = "listening" | "processing" | "stopping"

interface WorkerState {
  session: SdkSessionAgent
  phase: SdkWorkerPhase
  persistentPoll: boolean
  promptCtx: PromptAssemblyContext
  taskMessage?: string
  firstTurn: boolean
  abort: AbortController
  loopPromise: Promise<void>
}

const workers = new Map<string, WorkerState>()

export function isSdkWorkerActive(sessionKey: string): boolean {
  return workers.has(sessionKey)
}

export function getSdkWorkerPhase(sessionKey: string): SdkWorkerPhase | null {
  return workers.get(sessionKey)?.phase ?? null
}

export async function stopSdkWorker(sessionKey: string): Promise<void> {
  const w = workers.get(sessionKey)
  if (!w) return
  w.phase = "stopping"
  w.abort.abort()
  w.session.abortController.abort()
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

export async function stopAllSdkWorkers(): Promise<void> {
  await Promise.all([...workers.keys()].map((k) => stopSdkWorker(k)))
}

function filterDeliverable(messages: PollMessage[]): PollMessage[] {
  return messages.filter((m) => m.text?.trim() && m.messageId)
}

export function startSdkWorkerLoop(
  session: SdkSessionAgent,
  opts: {
    persistentPoll: boolean
    promptCtx: PromptAssemblyContext
    taskMessage?: string
    firstTurn: boolean
  },
): Promise<void> {
  const abort = new AbortController()
  const state: WorkerState = {
    session,
    phase: "listening",
    persistentPoll: opts.persistentPoll,
    promptCtx: opts.promptCtx,
    taskMessage: opts.taskMessage,
    firstTurn: opts.firstTurn,
    abort,
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
    while (!abort.signal.aborted && !session.abortController.signal.aborted) {
      state.phase = "listening"
      pushUiLog("SDK", "DEBUG", `[${sessionKey}] worker listening (blocking poll)`)

      let pollResult
      try {
        pollResult = await hostBlockingPoll(sessionKey, abort.signal)
      } catch (e: unknown) {
        if (abort.signal.aborted || session.abortController.signal.aborted) break
        throw e
      }
      if (abort.signal.aborted || session.abortController.signal.aborted) break

      if (isPollEndDirective(pollResult.directive)) {
        pushUiLog("SDK", "INFO", `[${sessionKey}] worker 收到安静退出 directive，结束`)
        break
      }
      if (isPollTimeoutDirective(pollResult.directive)) {
        pushUiLog("SDK", "DEBUG", `[${sessionKey}] poll 超时保活，继续监听`)
        continue
      }

      const deliverable = filterDeliverable(pollResult.messages)
      if (deliverable.length === 0) continue

      const fresh = deliverable.filter((m) => m.messageId && !session.processedMessageIds.has(m.messageId))
      if (fresh.length === 0) {
        pushUiLog("SDK", "INFO", `[${sessionKey}] worker 跳过已处理消息重投 (${deliverable.length}条)`)
        try { await hostConfirmClaimed(sessionKey) } catch { /* best-effort */ }
        continue
      }

      for (const m of fresh) {
        if (m.messageId) session.seenMessageIds.add(m.messageId)
      }

      state.phase = "processing"
      const prompt = assembleSdkWorkerTurnPrompt(fresh, state.promptCtx, {
        firstTurn: state.firstTurn,
        taskMessage: state.firstTurn ? state.taskMessage : undefined,
      })
      state.firstTurn = false
      state.taskMessage = undefined

      pushUiLog("SDK", "INFO", `[${sessionKey}] worker 处理 ${fresh.length} 条消息`)

      const turnResult = await executeSdkTurn(session, prompt)
      if (abort.signal.aborted || session.abortController.signal.aborted) break

      if (!turnResult.ok) {
        errored = true
        errorDetail = turnResult.errorDetail
        networkFail = turnResult.networkFail
        permanentFail = turnResult.permanentFail
        pushUiLog("SDK", "WARN", `[${sessionKey}] SDK 回合失败: ${errorDetail ?? "unknown"}`)
        break
      }

      for (const m of fresh) {
        if (m.messageId) session.processedMessageIds.add(m.messageId)
      }

      if (!state.persistentPoll) {
        pushUiLog("SDK", "INFO", `[${sessionKey}] 按需唤醒模式，回合结束退出 worker`)
        break
      }
    }
  } catch (e: unknown) {
    if (!abort.signal.aborted && !session.abortController.signal.aborted) {
      errored = true
      errorDetail = e instanceof Error ? e.message : String(e)
      networkFail = /fetch failed|ECONNRESET|timeout|network/i.test(errorDetail)
    }
  } finally {
    state.phase = "stopping"
    if (workers.get(sessionKey) === state) workers.delete(sessionKey)
    try {
      await unregisterSdkSessionForWorker(session, abort.signal.aborted || session.abortController.signal.aborted)
    } catch (e: unknown) {
      pushUiLog("SDK", "WARN", `[${sessionKey}] worker unregister 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      onSdkWorkerFinished(sessionKey, errored, { network: networkFail, permanent: permanentFail, errorDetail })
    } catch (e: unknown) {
      pushUiLog("SDK", "WARN", `[${sessionKey}] worker finished 回调失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
