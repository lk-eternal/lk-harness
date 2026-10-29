import type { DashboardChannelNode } from "../../../shared/dashboard-tree"
import { channelRunningCount } from "../sessions/sessions-view"

/**
 * 工作台四张卡片就是四个页签：选中哪张，下面的功能区就显示它的内容。
 * - logs：Daemon 卡 → 日志
 * - channels：消息通道卡 → 所有通道的会话管理
 * - sessions：活跃会话卡 → 跨通道、只看运行中的会话
 * - queue：消息队列卡 → 队列明细
 */
export type DashboardTab = "logs" | "channels" | "sessions" | "queue"

export const DASHBOARD_TABS: readonly DashboardTab[] = ["logs", "channels", "sessions", "queue"]

/** 启动时看的是日志（和改版前一致）；不记住上次选的 */
export const DEFAULT_DASHBOARD_TAB: DashboardTab = "logs"

/** 消息通道卡的副标题：有几个通道（状态在主文案里，这里不重复） */
export function channelsCardSub(channelCount: number): string {
  return channelCount > 0 ? `共 ${channelCount} 个通道` : "尚未配置通道"
}

/** 有运行中会话的通道个数 */
export function activeChannelCount(channels: readonly Pick<DashboardChannelNode, "groups">[]): number {
  return channels.filter((c) => channelRunningCount(c) > 0).length
}

/**
 * 活跃会话卡的副标题。会话个数来自 Agent 进程列表（推送 + 5 秒轮询），通道个数来自会话树，
 * 两者偶尔差一拍：有会话但树里还没对上时只说「运行中」，不要写「来自 0 个通道」
 */
export function activeCardSub(sessionCount: number, channelCount: number): string {
  if (sessionCount <= 0) return "等待消息"
  return channelCount > 0 ? `来自 ${channelCount} 个通道` : "运行中"
}

/** 消息队列卡的副标题（处理中 / 排队的拆分在主文案里） */
export function queueCardSub(total: number | undefined): string {
  return total && total > 0 ? `共 ${total} 条` : "队列为空"
}
