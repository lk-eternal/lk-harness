import type { QueuedMessageRef } from "./send-queued-now"

/**
 * 重置会话（/reset、AI 调 manage_agent 的 reset、会话管理页的「重置」）：
 * 停掉 Agent、丢掉它的上下文，下条消息起一个全新会话。
 *
 * 重置之前要先把「已投递给旧 Agent、还没确认处理完」的消息（队列里 processing 那种）丢掉：
 * 这类消息是「至少一次投递」的保险——Agent 掉线后，调度器看到它们还在就会重新拉起 Agent 重投。
 * 重置是用户（或 Agent 自己）主动叫停的，不是掉线。不丢的话，新 Agent 一起来就领到同一批消息：
 * 「重置一下会话」被当成新活再执行一遍、再重置、再被重投……一直循环，用户新发的消息也被卷进去一起重投。
 *
 * 两个顺序上的要求：
 * - 先丢再停：旧 Agent 一退出，调度器马上就会看队列，停完再丢就来不及了；
 * - 只丢已投递的：还在排队、没投递的（pending）是重置之后才该处理的，留着，新会话会领到。
 */

export interface ResetSessionDeps {
  getQueue(): Promise<QueuedMessageRef[]>
  /** 删掉一条队列消息；删成功返回 true */
  deleteMessage(fileId: string): Promise<boolean>
  normalizeKey(sessionKey: string | undefined): string
  isRunning(sessionKey: string): boolean
  stopAgent(sessionKey: string): Promise<void>
  /** 清 resume、账本、镜像和待搬运块 */
  resetContext(sessionKey: string): void
  log(level: "INFO" | "WARN", msg: string): void
}

export interface ResetSessionResult {
  /** 重置时有 Agent 在跑，已被停掉 */
  stopped: boolean
  /** 丢掉了几条「已投递、没确认」的旧消息 */
  dropped: number
}

/** 这个会话里已投递给 Agent、还没确认的消息；读队列失败（daemon 不可达等）当作没有，不挡住重置本身 */
async function listDeliveredMessages(sessionKey: string, deps: ResetSessionDeps): Promise<QueuedMessageRef[]> {
  const target = deps.normalizeKey(sessionKey) || sessionKey
  try {
    return (await deps.getQueue())
      .filter((m) => m.status === "processing" && (deps.normalizeKey(m.sessionKey) || m.sessionKey) === target)
  } catch (e: unknown) {
    deps.log("WARN", `[${sessionKey}] 重置：读不到队列，已投递的旧消息没能清掉: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

export async function resetSessionFlow(sessionKey: string, deps: ResetSessionDeps): Promise<ResetSessionResult> {
  let dropped = 0
  for (const m of await listDeliveredMessages(sessionKey, deps)) {
    try {
      if (await deps.deleteMessage(m.fileId)) dropped++
    } catch { /* 这一条没删掉不挡住别的；残留的最多让调度器再重投一次 */ }
  }
  if (dropped > 0) deps.log("INFO", `[${sessionKey}] 重置：丢弃 ${dropped} 条已投递给旧 Agent 的消息，不再重投`)

  const stopped = deps.isRunning(sessionKey)
  if (stopped) await deps.stopAgent(sessionKey)
  deps.resetContext(sessionKey)
  return { stopped, dropped }
}
