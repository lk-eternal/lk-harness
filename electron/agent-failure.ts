import type { ChannelAudience } from "../src/shared/channel-types.js"
import { redactText } from "../src/shared/redact.js"

/**
 * Agent 一轮失败算哪一类。重试节奏（failureBackoffMs）和给用户的说明（describeAgentFailure）都从这一个分类出发，
 * 两个引擎、两个 worker 不再各写各的正则。
 */
export type AgentFailureKind = "auth" | "quota" | "network" | "model" | "other"

/** 失败后消息怎么走：auto = 调度器会自动重试这批消息；resend = 这批消息已作废，需要用户重发 */
export type AgentFailureRetry = "auto" | "resend"

/** 连不上服务：瞬时故障，立即重试 */
const NETWORK_RE = /API key exchange|exchange_user_api_key|fetch failed|unauthenticated|ECONNRESET|socket hang up|GOAWAY|疑似底层网络|timeout|network/i
/** Key 无效 / 无权限。状态码必须是独立的数字，免得 4013、运行编号里的 403 之类被误判 */
const AUTH_RE = /api[_ ]key|\b(?:401|403)\b|forbidden/i
const QUOTA_RE = /quota|rate limit|insufficient/i
const MODEL_RE = /model .*not (?:found|available)/i

export function classifyAgentFailure(reason: string): AgentFailureKind {
  if (NETWORK_RE.test(reason)) return "network"
  if (AUTH_RE.test(reason)) return "auth"
  if (QUOTA_RE.test(reason)) return "quota"
  if (MODEL_RE.test(reason)) return "model"
  return "other"
}

/** 重试再多也不会自愈（要用户改 Key / 等额度 / 换模型），必须退避，否则死循环刷屏 */
function isPermanentFailure(kind: AgentFailureKind): boolean {
  return kind === "auth" || kind === "quota" || kind === "model"
}

/** 永久性错误退避阶梯（毫秒）：5s → 10s → 30s → 1min → 5min 封顶 */
const PERMANENT_FAIL_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 300_000]

/** 连续失败第 failCount 次之后要等多久才重试；瞬时故障与未知错误不退避 */
export function failureBackoffMs(kind: AgentFailureKind, failCount: number): number {
  if (!isPermanentFailure(kind)) return 0
  const idx = Math.min(Math.max(failCount, 1) - 1, PERMANENT_FAIL_BACKOFF_MS.length - 1)
  return PERMANENT_FAIL_BACKOFF_MS[idx]
}

const FAILURE_COPY: Record<AgentFailureKind, { cause: string; action: string }> = {
  auth: { cause: "Agent 的 API Key 无效或已失效", action: "请到「设置 → Agent」检查并更新 Key" },
  quota: { cause: "模型额度用完了，或请求太频繁被限流", action: "请检查账户额度，或稍等一会儿" },
  network: { cause: "连不上模型服务（网络问题）", action: "请检查网络，或到「设置 → 网络」看看代理配置" },
  model: { cause: "当前模型不可用（可能已下线，或账号没有使用权限）", action: "请发送 /model ls 查看可选模型，再用 /model set <序号> 换一个" },
  other: { cause: "Agent 处理出错了", action: "如果反复出现，请到桌面端日志页导出诊断包" },
}

const DETAIL_MAX_CHARS = 120

function summarizeDetail(detail: string): string {
  const flat = redactText(detail).replace(/\s+/g, " ").trim()
  return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS)}…` : flat
}

export interface DescribeFailureInput {
  kind: AgentFailureKind
  /** main = 主用户这边的会话：说清原因和该做什么；others = 别人的会话：只给通用提示，不透出内部信息 */
  audience: ChannelAudience
  retry: AgentFailureRetry
  /** 原始报错；只在 kind=other 时作为原因摘要给主用户看 */
  detail?: string
}

/** 给用户看的失败说明：出了什么事 + 该做什么 + 这条消息会不会自动继续 */
export function describeAgentFailure(input: DescribeFailureInput): string {
  const { kind, audience, retry, detail } = input
  if (audience !== "main") {
    return retry === "auto"
      ? "⚠️ 这条消息暂时没能处理，系统会自动重试，请稍候。"
      : "⚠️ 这条消息暂时没能处理，请稍后重新发送。"
  }
  const copy = FAILURE_COPY[kind]
  const summary = kind === "other" && detail?.trim() ? summarizeDetail(detail) : ""
  const cause = summary ? `${copy.cause}（${summary}）` : copy.cause
  const follow = retry === "auto"
    ? "处理好后系统会自动继续处理这条消息。"
    : "这条消息不会自动重试，处理好后请重新发送。"
  return `⚠️ ${cause}，这条消息没能处理。\n${copy.action}。${follow}`
}
