import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { GripVertical } from "lucide-react"
import { applyOrder, createReorderTracker, reorderById, resolveOverIndex, slideOffsets, type Snapshot } from "./sortable-list-logic"

type SortableListProps<T> = {
  items: T[]
  getId: (item: T) => string
  /** 松手后调用：next 是排好的新顺序，movedId 是被拖的那一项 */
  onReorder: (next: T[], movedId: string) => void | Promise<void>
  disabled?: boolean
  gapClass?: string
  renderItem: (item: T, ctx: { grip: ReactNode; isDragging: boolean }) => ReactNode
}

const NO_OFFSETS: ReadonlyMap<string, number> = new Map()
/** 拖动中各行换位的动画；系统设了「减少动态效果」就直接跳过去 */
const SLIDE = "transition-transform duration-150 ease-out motion-reduce:transition-none"

export default function SortableList<T>({ items, getId, onReorder, disabled, gapClass = "space-y-2", renderItem }: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  // 松手后、保存结果回来之前：先按新顺序显示，免得先跳回旧顺序、等保存完又跳到新顺序
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const refs = useRef(new Map<string, HTMLDivElement>())
  const snapshotRef = useRef<Snapshot[]>([])
  const overRef = useRef<string | null>(null)
  const trackerRef = useRef(createReorderTracker())
  const baseItemsRef = useRef(items)
  const getIdRef = useRef(getId)
  const onReorderRef = useRef(onReorder)
  getIdRef.current = getId
  onReorderRef.current = onReorder

  const sortable = !disabled && items.length > 1

  // 不在拖动时显示的顺序：保存还在途中就先用刚排好的顺序；下一次拖动也以它为起点
  const baseItems = useMemo(
    () => (pendingOrder ? applyOrder(items, pendingOrder, getId) : items),
    [items, pendingOrder, getId],
  )
  baseItemsRef.current = baseItems

  // 拖动中列表不换顺序，被挪动的行用位移滑到新位置（中途改方向交给浏览器的 transition）；
  // 松手时换顺序和撤掉位移在同一次渲染里完成，行的视觉位置不会跳
  const slideBy = activeId && overId ? slideOffsets(snapshotRef.current, activeId, overId) : NO_OFFSETS

  const takeSnapshot = () => {
    const snaps: Snapshot[] = []
    for (const item of baseItemsRef.current) {
      const id = getIdRef.current(item)
      const el = refs.current.get(id)
      if (!el) continue
      const { top, height } = el.getBoundingClientRect()
      snaps.push({ id, top, height })
    }
    snapshotRef.current = snaps
  }

  // 只依赖 activeId：getId 通常是父组件里的内联函数，每次渲染都变，放进依赖会让拖动中的监听反复重建。
  // 当前落点、列表内容都从 ref 读，所以即使父组件在拖动中重渲染，松手也照常生效
  useEffect(() => {
    if (!activeId) return

    // 拖动中行换了位置，指针会离开手柄，光标要在整个窗口里一直保持抓手
    const cursorBefore = document.body.style.cursor
    document.body.style.cursor = "grabbing"

    const pickOverId = (clientY: number): string => {
      const snaps = snapshotRef.current
      const fromIdx = snaps.findIndex((s) => s.id === activeId)
      if (fromIdx < 0) return activeId
      return snaps[resolveOverIndex(clientY, fromIdx, snaps)]?.id ?? activeId
    }
    const onMove = (e: PointerEvent) => {
      const next = pickOverId(e.clientY)
      if (next !== overRef.current) {
        overRef.current = next
        setOverId(next)
      }
    }
    const onUp = () => {
      const idOf = getIdRef.current
      const src = baseItemsRef.current
      const next = reorderById(src, activeId, overRef.current ?? activeId, idOf)
      const changed = next.some((n, i) => idOf(n) !== idOf(src[i]))
      snapshotRef.current = []
      overRef.current = null
      setActiveId(null)
      setOverId(null)
      if (!changed) return

      const ids = next.map(idOf)
      const tracker = trackerRef.current
      tracker.begin(ids)
      setPendingOrder(tracker.order)
      void (async () => {
        try {
          await onReorderRef.current(next, activeId)
        } catch (err) {
          console.error("[SortableList] 保存排序失败", err)
        } finally {
          if (tracker.end()) setPendingOrder(null)
        }
      })()
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp, { once: true })
    return () => {
      document.body.style.cursor = cursorBefore
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [activeId])

  return (
    <div className={`${gapClass}${activeId ? " select-none [&_*]:pointer-events-none" : ""}`}>
      {baseItems.map((item) => {
        const id = getId(item)
        const isDragging = activeId === id
        const grip = sortable ? (
          <GripVertical
            size={14}
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              takeSnapshot()
              overRef.current = id
              setActiveId(id)
              setOverId(id)
            }}
            className="shrink-0 cursor-grab touch-none text-fg-faint transition hover:text-fg-2 active:cursor-grabbing"
          />
        ) : null
        return (
          <div
            key={id}
            ref={(el) => { if (el) refs.current.set(id, el); else refs.current.delete(id) }}
            className={isDragging ? `opacity-50 ${SLIDE}` : activeId ? SLIDE : "transition-opacity duration-150"}
            style={slideBy.has(id) ? { transform: `translateY(${slideBy.get(id)}px)` } : undefined}
          >
            {renderItem(item, { grip, isDragging })}
          </div>
        )
      })}
    </div>
  )
}
