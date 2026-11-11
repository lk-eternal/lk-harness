import type { SdkSessionAgent } from "./agent-sdk"
import {
  executeSdkTurn,
  finishInterruptedTurn,
  onSdkWorkerFinished,
  unregisterSdkSessionForWorker,
} from "./agent-sdk"
import {
  hostBlockingPoll,
  hostConfirmClaimed,
  hostNonBlockingPoll,
  hostTouchSessionReply,
  markMessagesProcessed,
  type HostPollResult,
  type PollMessage,
} from "./poll-host"
import { assembleSdkWorkerTurnPrompt, type HistoryTurn, type PromptAssemblyContext } from "./prompt-assembler"
import { appendMirrorTurns, replyTexts } from "./carryover"
import { pushUiLog } from "./ui-logger"
import type { InterruptTurnResult } from "./agent-engine/types"

export type SdkWorkerPhase = "listening" | "processing" | "stopping"

/** 要随第一轮交给模型的 Skill 名单；hash 是名单指纹，交付成功后记到会话上 */
export interface SkillCatalogInjection {
  text: string
  hash: string
}

interface WorkerState {
  session: SdkSessionAgent
  phase: SdkWorkerPhase
  persistentPoll: boolean
  promptCtx: PromptAssemblyContext
  taskMessage?: string
  historyTurns?: HistoryTurn[]
  /** 还没交给模型的 Skill 名单：第一轮带上，之后清掉 */
  skillCatalog?: SkillCatalogInjection
  firstTurn: boolean
  abort: AbortController
  loopPromise: Promise<void>
  /** 正在 executeSdkTurn 里（从调用到返回，同步置位/复位，供软打断判断有没有回合可打断） */
  inTurn: boolean
  /** 软打断在等：worker 回到监听（或退出）时唤醒 */
  turnEndWaiters: Array<() => void>
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

/** 取消会话当前的 run（best-effort，不等待结果；没有进行中的 run 就什么都不做） */
export function cancelRunQuietly(session: { run: { cancel(): Promise<unknown> } | null }): void {
  const run = session.run
  if (!run) return
  try {
    void Promise.resolve(run.cancel()).catch(() => undefined)
  } catch { /* cancel 同步抛错也不影响停止流程 */ }
}

export async function stopSdkWorker(sessionKey: string): Promise<void> {
  const w = findWorkerState(sessionKey)
  if (!w) return
  w.phase = "stopping"
  w.abort.abort()
  w.session.abortController.abort()
  // 事件流只会在下一个事件到来或 run 结束时才发现 abort：Agent 正卡在长工具调用（等 shell、等网络）时
  // 不会有事件，worker 要一直挂到下面的超时才退出——「停止」「立即发送」都白等 5 秒。
  // 所以这里直接 cancel 当前 run，让事件流立刻收尾
  cancelRunQuietly(w.session)
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

/** 软打断等回合收口的时限：取消一般 2~3.5 秒生效，超过说明卡在长工具调用里，交给调用方走硬停止 */
export const SDK_INTERRUPT_TIMEOUT_MS = 6_000

function flushTurnEndWaiters(state: WorkerState): void {
  const waiters = state.turnEndWaiters.splice(0)
  for (const wake of waiters) wake()
}

/**
 * 软打断：只取消当前这一轮，worker 和 Agent 都不退出，回合收口后自己回去监听、领排队的消息。
 * 用于「立即发送」——原来是停掉 Agent 再 Resume 重建，Resume 要走网络，偶发卡 30 秒以上。
 *
 * 返回值告诉调用方还要不要自己兜底：只有 interrupted 表示已经完成；其余都由调用方决定怎么走。
 */
export async function interruptSdkWorkerTurn(
  sessionKey: string,
  timeoutMs: number = SDK_INTERRUPT_TIMEOUT_MS,
): Promise<InterruptTurnResult> {
  const w = findWorkerState(sessionKey)
  if (!w) return "not-running"
  // 按需唤醒的 worker 回合一结束就退出，没有「回去监听」可言
  if (!w.persistentPoll) return "unsupported"
  if (w.abort.signal.aborted || w.session.abortController.signal.aborted) return "exited"
  if (!w.inTurn) return "no-turn"

  const { session } = w
  // 先登记标记和等待，再 cancel：send 还没返回 run 的短窗口里 cancel 没有对象，executeSdkTurn 拿到 run 后会看标记补一刀
  session.interruptRequested = true
  let wake: () => void = () => undefined
  const settled = new Promise<void>((resolve) => { wake = resolve; w.turnEndWaiters.push(resolve) })
  cancelRunQuietly(session)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    settled.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) }),
  ])
  if (timer) clearTimeout(timer)

  if (timedOut) {
    const i = w.turnEndWaiters.indexOf(wake)
    if (i >= 0) w.turnEndWaiters.splice(i, 1)
    // 撤回标记：调用方接着会走硬停止；万一回合之后自己结束，也别被当成打断
    session.interruptRequested = false
    pushUiLog("SDK", "WARN", `[${sessionKey}] 软打断 ${timeoutMs / 1000}s 内回合没收口，交给调用方走停止+重启`)
    return "timeout"
  }
  const alive = findWorkerState(sessionKey) === w
    && !w.abort.signal.aborted
    && !session.abortController.signal.aborted
  return alive ? "interrupted" : "exited"
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
    historyTurns?: HistoryTurn[]
    skillCatalog?: SkillCatalogInjection
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
    historyTurns: opts.historyTurns,
    skillCatalog: opts.skillCatalog,
    firstTurn: opts.firstTurn,
    abort,
    loopPromise: Promise.resolve(),
    inTurn: false,
    turnEndWaiters: [],
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
      flushTurnEndWaiters(state)

      let pollResult
      try {
        pollResult = await pollForWorkerTurn(state, sessionKey, abort.signal)
      } catch (e: unknown) {
        if (abort.signal.aborted || session.abortController.signal.aborted) break
        throw e
      }
      if (abort.signal.aborted || session.abortController.signal.aborted) break

      if (pollResult.reason === "end") {
        pushUiLog("SDK", "INFO", `[${sessionKey}] poll 返回 end（按需唤醒，本回合结束），worker 退出`)
        break
      }
      if (pollResult.reason === "timeout") {
        pushUiLog("SDK", "DEBUG", `[${sessionKey}] poll 挂起到点，继续监听`)
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

      // 出生对齐：预热队列早于投递收口时首 ensure 会被误杀丢头，未发过卡此刻重定无成本
      try {
        const { rebaseUnensuredQueue } = await import("./stream-card.js")
        rebaseUnensuredQueue(session)
      } catch { /* best-effort */ }

      state.phase = "processing"
      const prompt = assembleSdkWorkerTurnPrompt(fresh, state.promptCtx, {
        firstTurn: state.firstTurn,
        taskMessage: state.firstTurn ? state.taskMessage : undefined,
        historyTurns: state.firstTurn ? state.historyTurns : undefined,
        skillCatalog: state.skillCatalog?.text,
      })
      const sentCatalog = state.skillCatalog
      state.firstTurn = false
      state.taskMessage = undefined
      state.historyTurns = undefined
      state.skillCatalog = undefined

      pushUiLog("SDK", "INFO", `[${sessionKey}] worker 处理 ${fresh.length} 条消息`)

      state.inTurn = true
      let turnResult: Awaited<ReturnType<typeof executeSdkTurn>>
      try {
        turnResult = await executeSdkTurn(session, prompt)
      } finally {
        state.inTurn = false
      }
      // 只管这一轮：读完立刻清，避免残留到下一轮
      const interrupted = session.interruptRequested === true
      session.interruptRequested = false
      if (abort.signal.aborted || session.abortController.signal.aborted) break

      // 名单已经随这一轮交给了模型（被软打断的回合模型也看过了）：记下指纹，之后的轮次和下次 Resume 都不用再带；
      // 回合失败没记，下次拉起会再带一次
      if (sentCatalog && (turnResult.ok || interrupted)) session.skillsHash = sentCatalog.hash

      // 被软打断的回合：取消引发的错误状态不算失败，worker 继续监听
      if (!turnResult.ok && !interrupted) {
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

      // 镜像：用户原文 + 引用 + 助手正文（搬运统一源；失败不阻断）
      try {
        const at = replyTexts(session.streamAgg?.segments ?? []).join("\n\n").trim()
        appendMirrorTurns(sessionKey, [
          ...fresh.map((m) => ({ role: "user" as const, text: m.text, ...(m.meta?.quoted_message ? { quoted_message: m.meta.quoted_message } : {}) })),
          ...(at ? [{ role: "assistant" as const, text: at }] : []),
        ])
      } catch { /* ignore */ }

      if (interrupted) {
        pushUiLog("SDK", "INFO", `[${sessionKey}] 回合被「立即发送」打断，Agent 不退出，去领排队的消息`)
        // 在确认旧消息、领新消息之前把这一轮的卡封成「已打断」：保证聊天里先是被打断的卡，再是新回合的卡
        try { await finishInterruptedTurn(session) } catch { /* best-effort */ }
      }

      await markMessagesProcessed(session, sessionKey, fresh)

      try {
        const { rolloverSessionLedgerIfNeeded } = await import("./session-retention.js")
        if (await rolloverSessionLedgerIfNeeded({
          runtime: "sdk",
          sessionKey,
          workspaceDir: session.workspaceDir,
        })) {
          session.ledgerRollover = true
          pushUiLog("SDK", "INFO", `[${sessionKey}] 账本超限，已清 SDK store 并用 mirror 冷启动`)
          break
        }
      } catch { /* ignore */ }

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
    flushTurnEndWaiters(state)
  }
}
