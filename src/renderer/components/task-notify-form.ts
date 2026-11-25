// ── 定时任务设置页「通知谁」这一块的表单逻辑（无 React，便于单测）──────────────
// 表单流程：独立运行与否 →（独立运行才有）模型 → 通知谁 → 通道和接收方（会话 / 飞书群）。
// 存储字段见 shared/scheduled-task-rules.ts；这里只管「改一项时，别的项要跟着怎么变」。

import { appChatSessionName } from "../../shared/app-chat-types"
import { resolveTaskNotify, type ScheduledTask, type TaskNotify } from "../../shared/scheduled-task-rules"
import { applyTaskChannel, type TaskModelFields } from "./task-model"

/** 「通知 AI」里选项目会话的值前缀；会话键不会以它开头 */
const PROJECT_PREFIX = "project:"

type ChannelLike = { id: string; agentResourceId?: string }
type ResourceLike = { id: string }

/** 切换「独立运行」：不通知只有独立运行才有，切成非独立时改成通知 AI（并清掉不通知时残留的接收方） */
export function applyIndependent<T extends ScheduledTask>(task: T, independent: boolean): T {
  const next: T = { ...task, independent }
  if (!independent && resolveTaskNotify(task) === "none") {
    next.notify = "agent"
    delete next.notifyChatId
    delete next.targetProjectId
  }
  return next
}

/** 切换「通知谁」：接收方（会话 / 群 / 项目）都是按通知方式填的，换了方式就作废 */
export function applyNotifyMode<T extends ScheduledTask>(task: T, mode: TaskNotify): T {
  const next: T = { ...task, notify: mode }
  delete next.notifyChatId
  delete next.targetProjectId
  return next
}

/**
 * 换通道（通知的通道和任务跑在哪个通道是同一个）：
 * 会话键、群 ID、项目绑定都是跟着通道走的，换了通道就作废；旧任务单独存的发送通道也一并清掉，以这次选的为准。
 * 模型跟随通道的规则见 applyTaskChannel。
 */
export function applyNotifyChannel<T extends ScheduledTask & TaskModelFields>(
  task: T,
  channelId: string | undefined,
  channels: ChannelLike[],
  resources: ResourceLike[],
): T {
  const next = applyTaskChannel(task, channelId, channels, resources)
  delete next.notifyChannelId
  delete next.notifyChatId
  delete next.targetProjectId
  return next
}

// ── 通知 AI：会话下拉的值 ──────────────────────────────

/** 下拉的当前值：项目会话 = `project:<项目 id>`，具体会话 = 会话键，空 = 通道的主会话 */
export function agentPickValue(task: Pick<ScheduledTask, "targetProjectId" | "notifyChatId">): string {
  const projectId = task.targetProjectId?.trim()
  if (projectId) return `${PROJECT_PREFIX}${projectId}`
  return task.notifyChatId?.trim() ?? ""
}

/** 选了下拉里的一项：项目和具体会话二选一 */
export function applyAgentPick<T extends ScheduledTask>(task: T, value: string): T {
  const next: T = { ...task }
  delete next.notifyChatId
  delete next.targetProjectId
  if (value.startsWith(PROJECT_PREFIX)) {
    next.targetProjectId = value.slice(PROJECT_PREFIX.length)
  } else if (value) {
    next.notifyChatId = value
  }
  return next
}

// ── 会话下拉的选项 ─────────────────────────────────────

export interface SessionOption {
  /** 会话键 */
  value: string
  label: string
}

/** 工作台树里主用户的一个会话（只取这里用到的字段） */
export interface SessionTabLike {
  sessionKey: string
  label: string
  kind: string
  archived?: boolean
  boundDir?: string
}

const MAIN_SUFFIX = "（主）"

/**
 * 某个通道里主用户的会话，供设置页选「发到哪个会话」：
 *  - 项目会话不在这里（通知 AI 的项目走项目下拉；通知我不发项目会话），已归档的也不列；
 *  - 应用内通道的会话和对话页叫同一个名字（摘要标题 / 目录名），主会话后面带「（主）」；
 *  - 同名的会话加序号，免得下拉里两行一模一样。
 */
export function sessionOptionsForChannel(
  tabs: readonly SessionTabLike[],
  opts: { isApp: boolean; titles: Readonly<Record<string, string>> },
): SessionOption[] {
  const named = tabs
    .filter((t) => t.kind !== "project" && !t.archived)
    .map((t) => {
      const base = (opts.isApp ? appChatSessionName(t.sessionKey, opts.titles, t.label, t.boundDir) : undefined) ?? t.label
      return { value: t.sessionKey, label: t.kind === "main" && !base.endsWith(MAIN_SUFFIX) ? `${base}${MAIN_SUFFIX}` : base }
    })
  const total = new Map<string, number>()
  for (const o of named) total.set(o.label, (total.get(o.label) ?? 0) + 1)
  const seen = new Map<string, number>()
  return named.map((o) => {
    if ((total.get(o.label) ?? 0) < 2) return o
    const n = (seen.get(o.label) ?? 0) + 1
    seen.set(o.label, n)
    return { ...o, label: `${o.label} #${n}` }
  })
}

/** 会话键在选项里的显示名；列表里没有（会话已删 / 服务没跑 / 换过通道）返回 undefined */
export function sessionLabelOf(options: readonly SessionOption[], sessionKey: string): string | undefined {
  return options.find((o) => o.value === sessionKey)?.label
}
