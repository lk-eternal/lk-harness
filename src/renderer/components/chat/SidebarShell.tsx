import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import useWindowWidth from "../../hooks/useWindowWidth"
import { acquireOverlay } from "../overlay-presence"
import {
  clampSidebarWidth, createSidebarDrag, maxSidebarWidth, MIN_SIDEBAR_WIDTH, steppedSidebarWidth, type SidebarWidthStore,
} from "./sidebar-width"

/**
 * 会话栏右边缘的拖动条：左右拖动调宽，键盘左右键微调，双击恢复默认宽度。
 * 条本身压在栏的右边框上（上下贯通、左右各出来 4px），不占布局，也不会多出一道缝。
 */
function SidebarResizer({ store, width, maxWidth, previewShown }: { store: SidebarWidthStore; width: number; maxWidth: number; previewShown: boolean }) {
  const [dragging, setDragging] = useState(false)
  // 拖动过程里用到的值读最新的：pointer 事件连发时，闭包里的旧值会过期
  const previewShownRef = useRef(previewShown)
  previewShownRef.current = previewShown
  const [drag] = useState(() => createSidebarDrag({
    store,
    acquireOverlay,
    windowWidth: () => window.innerWidth,
    previewShown: () => previewShownRef.current,
  }))
  // 拖动中被卸载：登记的让位也要撤销
  useEffect(() => () => drag.dispose(), [drag])

  /** 松手、取消、指针捕获被丢掉都走这里：拖动状态不能卡住（卡住了右边的网页视图会一直让位） */
  const endDrag = () => { if (drag.end()) setDragging(false) }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.active) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (drag.start(e.clientX, width)) setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => drag.move(e.clientX)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const direction = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
    if (direction === 0) return
    e.preventDefault()
    store.commit(steppedSidebarWidth(width, direction, window.innerWidth, previewShown))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="会话栏宽度"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title="拖动调整会话栏宽度，双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => store.reset()}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none"
    >
      <span
        className={`pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-focus/40 group-focus-visible:bg-focus/60 ${dragging ? "bg-focus/60" : ""}`}
      />
    </div>
  )
}

/**
 * 对话页左侧的会话栏外壳：管宽度和拖动调宽，里面的内容由对话页传进来。
 * 宽度订阅的是外部 store：拖动时只有这个外壳重绘，children 还是同一份，React 不会去动里面的会话列表。
 * 收起时用 hidden 而不是卸载，展开后列表滚动位置还在。
 */
export default function SidebarShell({ store, collapsed, previewShown, children }: {
  store: SidebarWidthStore
  collapsed: boolean
  /** 右边的预览面板是否展开着：展开时它要占最小宽度，会话栏最宽就得少一截 */
  previewShown: boolean
  children: ReactNode
}) {
  const windowWidth = useWindowWidth()
  const stored = useSyncExternalStore(store.subscribe, store.get, store.get)
  const width = clampSidebarWidth(stored, windowWidth, previewShown)
  return (
    <aside className={`${collapsed ? "hidden" : "flex"} relative shrink-0 flex-col border-r border-line-subtle bg-surface`} style={{ width }}>
      {children}
      <SidebarResizer store={store} width={width} maxWidth={maxSidebarWidth(windowWidth, previewShown)} previewShown={previewShown} />
    </aside>
  )
}
