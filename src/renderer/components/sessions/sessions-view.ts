import { chatIdFromSessionKey, parseChatKey, workspaceDirFromSessionKey } from "../../../shared/channel-types"
import {
  GROUP_IDS,
  sessionKeyToken,
  type BuildDashboardTreeInput,
  type DashboardChannelNode,
  type DashboardQueueItem,
  type DashboardSessionNode,
} from "../../../shared/dashboard-tree"
import type { CleanupPlan, CleanupRunResult, ManagedSession } from "../../../shared/managed-sessions"
import { formatTimeAgo } from "../../time-ago"

/** 会话管理页会话列表的纯逻辑：合并清单、分类、筛选、标记、确认文案、清理摘要（界面只管把它们画出来） */

/**
 * 会话是哪一类，决定行首的图标。主用户、项目、任务 / 临时是主用户自己的，私聊、群是别人的；
 * 「类型未知」是路由表里没登记聊天类型的别人的会话。
 */
export type SessionType = "main" | "p2p" | "group" | "project" | "task" | "other"

/** 图标 / 筛选标签的固定顺序 */
export const SESSION_TYPE_ORDER: readonly SessionType[] = ["main", "p2p", "group", "project", "task", "other"]

export const SESSION_TYPE_LABEL: Record<SessionType, string> = {
  main: "主用户",
  p2p: "私聊",
  group: "群",
  project: "项目",
  task: "任务/临时",
  other: "类型未知",
}

/** 工作台树里主用户自己的分组：主用户自己的、项目、任务 / 临时。私聊他人和群由会话清单（含空闲的）提供 */
export const MY_GROUP_IDS = ["main", "project", "task"] as const

const MINE_TYPE: Record<(typeof MY_GROUP_IDS)[number], SessionType> = { main: "main", project: "project", task: "task" }

/** 通道里正在运行的会话个数（所有分组合计，含私聊他人和群） */
export function channelRunningCount(channel: Pick<DashboardChannelNode, "groups">): number {
  let n = 0
  for (const gid of GROUP_IDS) n += channel.groups[gid].sessions.filter((s) => s.running).length
  return n
}

/** 某个通道里其他人的会话（主用户自己的、项目、任务来自工作台的会话树，不走会话清单） */
export function othersOf(sessions: readonly ManagedSession[], channelId: string): ManagedSession[] {
  return sessions.filter((s) => s.channelId === channelId && s.audience === "others")
}

interface SessionItemBase {
  sessionKey: string
  /** 所属通道：跨通道的清单（「全部」/ 活跃会话）里行上要标出来 */
  channelId: string
  channelName: string
  type: SessionType
  /** 搜索用：聊天键（带通道前缀） */
  chatKey: string
  name: string
  /** 别人的私聊才有：最后一句话 */
  preview?: string
  workspaceDir?: string
  running: boolean
  /** 最近一次对话的时间；磁盘上没有记录为空 */
  lastActiveAt?: number
  model: string
  modelParams: string
  resourceId?: string
  /** 这个会话排着的消息 */
  queue: DashboardQueueItem[]
}

/** 主用户自己的会话 / 项目 / 任务：来自工作台的会话树，激活、删除、改模型沿用工作台那一套 */
export interface MineSessionItem extends SessionItemBase {
  owner: "mine"
  node: DashboardSessionNode
  /** 主用户当前正在用的会话 */
  current: boolean
}

/** 别人的会话：来自会话清单（磁盘上存着的，含空闲的），可重置 / 恢复默认 / 删除 / 批量清理 */
export interface OthersSessionItem extends SessionItemBase {
  owner: "others"
  managed: ManagedSession
}

export type SessionItem = MineSessionItem | OthersSessionItem

/** 别人的会话是私聊还是群；路由表里没登记类型的是「类型未知」 */
export function othersType(s: Pick<ManagedSession, "chatType">): SessionType {
  return s.chatType === "group" ? "group" : s.chatType === "p2p" ? "p2p" : "other"
}

