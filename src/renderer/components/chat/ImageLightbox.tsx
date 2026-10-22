import { useEffect, useRef, useState } from "react"
import type { MouseEvent, PointerEvent, ReactNode, WheelEvent } from "react"
import { createPortal } from "react-dom"
import { Maximize, X, ZoomIn, ZoomOut } from "lucide-react"

interface Point { x: number; y: number }

/** scale=1 为适配窗口；x/y 是以舞台中心为原点的平移量（px） */
interface View { scale: number; x: number; y: number }

/** 一次手势的起点快照：后续每次移动都由它推出视图，避免逐帧累积误差 */
interface Gesture { view: View; mid: Point; spread: number }

const FIT: View = { scale: 1, x: 0, y: 0 }
const ORIGIN: Point = { x: 0, y: 0 }
const MIN_SCALE = 1
const MAX_SCALE = 8
const BUTTON_STEP = 1.5
const WHEEL_SENSITIVITY = 0.002
const PINCH_WHEEL_SENSITIVITY = 0.01
const DOUBLE_CLICK_MIN_SCALE = 2
const DRAG_THRESHOLD = 3

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

function stagePoint(e: { currentTarget: HTMLElement; clientX: number; clientY: number }): Point {
  const rect = e.currentTarget.getBoundingClientRect()
  return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
}

function centroid(points: Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), ORIGIN)
  return { x: sum.x / points.length, y: sum.y / points.length }
}

function spread(points: Point[]): number {
  return points.length < 2 ? 0 : Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
}

/** 缩放 ratio 倍，并让原先在 from 位置的图像点落到 to 位置（from=to 即以该点为中心缩放） */
function scaleAbout(view: View, ratio: number, from: Point, to: Point): View {
  const scale = clamp(view.scale * ratio, MIN_SCALE, MAX_SCALE)
  const applied = scale / view.scale
  return { scale, x: to.x - (from.x - view.x) * applied, y: to.y - (from.y - view.y) * applied }
}

/** 图像放大后边缘最多拖到与舞台边缘对齐；比舞台小时居中 */
function clampView(view: View, stage: HTMLElement, img: HTMLElement): View {
  const limitX = Math.max(0, (img.clientWidth * view.scale - stage.clientWidth) / 2)
  const limitY = Math.max(0, (img.clientHeight * view.scale - stage.clientHeight) / 2)
  return { scale: view.scale, x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY) }
}

/** 全屏图片查看器：滚轮/双指缩放、拖动平移、双击切换适配与放大；点空白处或 Esc 关闭 */
export function ImageLightbox({ src, onClose, actions }: { src: string; onClose: () => void; actions?: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const viewRef = useRef(FIT)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const pressedBackdrop = useRef(false)
  const dragged = useRef(false)
  const [view, setView] = useState(FIT)
  const [fitRatio, setFitRatio] = useState(1)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const measure = () => {
      if (img.naturalWidth > 0 && img.clientWidth > 0) setFitRatio(img.clientWidth / img.naturalWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(img)
    return () => observer.disconnect()
  }, [])

  const apply = (next: View) => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img) return
    const clamped = clampView(next, stage, img)
    viewRef.current = clamped
    setView(clamped)
  }

  const beginGesture = () => {
    const points = [...pointers.current.values()]
    gesture.current = points.length === 0 ? null : { view: viewRef.current, mid: centroid(points), spread: spread(points) }
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (pointers.current.size === 0) {
      dragged.current = false
      pressedBackdrop.current = e.target === e.currentTarget
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, stagePoint(e))
    beginGesture()
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current
    if (!start || !pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, stagePoint(e))
    const points = [...pointers.current.values()]
    const mid = centroid(points)
    const ratio = start.spread > 0 ? spread(points) / start.spread : 1
    if (ratio !== 1 || Math.hypot(mid.x - start.mid.x, mid.y - start.mid.y) > DRAG_THRESHOLD) dragged.current = true
    apply(scaleAbout(start.view, ratio, start.mid, mid))
  }

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    beginGesture()
  }

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const p = stagePoint(e)
    const sensitivity = e.ctrlKey ? PINCH_WHEEL_SENSITIVITY : WHEEL_SENSITIVITY
    apply(scaleAbout(viewRef.current, Math.exp(-e.deltaY * sensitivity), p, p))
  }

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const current = viewRef.current
    if (current.scale > MIN_SCALE) { apply(FIT); return }
    const p = stagePoint(e)
    apply(scaleAbout(current, Math.max(1 / fitRatio, DOUBLE_CLICK_MIN_SCALE), p, p))
  }

  const zoomBy = (ratio: number) => apply(scaleAbout(viewRef.current, ratio, ORIGIN, ORIGIN))

  // 深色底 + 白描边：控件叠在任何颜色的图片上都看得清（半透明白底遇到浅色图会消失）
  const chip = "bg-black/70 text-white shadow-lg ring-1 ring-white/40 backdrop-blur-sm"
  const toolButton = `rounded-full p-2.5 transition hover:bg-black/90 active:scale-95 ${chip}`
  const toolbarTop = "top-[calc(env(safe-area-inset-top)+1rem)]"

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/85">
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onClick={() => { if (pressedBackdrop.current && !dragged.current) onClose() }}
        className="absolute inset-0 flex touch-none items-center justify-center overflow-hidden p-4"
      >
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          className={`max-h-full max-w-full select-none rounded object-contain ${view.scale > MIN_SCALE ? "cursor-grab" : "cursor-zoom-in"}`}
        />
      </div>
      <div className={`absolute left-4 flex items-center gap-1.5 ${toolbarTop}`}>
        <button type="button" onClick={() => zoomBy(1 / BUTTON_STEP)} title="缩小" className={toolButton}><ZoomOut size={18} /></button>
        <span className={`min-w-12 rounded-full px-2.5 py-1.5 text-center text-xs tabular-nums ${chip}`}>{Math.round(view.scale * fitRatio * 100)}%</span>
        <button type="button" onClick={() => zoomBy(BUTTON_STEP)} title="放大" className={toolButton}><ZoomIn size={18} /></button>
        <button type="button" onClick={() => apply(FIT)} title="适配窗口" className={toolButton}><Maximize size={18} /></button>
      </div>
      <div className={`absolute right-4 flex items-start gap-2 ${toolbarTop}`}>
        {actions}
        <button type="button" onClick={onClose} title="关闭" className={toolButton}><X size={18} /></button>
      </div>
    </div>,
    document.body,
  )
}
