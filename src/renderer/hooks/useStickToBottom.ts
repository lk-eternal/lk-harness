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

  // 滚到容器真正的底部。不能用 sentinel.scrollIntoView({ block: "end" })：它只把哨兵对齐到可视区下沿，
  // 哨兵之后还有容器的底内边距，于是每次自动滚动都停在离真底部一个内边距的位置，
  // 用户明明已经在最底部，内容一刷新就被往回拽一小段（视觉上就是「整体往上滚了一点」）
  const scrollToEnd = () => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    if (!stickRef.current) return
    scrollToEnd()
  }, contentDeps) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToBottom = scrollToEnd

  return { sentinelRef, atBottom, stickRef, scrollToBottom }
}
