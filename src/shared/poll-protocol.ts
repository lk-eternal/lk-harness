/**
 * poll-message 协议类型：daemon（HTTP 响应 / SSE poll-phase）与宿主 Session Worker 共用。
 *
 * Agent（模型）本身不 poll——协议里没有 poll，由宿主 Session Worker 代管——
 * 所以响应里没有写给模型看的文案，只有这里的机器可读 reason。
 */

/**
 * 阻塞 poll 空返回的原因：
 * - end：按需唤醒模式本回合结束且无待处理消息，worker 应退出
 * - timeout：挂起到点仍无消息，worker 应续挂
 */
export type PollStopReason = "end" | "timeout"

/** poll-phase SSE 的 end 事件原因：PollStopReason + 有消息投递（instant/messages/redeliver）+ 连接中断（abort） */
export type PollPhaseReason = PollStopReason | "instant" | "messages" | "redeliver" | "abort"

export function isPollStopReason(v: unknown): v is PollStopReason {
  return v === "end" || v === "timeout"
}
