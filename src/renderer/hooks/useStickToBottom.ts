import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

/**
 * 日志/聊天贴底：底部哨兵可见 = 跟随新内容；用户上翻离开哨兵 = 暂停自动滚动。
 * 用 IntersectionObserver 判定，避免 scroll 事件与程序化 scrollTop 互相打架。
 */
export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  contentDeps: unknown[],
) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const root = containerRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel) return

    const io = new IntersectionObserver(
      ([entry]) => {
        stickRef.current = entry.isIntersecting
        setAtBottom(entry.isIntersecting)
      },
      { root, threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [containerRef])

  useLayoutEffect(() => {
    if (!stickRef.current) return
    sentinelRef.current?.scrollIntoView({ block: "end" })
  }, contentDeps)

  const scrollToBottom = () => {
    sentinelRef.current?.scrollIntoView({ block: "end" })
  }

  return { sentinelRef, atBottom, stickRef, scrollToBottom }
}
