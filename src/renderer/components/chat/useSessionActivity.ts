import { useCallback, useEffect, useRef, useState } from "react"
import { appChatSessionId, type AppChatEvent, type AppChatItem } from "../../../shared/app-chat-types"
import { channelIdFromSessionKey } from "../../../shared/channel-types"

export type SessionStatus = "working" | "unread" | "idle"

interface Entry {
  sessionKey: string
  /** 还没收口的回合卡 */
  liveCardId?: string
  /** 最后一条是用户消息，AI 还没有任何回应 */
  awaiting: boolean
  /** 回合在你没看着这个会话时收口了，点开它之前一直保留 */
  unread: boolean
}

function applyItem(cur: Entry, item: AppChatItem, viewed: boolean): Entry {
  switch (item.kind) {
    case "user":
      // 排队中的消息还在暂存区，Agent 没收到，谈不上「等待回应」；投递后（queued 清掉）才算
      if (item.queued) return cur
      return cur.awaiting ? cur : { ...cur, awaiting: true }
    case "assistant":
      if (!item.finished) {
        return item.id === cur.liveCardId ? cur : { ...cur, liveCardId: item.id, awaiting: false }
      }
      return { ...cur, liveCardId: undefined, unread: cur.unread || !viewed }
    default:
      return cur.awaiting ? { ...cur, awaiting: false } : cur
  }
}

function dropCleared(prev: Record<string, Entry>, ev: Extract<AppChatEvent, { type: "clear" }>): Record<string, Entry> {
  const kept = Object.entries(prev).filter(([id, entry]) => {
    const hit = ev.sessionKey
      ? id === appChatSessionId(ev.sessionKey)
      : !!ev.channelId && ev.channelId === channelIdFromSessionKey(entry.sessionKey)
    return !hit
  })
  return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
}

/**
 * 跟踪所有应用内会话的回复状态：订阅全部会话的聊天事件，不依赖当前选中的会话。
 * 回复中沿用对话页判断「AI 在干活」的口径：进程在线，且有未收口的回合卡或待回应的用户消息。
 * viewing 是你正在看的会话（页面不可见时传 null），它上面收口的回合不算未读，切到它时清掉未读。
 */
export function useSessionActivity(viewing: string | null): (sessionKey: string, running: boolean) => SessionStatus {
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const viewingId = viewing ? appChatSessionId(viewing) : null
  const viewingRef = useRef<string | null>(null)
  viewingRef.current = viewingId

  useEffect(() => {
    return window.electronAPI.onAppChatEvent((ev) => {
      if (ev.type === "clear") {
        setEntries((prev) => dropCleared(prev, ev))
        return
      }
      if (ev.type === "remove") return
      const id = appChatSessionId(ev.sessionKey)
      setEntries((prev) => {
        const cur = prev[id] ?? { sessionKey: ev.sessionKey, awaiting: false, unread: false }
        const next = applyItem(cur, ev.item, viewingRef.current === id)
        return next === cur ? prev : { ...prev, [id]: next }
      })
    })
  }, [])

  useEffect(() => {
    if (!viewingId) return
    setEntries((prev) => {
      const cur = prev[viewingId]
      return cur?.unread ? { ...prev, [viewingId]: { ...cur, unread: false } } : prev
    })
  }, [viewingId])

  return useCallback((sessionKey: string, running: boolean): SessionStatus => {
    const entry = entries[appChatSessionId(sessionKey)]
    if (!entry) return "idle"
    if (running && (entry.liveCardId !== undefined || entry.awaiting)) return "working"
    return entry.unread ? "unread" : "idle"
  }, [entries])
}
