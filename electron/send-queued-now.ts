import type { InterruptTurnResult } from "./agent-engine/types"

/**
 * 暂存区「立即发送」：让排队中的消息现在就交给 Agent 处理。
 *
 * 原来的做法是「停掉 Agent → 重新拉起」：停要 2~3 秒，重新拉起要 Resume（走网络，偶发卡 30 秒以上）。
 * 现在优先软打断：只取消当前这一轮，Agent 不退出，自己回去领排队的消息（引擎不支持/不适用/超时才回退到旧做法）。
 */

export interface QueuedMessageRef {
  fileId: string
  sessionKey?: string
  /** pending = 排队待投递；processing = 已投递给 Agent 待回复确认 */
  status?: string
}

export interface SendQueuedNowDeps {
  getQueue(): Promise<QueuedMessageRef[]>
  deleteMessage(fileId: string): Promise<unknown>
  normalizeKey(sessionKey: string | undefined): string
  isRunning(sessionKey: string): boolean
  interruptTurn(sessionKey: string): Promise<InterruptTurnResult>
  stopAgent(sessionKey: string): Promise<void>
  dispatch(): Promise<void>
  /** 稍后再执行（生产里是 setTimeout） */
  later(fn: () => void, ms: number): void
  log(level: "INFO" | "WARN", msg: string): void
}

/**
 * - soft：当前回合已打断（或刚好结束），Agent 没动，排队的消息由它自己领走
 * - launching：Agent 正在拉起，不去打扰（重启只会更慢），拉起后第一次轮询就会领到
 * - relaunch：当时没有 Agent 在跑（或打断途中它退出了），重新调度拉起
 * - hard：软打断不适用或超时，停止当前 Agent 后重新拉起（旧做法）
 */
export type SendQueuedNowVia = "soft" | "launching" | "relaunch" | "hard"

export interface SendQueuedNowResult {
  ok: boolean
  error?: string
  via?: SendQueuedNowVia
}

/** interruptRunningEngine 只关心引擎的这两个方法 */
export interface InterruptibleEngine {
  isRunning(sessionKey: string): boolean
  interruptTurn?(sessionKey: string): Promise<InterruptTurnResult>
}

/**
 * 找到正在跑这个会话的引擎去软打断。
 * - 引擎没实现 interruptTurn：unsupported（调用方退回停止 + 重新拉起）
 * - 没有引擎在跑，但调度器已经为它预留了名额：launching（正要拉起，引擎还没登记）
 * - 都没有：not-running
 */
export async function interruptRunningEngine(
  sessionKey: string,
  engines: InterruptibleEngine[],
  launchReserved: boolean,
): Promise<InterruptTurnResult> {
  for (const e of engines) {
    if (!e.isRunning(sessionKey)) continue
    return e.interruptTurn ? e.interruptTurn(sessionKey) : "unsupported"
  }
  return launchReserved ? "launching" : "not-running"
}

/** 调度正好在进行中时 dispatch 会直接返回；稍后补一次，避免消息等到下一轮 5 秒轮询 */
const REDISPATCH_AFTER_MS = 1500

export async function sendQueuedNowFlow(sessionKey: string, deps: SendQueuedNowDeps): Promise<SendQueuedNowResult> {
  const target = deps.normalizeKey(sessionKey) || sessionKey
  const mineOf = async () => (await deps.getQueue())
    .filter((m) => (deps.normalizeKey(m.sessionKey) || m.sessionKey) === target)

  const mine = await mineOf()
  if (!mine.some((m) => m.status !== "processing")) return { ok: false, error: "没有排队中的消息" }

  const redispatchLater = () => deps.later(() => { void deps.dispatch().catch(() => undefined) }, REDISPATCH_AFTER_MS)

  /** 要重新拉起的路径：被打断的那一回合的消息（已投递、待确认）先确认掉，否则新 Agent 会把它当没做完的活再投递一遍 */
  const confirmStaleProcessing = async () => {
    for (const m of (await mineOf())) {
      if (m.status !== "processing") continue
      try { await deps.deleteMessage(m.fileId) } catch { /* ignore */ }
    }
  }
  const relaunch = async (): Promise<void> => {
    await confirmStaleProcessing()
    await deps.dispatch()
    redispatchLater()
  }

  if (!deps.isRunning(sessionKey)) {
    await relaunch()
    return { ok: true, via: "relaunch" }
  }

  let interrupted: InterruptTurnResult
  try {
    interrupted = await deps.interruptTurn(sessionKey)
  } catch (e: unknown) {
    deps.log("WARN", `[${sessionKey}] 软打断出错，改为停止后重新拉起: ${e instanceof Error ? e.message : String(e)}`)
    interrupted = "unsupported"
  }

  switch (interrupted) {
    case "interrupted":
    case "no-turn":
      deps.log("INFO", `[${sessionKey}] 立即发送：${interrupted === "interrupted" ? "已打断当前回合" : "当前没有进行中的回合"}，Agent 不重启`)
      // 保险：打断完 Agent 恰好退出时，由调度补拉起
      redispatchLater()
      return { ok: true, via: "soft" }
    case "launching":
      deps.log("INFO", `[${sessionKey}] 立即发送：Agent 正在拉起，排队的消息等它起来就会领走`)
      return { ok: true, via: "launching" }
    case "exited":
    case "not-running":
      deps.log("INFO", `[${sessionKey}] 立即发送：Agent 已退出，重新拉起`)
      await relaunch()
      return { ok: true, via: "relaunch" }
    default:
      // unsupported / timeout
      deps.log("WARN", `[${sessionKey}] 立即发送：软打断${interrupted === "timeout" ? "超时" : "不适用"}，停止后重新拉起`)
      await confirmStaleProcessing()
      await deps.stopAgent(sessionKey)
      await deps.dispatch()
      redispatchLater()
      return { ok: true, via: "hard" }
  }
}
