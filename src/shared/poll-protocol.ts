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

/**
 * 常驻（保持长连接）的会话空闲这么久，worker 就干净退出：释放 Agent 和它拉起的 MCP 进程（常驻一个会话约 280MB），
 * 下一条消息走 Resume 冷启动（上下文保留，实测中位约 4 秒）。
 * 从「上一轮回合结束」起算（没跑过回合就从 worker 启动起算），只在 poll 到点空返回（见上）时检查，
 * 所以实际退出在 30 分钟到约 34 分钟之间；有消息在途时不会退出。刻意不做成设置项。
 */
export const WORKER_IDLE_EXIT_MS = 30 * 60 * 1000

export function isPollStopReason(v: unknown): v is PollStopReason {
  return v === "end" || v === "timeout"
}
