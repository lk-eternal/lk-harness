import type { SdkSessionAgent } from "./agent-sdk"
import {
  executeSdkTurn,
  onSdkWorkerFinished,
  unregisterSdkSessionForWorker,
} from "./agent-sdk"
import {
  hostBlockingPoll,
  hostConfirmClaimed,
  hostNonBlockingPoll,
  hostTouchSessionReply,
  isPollEndDirective,
  isPollTimeoutDirective,
  type HostPollResult,
  type PollMessage,
} from "./poll-host"
import { assembleSdkWorkerTurnPrompt, type PromptAssemblyContext } from "./prompt-assembler"
import { appendMirrorTurns, replyTexts } from "./carryover"
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

function sessionKeyEquals(a: string, b: string): boolean {
  if (a === b) return true
  return process.platform === "win32" && a.toLowerCase() === b.toLowerCase()
}

function findWorkerState(sessionKey: string): WorkerState | undefined {
  const exact = workers.get(sessionKey)
  if (exact) return exact
  for (const [k, w] of workers) {
    if (sessionKeyEquals(k, sessionKey)) return w
  }
  return undefined
}

export function isSdkWorkerActive(sessionKey: string): boolean {
  return findWorkerState(sessionKey) !== undefined
}

export function getSdkWorkerPhase(sessionKey: string): SdkWorkerPhase | null {
  return findWorkerState(sessionKey)?.phase ?? null
}

export async function stopSdkWorker(sessionKey: string): Promise<void> {
  const w = findWorkerState(sessionKey)
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

/** 冷启动先 instant poll（不 confirm），避免阻塞 poll 入口误删 .claimed */
async function pollForWorkerTurn(
  state: WorkerState,
  sessionKey: string,
  abort: AbortSignal,
): Promise<HostPollResult> {
  if (state.firstTurn) {
    pushUiLog("SDK", "DEBUG", `[${sessionKey}] worker bootstrap (instant poll)`)
    const instant = await hostNonBlockingPoll(sessionKey)
    if (filterDeliverable(instant.messages).length > 0) return instant
  }
  pushUiLog("SDK", "DEBUG", `[${sessionKey}] worker listening (blocking poll)`)
  return hostBlockingPoll(sessionKey, abort)
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

      let pollResult
      try {
        pollResult = await pollForWorkerTurn(state, sessionKey, abort.signal)
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
        if (session.streamAgg?.ensured) {
          void hostTouchSessionReply(sessionKey).catch(() => {})
        }
        break
      }

      // 镜像：用户原文 + 助手正文（搬运统一源；失败不阻断）
      try {
        const at = replyTexts(session.streamAgg?.segments ?? []).join("\n\n").trim()
        appendMirrorTurns(sessionKey, [
          ...fresh.map((m) => ({ role: "user" as const, text: m.text })),
          ...(at ? [{ role: "assistant" as const, text: at }] : []),
        ])
      } catch { /* ignore */ }

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
