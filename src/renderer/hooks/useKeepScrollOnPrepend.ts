import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"

/**
 * 往前加载一页是把记录插在列表顶部：不处理的话内容被顶下去，用户正在看的那条跑出视野。
 * 返回的函数在「加载更早」点击时先调用：记下当时的高度和位置，列表第一条换了（新一页到了）就按增加的高度补回去，
 * 视野里的内容纹丝不动。桌面端对话页和手机端共用。
 */
export function useKeepScrollOnPrepend(
  containerRef: RefObject<HTMLElement | null>,
  items: readonly { id: string }[],
): () => void {
  const anchorRef = useRef<{ firstId: string | undefined; height: number; top: number } | null>(null)
  const firstIdRef = useRef<string | undefined>(undefined)
  firstIdRef.current = items[0]?.id

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = containerRef.current
    if (!anchor || !el || items[0]?.id === anchor.firstId) return
    anchorRef.current = null
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
  }, [containerRef, items])

  return useCallback(() => {
    const el = containerRef.current
    if (el) anchorRef.current = { firstId: firstIdRef.current, height: el.scrollHeight, top: el.scrollTop }
  }, [containerRef])
}
