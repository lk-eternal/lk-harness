// ── 定时任务设置页「通知通道」这一块的表单逻辑（无 React，便于单测）──────────────
// 用户建的任务只有一种交付方式：独立运行 + 通知我（见 shared/task-delivery 的 toUserNotifyTask），
// 表单里只剩「通知通道」和飞书的「会话 ID」。存储字段见 shared/scheduled-task-rules.ts；
// 这里只管「改通道时，别的项要跟着怎么变」。

import type { ScheduledTask } from "../../shared/scheduled-task-rules"
import { applyTaskChannel, type TaskModelFields } from "./task-model"

type ChannelLike = { id: string; agentResourceId?: string }
type ResourceLike = { id: string }

/**
 * 换通道（通知的通道和任务跑在哪个通道是同一个）：
 * 应用内的专属会话键、飞书会话 ID 都是跟着通道走的，换了通道就作废（应用内会在下次投递时重建）；
 * 旧任务单独存的发送通道、项目绑定也一并清掉，以这次选的为准。模型的规则见 applyTaskChannel。
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
