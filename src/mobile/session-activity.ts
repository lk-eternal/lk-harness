import type { AppChatItem } from "../shared/app-chat-types"

/**
 * 单个会话的回复进度。口径与桌面端对话页一致（见 useSessionActivity）：
 * 会话进程在线并不代表「AI 在干活」，还要有未收口的回合卡，或最后一条是还没得到回应的用户消息。
 */
export interface SessionActivity {
  /** 还没收口的回合卡 */
  liveCardId?: string
  /** 最后一条是用户消息，AI 还没有任何回应 */
  awaiting: boolean
}

export function applyActivityItem(cur: SessionActivity | undefined, item: AppChatItem): SessionActivity {
  const base: SessionActivity = cur ?? { awaiting: false }
  switch (item.kind) {
    case "user":
      // 排队中的消息 Agent 还没收到，谈不上「等待回应」；投递后（queued 清掉）才算
      if (item.queued) return base
      return base.awaiting ? base : { ...base, awaiting: true }
    case "assistant":
      if (!item.finished) {
        return item.id === base.liveCardId ? base : { ...base, liveCardId: item.id, awaiting: false }
      }
      return base.liveCardId === undefined ? base : { ...base, liveCardId: undefined }
    default:
      return base.awaiting ? { ...base, awaiting: false } : base
  }
}

export function isActivityBusy(activity: SessionActivity | undefined): boolean {
  return !!activity && (activity.liveCardId !== undefined || activity.awaiting)
}

/**
 * 由一段历史消息推出会话当前的回复进度。
 *
 * 历史里每条记录只剩最终状态：收口的回合卡前面没有事件流里的「未收口」那一帧（那一帧才会清掉「等待回应」）。
 * 所以这里已收口的回合卡本身就算对前面用户消息的回应；照搬事件流的规则会让「等待回应」一直挂着，
 * 回复完了还显示「Agent 正在思考」、发送键变成停止键。
 * 事件流（applyActivityItem）不能这么处理：Resume 时会重新收口旧卡，那不是对新消息的回应。
 */
export function activityFromItems(items: AppChatItem[]): SessionActivity {
  const folded = items.reduce<SessionActivity | undefined>((cur, item) => {
    const next = applyActivityItem(cur, item)
    return item.kind === "assistant" && item.finished && next.awaiting ? { ...next, awaiting: false } : next
  }, undefined)
  return folded ?? { awaiting: false }
}
