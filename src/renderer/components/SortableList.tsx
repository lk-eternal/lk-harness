import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { GripVertical } from "lucide-react"

function reorderById<T>(items: T[], activeId: string, overId: string, getId: (t: T) => string): T[] {
  const from = items.findIndex((x) => getId(x) === activeId)
  const to = items.findIndex((x) => getId(x) === overId)
  if (from < 0 || to < 0 || from === to) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

type Snapshot = { id: string; midY: number }

function resolveOverIndex(clientY: number, fromIdx: number, snaps: Snapshot[]): number {
  let toIdx = fromIdx
  for (let i = 0; i < snaps.length; i++) {
    if (i === fromIdx) continue
    const { midY } = snaps[i]
    if (fromIdx < i) {
      if (clientY >= midY) toIdx = i
    } else if (clientY <= midY) {
      toIdx = i
    }
  }
  return toIdx
}

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
  const refs = useRef(new Map<string, HTMLDivElement>())
  const snapshotRef = useRef<Snapshot[]>([])
  const itemsRef = useRef(items)
  const onReorderRef = useRef(onReorder)
  itemsRef.current = items
  onReorderRef.current = onReorder

  const sortable = !disabled && items.length > 1

  const displayItems = useMemo(() => {
    if (!activeId || !overId || activeId === overId) return items
    return reorderById(items, activeId, overId, getId)
  }, [items, activeId, overId, getId])

  const takeSnapshot = () => {
    const snaps: Snapshot[] = []
    for (const item of itemsRef.current) {
      const id = getId(item)
      const el = refs.current.get(id)
      if (!el) continue
      const { top, height } = el.getBoundingClientRect()
      snaps.push({ id, midY: top + height / 2 })
    }
    snapshotRef.current = snaps
  }

  const pickOverId = (clientY: number): string | null => {
    const snaps = snapshotRef.current
    if (!snaps.length || !activeId) return activeId
    const fromIdx = snaps.findIndex((s) => s.id === activeId)
    if (fromIdx < 0) return activeId
    return snaps[resolveOverIndex(clientY, fromIdx, snaps)]?.id ?? activeId
  }

  useEffect(() => {
    if (!activeId) return
    let currentOver = activeId

    const onMove = (e: PointerEvent) => {
      const next = pickOverId(e.clientY)
      if (next && next !== currentOver) {
        currentOver = next
        setOverId(next)
      }
    }
    const onUp = () => {
      const src = itemsRef.current
      const next = reorderById(src, activeId, currentOver, getId)
      const changed = next.some((n, i) => getId(n) !== getId(src[i]))
      snapshotRef.current = []
      setActiveId(null)
      setOverId(null)
      if (changed) void onReorderRef.current(next)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp, { once: true })
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [activeId, getId])

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
