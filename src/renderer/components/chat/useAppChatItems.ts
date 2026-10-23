import { useEffect, useRef, useState } from "react"
import { appChatSessionId, upsertChatItems as upsertItems, type AppChatItem } from "../../../shared/app-chat-types"
import { channelIdFromSessionKey } from "../../../shared/channel-types"

export function sameChatSession(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return appChatSessionId(a) === appChatSessionId(b)
}

/**
 * 某个会话的聊天条目：先订阅事件再拉历史（历史返回前到达的事件不丢，且以事件为准），
 * 事件按帧合并，流式高频快照只触发一次渲染。
 */
export function useAppChatItems(sessionKey: string | null): { items: AppChatItem[]; loading: boolean; error: string } {
  const [items, setItems] = useState<AppChatItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const pendingRef = useRef<AppChatItem[]>([])
  const rafRef = useRef(0)

  useEffect(() => {
    setItems([])
    setError("")
    pendingRef.current = []
    if (!sessionKey) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    const flush = () => {
      rafRef.current = 0
      const batch = pendingRef.current
      pendingRef.current = []
      if (!cancelled && batch.length > 0) setItems((prev) => upsertItems(prev, batch))
    }

    const unsubscribe = window.electronAPI.onAppChatEvent((ev) => {
      if (ev.type === "item") {
        if (!sameChatSession(ev.sessionKey, sessionKey)) return
        pendingRef.current.push(ev.item)
        if (!rafRef.current) rafRef.current = requestAnimationFrame(flush)
        return
      }
      if (ev.type === "remove") {
        if (!sameChatSession(ev.sessionKey, sessionKey)) return
        // 还没合并进列表的同 id 快照也要丢掉，否则下一帧会把它带回来
        pendingRef.current = pendingRef.current.filter((it) => it.id !== ev.itemId)
        setItems((prev) => (prev.some((it) => it.id === ev.itemId) ? prev.filter((it) => it.id !== ev.itemId) : prev))
        return
      }
      const hit = ev.sessionKey
        ? sameChatSession(ev.sessionKey, sessionKey)
        : !!ev.channelId && ev.channelId === channelIdFromSessionKey(sessionKey)
      if (!hit) return
      pendingRef.current = []
      setItems([])
    })

    void window.electronAPI.appChatHistory(sessionKey).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (!r.ok) { setError(r.error ?? "读取历史失败"); return }
      // 历史在前、期间到达的事件（已在 prev 中）覆盖同 id 的旧快照
      setItems((prev) => upsertItems(r.items ?? [], prev))
    })

    return () => {
      cancelled = true
      unsubscribe()
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      pendingRef.current = []
    }
  }, [sessionKey])

  return { items, loading, error }
}
