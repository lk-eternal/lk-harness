import { parseChatKey } from "../../../shared/channel-types"
import { GROUP_IDS, type DashboardChannelNode, type SessionGroupId } from "../../../shared/dashboard-tree"
import type { CleanupPlan, CleanupRunResult, ManagedSession } from "../../../shared/managed-sessions"
import { formatTimeAgo } from "../../time-ago"

/** 会话管理页「其他人的会话」列表的纯逻辑：筛选、标记、确认文案、清理摘要（界面只管把它们画出来） */

export type ChatFilter = "all" | "p2p" | "group" | "running"

/**
 * 「我的会话」里列的分组：主用户自己的、项目、任务/临时。
 * 私聊他人和群不在这里——它们由「其他人的会话」管（那边连空闲的也能看到）。
 */
export const MY_GROUP_IDS: readonly SessionGroupId[] = ["main", "project", "task"]

/** 「我的会话」要显示的分组：主用户组常驻（承载「+ 常用目录」入口），项目 / 任务有会话才出现 */
export function visibleMyGroups(channel: Pick<DashboardChannelNode, "groups">): SessionGroupId[] {
  return MY_GROUP_IDS.filter((gid) => gid === "main" || channel.groups[gid].sessions.length > 0)
}

/** 通道里正在运行的会话个数（所有分组合计，含私聊他人和群） */
export function channelRunningCount(channel: Pick<DashboardChannelNode, "groups">): number {
  let n = 0
  for (const gid of GROUP_IDS) n += channel.groups[gid].sessions.filter((s) => s.running).length
  return n
}

/** 某个通道里其他人的会话（主用户的、项目、任务在「我的会话」里管） */
export function othersOf(sessions: readonly ManagedSession[], channelId: string): ManagedSession[] {
  return sessions.filter((s) => s.channelId === channelId && s.audience === "others")
}

/**
 * 搜索 + 类型筛选。搜索词按空白拆开，每个词都要命中名字 / 预览 / 目录 / 聊天 id / 会话键之一（不分大小写）；
 * 类型「私聊 / 群」只看路由表里明确知道类型的，类型未知的只在「全部」里出现。
 */
export function filterOthers(
  sessions: readonly ManagedSession[],
  opts: { query?: string; chat?: ChatFilter },
): ManagedSession[] {
  const tokens = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const chat = opts.chat ?? "all"
  return sessions.filter((s) => {
    if (chat === "p2p" && s.chatType !== "p2p") return false
    if (chat === "group" && s.chatType !== "group") return false
    if (chat === "running" && !s.running) return false
    if (tokens.length === 0) return true
    // 不放 sessionKey：它带着通道 id 前缀（ch_xxx|），搜 "ch" 会命中所有会话
    const hay = [s.name, s.preview ?? "", s.workspaceDir ?? "", parseChatKey(s.chatKey).chatId].join("\n").toLowerCase()
    return tokens.every((t) => hay.includes(t))
  })
}

export function chatTag(s: Pick<ManagedSession, "chatType">): string {
  return s.chatType === "group" ? "群" : s.chatType === "p2p" ? "私聊" : "会话"
}

/** 会话自己改过什么：给行上的小标签和悬停说明；没改过返回 undefined */
export function overrideBadge(s: ManagedSession): { text: string; title: string } | undefined {
  if (s.resourceSource === "session") {
    return { text: "单独供应商", title: `供应商「${s.resourceName}」是这个会话单独指定的，和通道默认不同` }
  }
  if (s.modelSource === "session") {
    return { text: "已改模型", title: `模型是这个会话单独改的；通道默认是 ${s.defaultModel || "自动"}` }
  }
  if (s.customized) return { text: "已改推理档", title: "推理档是这个会话单独设的" }
  return undefined
}

export function lastActiveText(s: Pick<ManagedSession, "lastActiveAt">, now: number): string {
  return s.lastActiveAt === undefined ? "无记录" : formatTimeAgo(s.lastActiveAt, now)
}

const defaultModelText = (s: ManagedSession): string => s.defaultModel || "自动"

export function deleteConfirmText(s: ManagedSession): string {
  const lines = [`确定删除「${s.name}」？`, "会删除这个会话的全部上下文，对方下次发消息会开启一个全新的会话（不会通知对方）。"]
  if (s.running) lines.push("它正在运行，会先被停止。")
  if (s.queued > 0) lines.push(`还有 ${s.queued} 条排队中的消息，会一并丢弃。`)
  return lines.join("\n")
}

export function resetConfirmText(s: ManagedSession): string {
  const lines = [`确定重置「${s.name}」？`, "会清空它的上下文，对方下次发消息会从头开始；会话本身和它的设置都保留，也不会通知对方。"]
  if (s.running) lines.push("它正在运行，会先被停止。")
  return lines.join("\n")
}

export function restoreConfirmText(s: ManagedSession): string {
  const lines = [`把「${s.name}」的模型恢复为通道默认（${defaultModelText(s)}）？`, "以后通道默认改了，它也会跟着变。"]
  if (s.running) lines.push("它正在运行，会先被停止，下条消息按默认模型重新开始。")
  return lines.join("\n")
}

/** 批量清理预览：一句标题 + 每类被保留的个数（为 0 的不显示） */
export function cleanupSummary(plan: CleanupPlan): { headline: string; kept: string[] } {
  const e = plan.excluded
  const days = plan.olderThanDays
  const parts: [number, string][] = [
    [e.running, "正在运行"],
    [e.queued, "有排队消息"],
    [e.customized, "改过模型 / 供应商 / 推理档"],
    [e.recent, `不足 ${days} 天`],
    [e.noActivityTime, "没有活动记录"],
    [e.notManageable, "不在清理范围（主用户 / 项目 / 任务）"],
  ]
  return {
    headline: `超过 ${days} 天没有活动的会话：${plan.candidates.length} 个`,
    kept: parts.filter(([n]) => n > 0).map(([n, why]) => `${n} 个${why}，已保留`),
  }
}

/** 批量清理执行完的一句话结果 */
export function cleanupResultText(r: CleanupRunResult): string {
  if (!r.ok) return r.error ?? "清理失败"
  const out = [`已删除 ${r.deleted.length} 个会话`]
  if (r.skipped.length > 0) out.push(`跳过 ${r.skipped.length} 个（${[...new Set(r.skipped.map((s) => s.reason))].join("；")}）`)
  if (r.failed.length > 0) out.push(`失败 ${r.failed.length} 个（${[...new Set(r.failed.map((s) => s.error))].join("；")}）`)
  return out.join("，")
}

export const DAEMON_DOWN_HINT = "服务未运行，无法清理路由，请先启动服务"

/** 清理对话框里天数输入框的初始值（和主进程的默认天数保持一致，测试里有对照） */
export const CLEANUP_DEFAULT_DAYS = 14

/** 输入框里的天数：要求是不小于 1 的整数；其余（空、0、负数、带小数、带字母）都当作还没填好，返回 undefined */
export function parseCleanupDays(text: string): number | undefined {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return undefined
  const n = Number(t)
  return n >= 1 && n <= 3650 ? n : undefined
}

/** 预览列表：最久没动的排最前；没有活动时间的（不会进候选，保险起见）排最后 */
export function sortCleanupCandidates(list: readonly ManagedSession[]): ManagedSession[] {
  const at = (s: ManagedSession) => s.lastActiveAt ?? Number.MAX_SAFE_INTEGER
  return [...list].sort((a, b) => at(a) - at(b))
}
