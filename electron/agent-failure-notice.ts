import { resolveChannelAudience, type ChannelAudience } from "../src/shared/channel-types.js"
import { resolveChannelForSession } from "./config-store"
import { httpPost, readLockFile } from "./daemon-client"
import { describeAgentFailure, type AgentFailureKind, type AgentFailureRetry } from "./agent-failure"
import { broadcastLog } from "./ui-logger"

/** 调度器在自动重试期间，同一会话同一类原因最多提示一次的间隔 */
const AUTO_RETRY_NOTICE_INTERVAL_MS = 10 * 60_000

/** sessionKey → 各类原因上次提示的时刻 */
const noticedAt = new Map<string, Map<AgentFailureKind, number>>()

function claimAutoRetryNotice(sessionKey: string, kind: AgentFailureKind): boolean {
  const kinds = noticedAt.get(sessionKey) ?? new Map<AgentFailureKind, number>()
  const last = kinds.get(kind)
  const now = Date.now()
  if (last !== undefined && now - last < AUTO_RETRY_NOTICE_INTERVAL_MS) return false
  kinds.set(kind, now)
  noticedAt.set(sessionKey, kinds)
  return true
}

/** 提示没发出去就把名额还回去，下一次失败还有机会提示 */
function releaseAutoRetryNotice(sessionKey: string, kind: AgentFailureKind): void {
  noticedAt.get(sessionKey)?.delete(kind)
}

/** 会话恢复或用户重置后，下一次失败要重新提示 */
export function clearFailureNotices(sessionKey: string): void {
  noticedAt.delete(sessionKey)
}

export function clearAllFailureNotices(): void {
  noticedAt.clear()
}

/**
 * 会话属于谁：判法与 session-dispatcher 的 isOthersQueueSession 一致。
 * 应用内通道没有「别人」；项目、任务、临时会话是主用户这边的。
 */
function audienceOf(sessionKey: string): ChannelAudience {
  const channel = resolveChannelForSession(sessionKey)
  if (!channel || channel.type === "app") return "main"
  return resolveChannelAudience({
    mainUserEnabled: channel.mainUserEnabled,
    mainUserChatId: channel.mainUserChatId,
    sessionKey,
  })
}

export interface ReportFailureInput {
  kind: AgentFailureKind
  detail?: string
  retry: AgentFailureRetry
  /** 出事的那条用户消息；没有消息在处理就没有「这条消息没能处理」可说 */
  replyToMessageId?: string
}

/**
 * 把一轮失败告诉用户。提示只带 message_id、不带 session_key：这样 daemon 把它当成对那条消息的独立回复，
 * 不会并进（或新建）会话的流式卡，和刚收口的进度卡、重试后的新进度卡都不会混在一起。
 * 自动重试的失败会循环出现，所以限频；需要重发的失败对应用户的每一条消息，每次都提示。
 * 永不抛错：提示发不出去只记日志，不能影响失败后的重试流程。
 */
export async function reportAgentFailure(sessionKey: string, input: ReportFailureInput): Promise<void> {
  const { kind, detail, retry, replyToMessageId } = input
  if (!replyToMessageId) return
  if (retry === "auto" && !claimAutoRetryNotice(sessionKey, kind)) return

  try {
    const text = describeAgentFailure({ kind, audience: audienceOf(sessionKey), retry, detail })
    const lock = readLockFile()
    if (!lock?.port) throw new Error("Daemon 未运行")
    const res = await httpPost(
      `http://127.0.0.1:${lock.port}/api/send-text`,
      { text, message_id: replyToMessageId },
      10_000,
    ) as { ok?: boolean; error?: string } | null
    if (res?.ok === false) throw new Error(res.error ?? "daemon 拒绝发送")
  } catch (e: unknown) {
    if (retry === "auto") releaseAutoRetryNotice(sessionKey, kind)
    broadcastLog(`[Notify] 失败提示发送失败 (${sessionKey}): ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}