/** 最近有对话的在前；没有记录的在最后，同时间按会话键定序（刷新时顺序不跳） */
function byRecent(a: SessionItem, b: SessionItem): number {
  return (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.sessionKey.localeCompare(b.sessionKey)
}

/**
 * 把一个通道里所有会话合成一张清单：主用户自己的（会话树里的 主用户 / 项目 / 任务）+ 别人的（会话清单里所有的）。
 * 主用户的会话没有自己的活动时间，按会话键到会话清单里取；两边都有同一个会话时以会话树为准，只留一行。
 * 排队消息统一取全局队列，这样别人的会话也能看到、删除排队的消息。
 */
export function buildSessionItems(input: {
  channelId: string
  /** 行上标所属通道用；不传就是空串（单通道清单不显示通道名） */
  channelName?: string
  groups: DashboardChannelNode["groups"]
  managed: readonly ManagedSession[]
  queue: BuildDashboardTreeInput["queue"]
}): SessionItem[] {
  const { channelId, groups, queue } = input
  const channelName = input.channelName ?? ""
  const managed = input.managed.filter((s) => s.channelId === channelId)
  const activeAt = new Map(managed.map((s) => [sessionKeyToken(s.sessionKey), s.lastActiveAt]))
  const queueByKey = new Map<string, DashboardQueueItem[]>()
  for (const q of queue) {
    if (!q.sessionKey) continue
    const token = sessionKeyToken(q.sessionKey)
    const list = queueByKey.get(token) ?? []
    list.push({ fileId: q.fileId, preview: q.preview, status: q.status })
    queueByKey.set(token, list)
  }

  const items: SessionItem[] = []
  const seen = new Set<string>()
  for (const gid of MY_GROUP_IDS) {
    for (const node of groups[gid].sessions) {
      const token = sessionKeyToken(node.sessionKey)
      if (seen.has(token)) continue
      seen.add(token)
      items.push({
        owner: "mine",
        node,
        current: !!node.current,
        sessionKey: node.sessionKey,
        channelId,
        channelName,
        type: MINE_TYPE[gid],
        chatKey: chatIdFromSessionKey(node.sessionKey),
        name: node.label,
        workspaceDir: node.workspaceDir ?? workspaceDirFromSessionKey(node.sessionKey),
        running: node.running,
        lastActiveAt: activeAt.get(token),
        model: node.model ?? "",
        modelParams: node.modelParams ?? "",
        resourceId: node.resourceId,
        queue: queueByKey.get(token) ?? [],
      })
    }
  }
  for (const s of managed) {
    if (s.audience !== "others") continue
    const token = sessionKeyToken(s.sessionKey)
    if (seen.has(token)) continue
    seen.add(token)
    items.push({
      owner: "others",
      managed: s,
      sessionKey: s.sessionKey,
      channelId,
      channelName,
      type: othersType(s),
      chatKey: s.chatKey,
      name: s.name,
      preview: s.preview,
      workspaceDir: s.workspaceDir,
      running: s.running,
      lastActiveAt: s.lastActiveAt,
      model: s.model,
      modelParams: s.modelParams,
      resourceId: s.resourceId,
      queue: queueByKey.get(token) ?? [],
    })
  }
  return items.sort(byRecent)
}

/** 跨通道的清单：每个通道各合一张（buildSessionItems），再按最近对话混排。行上的 channelName 标出各自属于哪个通道 */
export function buildAllSessionItems(input: {
  channels: readonly Pick<DashboardChannelNode, "channelId" | "name" | "groups">[]
  managed: readonly ManagedSession[]
  queue: BuildDashboardTreeInput["queue"]
}): SessionItem[] {
  const { managed, queue } = input
  return input.channels
    .flatMap((c) => buildSessionItems({ channelId: c.channelId, channelName: c.name, groups: c.groups, managed, queue }))
    .sort(byRecent)
}

/** 「消息通道」功能区的通道切换条里「全部」这一项的取值（不会和真实通道 id 撞：通道 id 形如 ch_xxx） */
export const ALL_CHANNELS = "*"

/**
 * 功能区实际要看哪个通道：只有一个通道时就是它（没有切换条）；
 * 选中的通道已经被删 / 停用了，回到「全部」，不要空着。
 */
export function resolveChannelSelection(channels: readonly { channelId: string }[], selected: string): string {
  if (channels.length === 1) return channels[0].channelId
  return selected !== ALL_CHANNELS && channels.some((c) => c.channelId === selected) ? selected : ALL_CHANNELS
}

export type ListFilter = "all" | SessionType | "running"

export interface FilterChip {
  id: ListFilter
  label: string
  count: number
}

/**
 * 筛选标签：全部、有会话的各类型（带个数）、运行中。没有会话的类型不出现标签（项目 / 任务多数时候是空的）；
 * 类型未知的只在「全部」里，没有自己的标签。
 * 清单本来就只有运行中的会话（活跃会话）时传 `running: false`：「运行中」标签和「全部」一模一样，不要。
 */
export function filterChips(items: readonly SessionItem[], opts: { running?: boolean } = {}): FilterChip[] {
  const chips: FilterChip[] = [{ id: "all", label: "全部", count: items.length }]
  for (const type of SESSION_TYPE_ORDER) {
    if (type === "other") continue
    const count = items.filter((i) => i.type === type).length
    if (count > 0) chips.push({ id: type, label: SESSION_TYPE_LABEL[type], count })
  }
  if (opts.running !== false) chips.push({ id: "running", label: "运行中", count: items.filter((i) => i.running).length })
  return chips
}

/** 选中的筛选已经没有标签了（比如最后一个项目被删掉）就回到「全部」，免得列表空着而没有任何标签高亮 */
export function resolveFilter(filter: ListFilter, chips: readonly FilterChip[]): ListFilter {
  return chips.some((c) => c.id === filter) ? filter : "all"
}

/**
 * 搜索 + 类型筛选。搜索词按空白拆开，每个词都要命中名字 / 预览 / 目录 / 聊天 id 之一（不分大小写）。
 * 类型筛选只看明确知道类型的，类型未知的只在「全部」里出现。
 */
export function filterSessionItems(
  items: readonly SessionItem[],
  opts: { query?: string; filter?: ListFilter },
): SessionItem[] {
  const tokens = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const filter = opts.filter ?? "all"
  return items.filter((i) => {
    if (filter === "running" ? !i.running : filter !== "all" && i.type !== filter) return false
    if (tokens.length === 0) return true
    // 不放 sessionKey：它带着通道 id 前缀（ch_xxx|），搜 "ch" 会命中所有会话
    const hay = [i.name, i.preview ?? "", i.workspaceDir ?? "", parseChatKey(i.chatKey).chatId].join("\n").toLowerCase()
    return tokens.every((t) => hay.includes(t))
  })
}

export function queueCounts(queue: readonly DashboardQueueItem[]): { processing: number; pending: number } {
  const processing = queue.filter((q) => q.status === "processing").length
  return { processing, pending: queue.length - processing }
}

export interface RowCapabilities {
  stop: boolean
  /** 切到这个会话（只改路由，不拉起）：主用户自己的、空闲的、不是当前的 */
  activate: boolean
  restore: boolean
  reset: boolean
  remove: boolean
}

/** 一行上有哪些操作：主用户的会话沿用工作台的（激活 / 停止 / 删除），别人的是会话清单的（停止 / 恢复默认 / 重置 / 删除） */
export function rowCapabilities(item: SessionItem): RowCapabilities {
  if (item.owner === "mine") {
    return { stop: item.running, activate: !item.running && !item.current, restore: false, reset: false, remove: !!item.node.removable }
  }
  return { stop: item.running, activate: false, restore: item.managed.canRestoreDefault, reset: true, remove: true }
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
