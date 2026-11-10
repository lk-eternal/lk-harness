import { useCallback, useEffect, useRef, useState } from "react"
import { appChatSessionId, upsertChatItems as upsertItems, type AppChatItem } from "../../../shared/app-chat-types"
import { HISTORY_PAGE_LIMIT, historyCursorOf, isBeyondLoadedWindow, type HistoryCursor } from "../../../shared/app-chat-history-page"
import { channelIdFromSessionKey } from "../../../shared/channel-types"

export function sameChatSession(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return appChatSessionId(a) === appChatSessionId(b)
}

export interface AppChatItemsState {
  items: AppChatItem[]
  loading: boolean
  error: string
  /** 已加载的最早一条之前还有更早的记录 */
  hasMore: boolean
  loadingEarlier: boolean
  /** 往前再加载一页；加载期间或没有更早的记录时什么都不做 */
  loadEarlier: () => Promise<void>
}

/**
 * 某个会话的聊天条目：先订阅事件再拉历史（历史返回前到达的事件不丢，且以事件为准），
 * 事件按帧合并，流式高频快照只触发一次渲染。
 *
 * 历史只拉最近一页（整段渲染要好几秒），更早的由 loadEarlier 按需往前翻。
 */
export function useAppChatItems(sessionKey: string | null): AppChatItemsState {
  const [items, setItems] = useState<AppChatItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const pendingRef = useRef<AppChatItem[]>([])
  const rafRef = useRef(0)
  /** 已加载窗口的起点：事件落在它之前的记录不并入，「加载更早」也从它往前取（不取列表里的第一条，它可能是被事件带进来的） */
  const cursorRef = useRef<HistoryCursor | undefined>(undefined)
  /** 当前会话的代号：切换会话后，上一个会话还在路上的请求结果要丢掉 */
  const generationRef = useRef(0)
  const loadingEarlierRef = useRef(false)
  const hasMoreRef = useRef(false)
  hasMoreRef.current = hasMore

  useEffect(() => {
    generationRef.current++
    setItems([])
    setError("")
    setHasMore(false)
    setLoadingEarlier(false)
    loadingEarlierRef.current = false
    cursorRef.current = undefined
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
      if (cancelled || batch.length === 0) return
      setItems((prev) => {
        const fresh = batch.filter((it) => !isBeyondLoadedWindow(it, cursorRef.current, prev))
        return fresh.length > 0 ? upsertItems(prev, fresh) : prev
      })
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
      cursorRef.current = undefined
      setHasMore(false)
      setItems([])
    })

    void window.electronAPI.appChatHistory(sessionKey, { limit: HISTORY_PAGE_LIMIT }).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (!r.ok) { setError(r.error ?? "读取历史失败"); return }
      const page = r.items ?? []
      cursorRef.current = historyCursorOf(page)
      setHasMore(!!r.hasMore)
      // 历史在前、期间到达的事件（已在 prev 中）覆盖同 id 的旧快照
      setItems((prev) => upsertItems(page, prev))
    })

    return () => {
      cancelled = true
      unsubscribe()
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      pendingRef.current = []
    }
  }, [sessionKey])

  const loadEarlier = useCallback(async () => {
    const cursor = cursorRef.current
    if (!sessionKey || !cursor || !hasMoreRef.current || loadingEarlierRef.current) return
    const generation = generationRef.current
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    const r = await window.electronAPI.appChatHistory(sessionKey, { limit: HISTORY_PAGE_LIMIT, beforeId: cursor.id, beforeTs: cursor.ts })
    if (generation !== generationRef.current) return
    loadingEarlierRef.current = false
    setLoadingEarlier(false)
    if (!r.ok) { setError(r.error ?? "读取更早的消息失败"); return }
    const page = r.items ?? []
    cursorRef.current = historyCursorOf(page) ?? cursor
    setHasMore(!!r.hasMore)
    setError("")
    setItems((prev) => upsertItems(prev, page))
  }, [sessionKey])

  return { items, loading, error, hasMore, loadingEarlier, loadEarlier }
}
