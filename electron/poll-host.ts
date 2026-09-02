import { readLockFile, httpPost } from "./daemon-client"

export interface PollMessage {
  text: string
  messageId?: string
  sessionKey?: string
  timestamp?: number
  meta?: {
    chatType?: string
    senderOpenId?: string
    senderType?: string
    quotedContent?: string
  }
}

export interface HostPollResult {
  messages: PollMessage[]
  directive?: string
}

const POLL_DIRECTIVE_END_MARK = "安静退出"
const POLL_DIRECTIVE_TIMEOUT_MARK = "轮询正常超时"
/** blocking poll 最长挂起（与协议 24h 一致） */
const POLL_BLOCK_MS = 86_400_000

export function isPollEndDirective(directive?: string): boolean {
  return !!directive?.includes(POLL_DIRECTIVE_END_MARK)
}

export function isPollTimeoutDirective(directive?: string): boolean {
  return !!directive?.includes(POLL_DIRECTIVE_TIMEOUT_MARK)
}

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
  const data = (await res.json()) as { messages?: PollMessage[]; directive?: string }
  return { messages: data.messages ?? [], directive: data.directive }
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
