import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { GripVertical } from "lucide-react"
import { applyOrder, createReorderTracker, reorderById, resolveOverIndex, type Snapshot } from "./sortable-list-logic"

type SortableListProps<T> = {
  items: T[]
  getId: (item: T) => string
  onReorder: (items: T[]) => void | Promise<void>
  disabled?: boolean
  gapClass?: string
  renderItem: (item: T, ctx: { grip: ReactNode; isDragging: boolean }) => ReactNode
}

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

  const displayItems = useMemo(() => {
    if (!activeId || !overId || activeId === overId) return baseItems
    return reorderById(baseItems, activeId, overId, getId)
  }, [baseItems, activeId, overId, getId])

  const takeSnapshot = () => {
    const snaps: Snapshot[] = []
    for (const item of baseItemsRef.current) {
      const id = getIdRef.current(item)
      const el = refs.current.get(id)
      if (!el) continue
      const { top, height } = el.getBoundingClientRect()
      snaps.push({ id, midY: top + height / 2 })
    }
    snapshotRef.current = snaps
  }

  // 只依赖 activeId：getId 通常是父组件里的内联函数，每次渲染都变，放进依赖会让拖动中的监听反复重建。
  // 当前落点、列表内容都从 ref 读，所以即使父组件在拖动中重渲染，松手也照常生效
  useEffect(() => {
    if (!activeId) return

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
          await onReorderRef.current(next)
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
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [activeId])

  return (
    <div className={`${gapClass}${activeId ? " select-none [&_*]:pointer-events-none" : ""}`}>
      {displayItems.map((item) => {
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
            className={isDragging ? "opacity-50" : activeId ? "" : "transition-opacity duration-150"}
          >
            {renderItem(item, { grip, isDragging })}
          </div>
        )
      })}
    </div>
  )
}
