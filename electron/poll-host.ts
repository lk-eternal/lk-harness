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

async function fetchPoll(sessionKey: string, wait: boolean, signal?: AbortSignal): Promise<HostPollResult> {
  const lock = readLockFile()
  if (!lock?.port) throw new Error("Daemon 未运行")
  const url = new URL(`http://127.0.0.1:${lock.port}/api/poll-message`)
  url.searchParams.set("sessionKey", sessionKey)
  if (!wait) url.searchParams.set("wait", "false")

  const timeout = wait ? POLL_BLOCK_MS : 30_000
  const res = await fetch(url.toString(), {
    signal: signal ?? AbortSignal.timeout(timeout),
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
