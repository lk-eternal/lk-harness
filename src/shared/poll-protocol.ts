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

/**
 * daemon 侧阻塞 poll 最长挂起：到点以 reason=timeout 空返回，宿主 worker 静默续挂（等于一次心跳）。
 *
 * 必须小于宿主请求库等响应头的默认上限：宿主用 Node 内置 fetch（undici）发 poll，
 * headersTimeout 默认 300 秒，没人配过它。挂得比这更久，请求库会先掐断，worker 收到 "fetch failed"。
 */
export const POLL_BLOCK_TIMEOUT_MS = 4 * 60 * 1000

export function isPollStopReason(v: unknown): v is PollStopReason {
  return v === "end" || v === "timeout"
}
