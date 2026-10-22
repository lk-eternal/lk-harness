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

/** 由一段历史消息推出会话当前的回复进度 */
export function activityFromItems(items: AppChatItem[]): SessionActivity {
  return items.reduce<SessionActivity | undefined>(applyActivityItem, undefined) ?? { awaiting: false }
}
