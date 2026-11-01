import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react"
import { dragVelocity, sheetOffset, shouldDismissSheet, type DragSample } from "./sheet-drag"

/** 关闭时滑出屏幕的时长（ms）；回弹同样用这个量级 */
const SLIDE_OUT_MS = 180
const SNAP_BACK_MS = 200
/** 只留最近这些采样用来估速度 */
const MAX_SAMPLES = 8

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * 底部弹层的「抓手」下拉关闭：手指按住顶部那条抓手往下拖，弹层跟着走，
 * 拖得够远或甩得够快就滑出并关闭，否则弹回去。
 *
 * 用法：panelRef 挂在弹层面板上，grip 放在面板最顶部。
 * 位移直接写在面板的 style 上，不走 React 状态，拖动时不重渲染；
 * 弹层关闭会卸载面板（open=false 时返回 null），下次打开是全新的节点，不用清残留样式。
 * 只有抓手响应拖动：弹层内容区本来就要滚动，不抢它的手势。
 */
export function useSheetDrag(onClose: () => void): { panelRef: RefObject<HTMLDivElement | null>; grip: ReactNode } {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dragRef = useRef<{ id: number; startY: number; samples: DragSample[] } | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    const panel = panelRef.current
    if (!panel || dragRef.current) return
    window.clearTimeout(timerRef.current)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 指针已经失效：不抓也能拖，只是手指滑出抓手范围后收不到事件
    }
    dragRef.current = { id: e.pointerId, startY: e.clientY, samples: [{ y: e.clientY, t: e.timeStamp }] }
    panel.style.transition = "none"
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const panel = panelRef.current
    if (!d || d.id !== e.pointerId || !panel) return
    d.samples.push({ y: e.clientY, t: e.timeStamp })
    if (d.samples.length > MAX_SAMPLES) d.samples.shift()
    panel.style.transform = `translateY(${sheetOffset(e.clientY - d.startY)}px)`
  }

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = dragRef.current
    const panel = panelRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    if (!panel) return
    const dy = e.clientY - d.startY
    const velocity = dragVelocity(d.samples)
    if (!cancelled && shouldDismissSheet(dy, velocity, panel.offsetHeight)) {
      const ms = prefersReducedMotion() ? 0 : SLIDE_OUT_MS
      panel.style.transition = `transform ${ms}ms ease-in`
      panel.style.transform = "translateY(100%)"
      timerRef.current = window.setTimeout(() => closeRef.current(), ms)
      return
    }
    panel.style.transition = prefersReducedMotion() ? "none" : `transform ${SNAP_BACK_MS}ms cubic-bezier(0.22, 0.8, 0.3, 1)`
    panel.style.transform = "translateY(0px)"
  }

  const grip = (
    <div
      data-sheet-grip=""
      role="presentation"
      title="向下拖动关闭"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      className="flex shrink-0 cursor-grab touch-none select-none justify-center py-2.5 active:cursor-grabbing"
    >
      <div className="h-1 w-10 rounded-full bg-strong" />
    </div>
  )

  return { panelRef, grip }
}
