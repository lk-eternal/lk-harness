import { useEffect, useRef, type RefObject } from "react"
import { flushSync } from "react-dom"
import { openOverlayCount } from "./back-stack"
import { attachDrawerSwipe } from "./drawer-swipe"

/**
 * 在 root 上挂会话抽屉的滑动手势（向右滑展开、向左滑收起）。
 * 状态仍由调用方持有：手势只在松手时通过 setOpen 报告去向。
 */
export function useDrawerSwipe(
  rootRef: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  const openRef = useRef(open)
  openRef.current = open
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return attachDrawerSwipe(root, {
      isOpen: () => openRef.current,
      // 抽屉没开时不能有任何浮层；抽屉开着时，最上面得是抽屉自己（再有弹窗叠在上面，触摸归弹窗）
      isBlocked: () => openOverlayCount() > (openRef.current ? 1 : 0),
      // 同步提交：之后清掉拖动样式时 data-open 已经是新值，动画从手指松开的位置直接走向终点
      setOpen: (next) => flushSync(() => setOpenRef.current(next)),
    })
  }, [rootRef])
}
