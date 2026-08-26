import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"

interface Props {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  maxHeight?: number
}

/** 侧栏「添加」下拉：Portal 渲染，避免被 overflow 裁切；自动选择�?下方�?*/
export default function PanelAddMenu({ open, anchorRef, onClose, children, maxHeight = 280 }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!open) return
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const gap = 4
      const below = window.innerHeight - r.bottom - gap
      const above = r.top - gap
      const openUp = below < 120 && above > below
      if (openUp) {
        setStyle({
          position: "fixed",
          left: r.left,
          width: r.width,
          bottom: window.innerHeight - r.top + gap,
          maxHeight: Math.min(maxHeight, above),
        })
      } else {
        setStyle({
          position: "fixed",
          left: r.left,
          width: r.width,
          top: r.bottom + gap,
          maxHeight: Math.min(maxHeight, below),
        })
      }
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open, anchorRef, maxHeight])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open, onClose, anchorRef])

  if (!open) return null
  return createPortal(
    <div ref={menuRef} className="z-[200] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-xl" style={style}>
      {children}
    </div>,
    document.body,
  )
}
