import { readLockFile, httpPost } from "./daemon-client"
import { isPollStopReason, type PollStopReason } from "../src/shared/poll-protocol.js"

export interface PollMessage {
  text: string
  messageId?: string
  sessionKey?: string
  timestamp?: number
  meta?: {
    chatType?: string
    senderOpenId?: string
    senderType?: string
    quoted_message?: {
      message_id: string
      sender_type: string
      sender_open_id?: string
      text: string
    }
  }
}

export interface HostPollResult {
  messages: PollMessage[]
  /** 空返回的原因：end=按需唤醒本回合结束（worker 退出），timeout=挂起到点（worker 续挂）；有消息时无此字段 */
  reason?: PollStopReason
}

/** blocking poll 客户端兜底超时；daemon 侧挂起到点（POLL_BLOCK_TIMEOUT_MS）会先以 timeout 返回，正常走不到这里 */
const POLL_BLOCK_MS = 86_400_000

function pollFetchSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!external) return timeout
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, timeout])
  const ctrl = new AbortController()
  const fire = () => ctrl.abort()
  external.addEventListener("abort", fire, { once: true })
  timeout.addEventListener("abort", fire, { once: true })
  return ctrl.signal
}

async function fetchPoll(sessionKey: string, wait: boolean, signal?: AbortSignal): Promise<HostPollResult> {
  const lock = readLockFile()
  if (!lock?.port) throw new Error("Daemon 未运行")
  const url = new URL(`http://127.0.0.1:${lock.port}/api/poll-message`)
  url.searchParams.set("sessionKey", sessionKey)
  if (!wait) url.searchParams.set("wait", "false")

  const timeout = wait ? POLL_BLOCK_MS : 30_000
  const res = await fetch(url.toString(), {
    signal: pollFetchSignal(signal, timeout),
  })
  if (!res.ok) throw new Error(`poll HTTP ${res.status}`)
  const data = (await res.json()) as { messages?: PollMessage[]; reason?: unknown }
  return {
    messages: data.messages ?? [],
    ...(isPollStopReason(data.reason) ? { reason: data.reason } : {}),
  }
}

export async function hostBlockingPoll(sessionKey: string, signal?: AbortSignal): Promise<HostPollResult> {
  return fetchPoll(sessionKey, true, signal)
}

export async function hostNonBlockingPoll(sessionKey: string): Promise<HostPollResult> {
  return fetchPoll(sessionKey, false)
}

export async function hostSendText(text: string, sessionKey: string, messageId?: string): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) throw new Error("Daemon 未运行")
  await httpPost(
    `http://127.0.0.1:${lock.port}/api/send-text`,
    { text, session_key: sessionKey, message_id: messageId },
    60_000,
  )
}

/** 回合成功出站：更新 lastReplyAt，避免阻塞 poll 触发黑洞重投 */
export async function hostTouchSessionReply(sessionKey: string): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  await httpPost(
    `http://127.0.0.1:${lock.port}/api/touch-session-reply`,
    { session_key: sessionKey },
    5000,
  )
}

/** 确认已处理完的 .claimed，停止 daemon 重投同批消息 */
export async function hostConfirmClaimed(sessionKey: string): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  await httpPost(
    `http://127.0.0.1:${lock.port}/api/confirm-claimed`,
    { session_key: sessionKey },
    5000,
  )
}

/** 标记一批消息已处理并认领：内存去重 + 删 daemon 侧 .claimed，二者缺一即可能重做。
 * 认领失败不抛（best-effort），调用方无需再各自 try/catch。 */
export async function markMessagesProcessed(
  session: { processedMessageIds: Set<string> },
  sessionKey: string,
  messages: Array<{ messageId?: string }>,
  confirm: (sessionKey: string) => Promise<void> = hostConfirmClaimed,
): Promise<void> {
  for (const m of messages) {
    if (m.messageId) session.processedMessageIds.add(m.messageId)
  }
  try { await confirm(sessionKey) } catch { /* best-effort */ }
}
