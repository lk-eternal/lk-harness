/**
 * 会话抽屉的左右滑动：向右滑展开，向左滑收起。抽屉跟着手指走，松手时按位置和速度决定去向。
 *
 * 分两层：
 *  - 纯函数（判定方向、估算速度、松手去向、要不要让给横向滚动区）：不碰 DOM，可单测；
 *  - attachDrawerSwipe：管触摸事件和拖动期间的样式。
 *
 * 抽屉的静止样式（关着在左边屏外、开着贴左）在 mobile.css 的 .drawer 规则里，靠 data-open 切换。
 * 拖动期间这里临时写 inline 的 transform / opacity / transition，松手后清掉，由 CSS 接着把它动画到终点。
 */

/** 手指移动超过这个距离（px）才判定方向，再小的抖动当作点按 */
export const LOCK_DISTANCE = 10
/** 横向位移要是纵向位移的这么多倍才算「横着滑」：竖着滚消息时拇指总会带点斜，宁可严一点，也别在滚动时误开抽屉 */
export const HORIZONTAL_RATIO = 1.7
/** 松手时横向速度（px/ms）超过它，不管拖了多远都顺着手势方向走 */
export const FLICK_VELOCITY = 0.35
/** 估算速度只看最近这段时间（ms）的采样 */
const VELOCITY_WINDOW_MS = 100
/** 两个采样间隔太短时速度不可信（ms） */
const MIN_SAMPLE_SPAN_MS = 8

export type SwipeIntent = "pending" | "horizontal" | "vertical"

/** 手指从按下起的累计位移 → 这是横滑、竖滑，还是还没动够 */
export function classifySwipe(dx: number, dy: number): SwipeIntent {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < LOCK_DISTANCE) return "pending"
  return ax >= ay * HORIZONTAL_RATIO ? "horizontal" : "vertical"
}

/** 往 dx 方向滑能不能让抽屉动：已全开时再往右、全关时再往左都没有意义，这种手势不接管 */
export function canDrag(openness: number, dx: number): boolean {
  return dx > 0 ? openness < 1 : openness > 0
}

/** 抽屉展开程度（0 全关 ~ 1 全开） */
export function opennessAfter(start: number, dx: number, width: number): number {
  if (width <= 0) return start
  return Math.min(1, Math.max(0, start + dx / width))
}

export interface SwipeSample {
  x: number
  /** 毫秒，与 TouchEvent.timeStamp 同一时钟 */
  t: number
}

/** 横向速度（px/ms，向右为正），只看最近一小段采样；手指停住再抬起时为 0 */
export function velocityOf(samples: readonly SwipeSample[]): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  const first = samples.find((s) => last.t - s.t <= VELOCITY_WINDOW_MS) ?? last
  const span = last.t - first.t
  return span < MIN_SAMPLE_SPAN_MS ? 0 : (last.x - first.x) / span
}

/** 松手后抽屉去向：快速一甩顺着方向走，否则过半就开、不过半就关 */
export function settleOpen(openness: number, velocity: number): boolean {
  if (velocity >= FLICK_VELOCITY) return true
  if (velocity <= -FLICK_VELOCITY) return false
  return openness >= 0.5
}

export interface ScrollBox {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

/** 这个容器朝手指移动的方向（dx>0 即手指右滑，内容向左回卷）还能不能横向滚动 */
export function canScrollHorizontally(box: ScrollBox, dx: number): boolean {
  const max = box.scrollWidth - box.clientWidth
  if (max <= 1) return false
  return dx > 0 ? box.scrollLeft > 0 : box.scrollLeft < max - 1
}

/**
 * 从触点往上到 stop 之间，有没有横向可滚、且朝手指方向还能滚的容器（代码块、表格、横向胶囊栏…）。
 * 有就让给它：用户是想滚动那一块内容，不是想开抽屉。已经滚到头的容器不算，那时再往同方向滑就是开抽屉。
 */
export function findHorizontalScroller(start: Element | null, stop: Element, dx: number): Element | null {
  for (let el = start; el && el !== stop; el = el.parentElement) {
    const overflowX = getComputedStyle(el).overflowX
    if (overflowX !== "auto" && overflowX !== "scroll") continue
    if (canScrollHorizontally(el, dx)) return el
  }
  return null
}

/** 从这些元素里起手的触摸不接管：输入框里拖动是在移光标、选文字 */
const IGNORED_START = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-no-swipe]"

export interface DrawerSwipeOptions {
  /** 抽屉当前是否处于打开状态（每次手势开始时读，不缓存） */
  isOpen: () => boolean
  /** 有别的浮层盖在上面时不接管手势 */
  isBlocked: () => boolean
  /** 松手后抽屉该开还是该关。调用方要同步完成状态更新，之后这里才清掉拖动样式，动画才不会闪一下 */
  setOpen: (open: boolean) => void
}

interface Gesture {
  id: number
  x0: number
  y0: number
  lastX: number
  target: Element | null
  /** 判定为横滑那一刻抽屉的展开程度（可能正在动画途中，所以不在按下时量） */
  base: number
  width: number
  intent: SwipeIntent
  /** 判定为横滑的那一刻手指的 x：位移从这里起算，抽屉才不会在锁定瞬间跳一下 */
  xAtLock: number
  openness: number
  samples: SwipeSample[]
}

interface DrawerParts {
  drawer: HTMLElement
  panel: HTMLElement
  scrim: HTMLElement
}

function findParts(root: HTMLElement): DrawerParts | null {
  const drawer = root.querySelector<HTMLElement>("[data-drawer]")
  const panel = drawer?.querySelector<HTMLElement>("[data-drawer-panel]")
  const scrim = drawer?.querySelector<HTMLElement>("[data-drawer-scrim]")
  return drawer && panel && scrim ? { drawer, panel, scrim } : null
}

function applyOpenness(parts: DrawerParts, openness: number, width: number): void {
  parts.panel.style.transform = `translateX(${(openness - 1) * width}px)`
  parts.scrim.style.opacity = String(openness)
}

function beginDragStyles(parts: DrawerParts): void {
  // 关着的抽屉是 visibility:hidden，拖动时得先让它显出来。
  // .drawer 上有「visibility 延迟 260ms 才生效」的过渡（为了让关闭动画走完再隐藏），
  // 不关掉的话，隐藏→显示也会被延迟：手指拖了 260ms 抽屉还是看不见
  parts.drawer.style.transition = "none"
  parts.drawer.style.visibility = "visible"
  parts.panel.style.transition = "none"
  parts.scrim.style.transition = "none"
  parts.drawer.dataset.dragging = "true"
}

function clearDragStyles(parts: DrawerParts): void {
  parts.drawer.style.transition = ""
  parts.drawer.style.visibility = ""
  parts.panel.style.transition = ""
  parts.panel.style.transform = ""
  parts.scrim.style.transition = ""
  parts.scrim.style.opacity = ""
  delete parts.drawer.dataset.dragging
}

function touchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
  return null
}

/**
 * 在 root 上挂抽屉滑动手势，返回取消函数。
 * root 里要有 [data-drawer]（含 [data-drawer-panel]、[data-drawer-scrim]）。
 * 全部是 passive 监听、不拦截默认行为：竖着滚消息仍由浏览器处理，横滑靠 root 上的 touch-action: pan-y 不被浏览器抢走。
 */
export function attachDrawerSwipe(root: HTMLElement, opts: DrawerSwipeOptions): () => void {
  let g: Gesture | null = null
  let parts: DrawerParts | null = null

  /** 结束拖动：先交给调用方定去向，再清掉拖动样式，让 CSS 从当前位置动画到终点 */
  const settle = (gesture: Gesture, velocity: number): void => {
    if (!parts) return
    const open = settleOpen(gesture.openness, velocity)
    try {
      opts.setOpen(open)
    } finally {
      clearDragStyles(parts)
    }
  }

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) {
      // 第二根手指落下（捏合等）：正在拖就按当前位置收尾，之后这次触摸不再处理
      const dragging = g?.intent === "horizontal" ? g : null
      g = null
      if (dragging) settle(dragging, 0)
      return
    }
    parts = findParts(root)
    if (!parts || opts.isBlocked()) return
    const target = e.target instanceof Element ? e.target : null
    const open = opts.isOpen()
    if (!open && target?.closest(IGNORED_START)) return
    const t = e.touches[0]
    const width = parts.panel.offsetWidth
    if (width <= 0) return
    g = {
      id: t.identifier,
      x0: t.clientX,
      y0: t.clientY,
      lastX: t.clientX,
      target,
      base: 0,
      width,
      intent: "pending",
      xAtLock: t.clientX,
      openness: 0,
      samples: [{ x: t.clientX, t: e.timeStamp }],
    }
  }

  const onMove = (e: TouchEvent): void => {
    if (!g || !parts) return
    const t = touchById(e.touches, g.id)
    if (!t) return
    g.lastX = t.clientX
    g.samples.push({ x: t.clientX, t: e.timeStamp })
    if (g.samples.length > 12) g.samples.shift()

    if (g.intent === "pending") {
      const dx = t.clientX - g.x0
      const dy = t.clientY - g.y0
      const intent = classifySwipe(dx, dy)
      if (intent === "pending") return
      // 以抽屉此刻真实的位置为起点：松手后的动画还没走完就又按住时，抽屉不会跳变
      const base = Math.min(1, Math.max(0, parts.panel.getBoundingClientRect().right / g.width))
      if (intent === "vertical" || !canDrag(base, dx) || findHorizontalScroller(g.target, root, dx)) {
        g = null // 竖着滚、对抽屉没意义、或者让给横向滚动区：这次触摸整个放弃
        return
      }
      g.intent = "horizontal"
      g.base = base
      g.xAtLock = t.clientX
      beginDragStyles(parts)
    }

    g.openness = opennessAfter(g.base, t.clientX - g.xAtLock, g.width)
    applyOpenness(parts, g.openness, g.width)
  }

  const onEnd = (e: TouchEvent): void => {
    if (!g) return
    const gesture = g
    g = null
    if (gesture.intent !== "horizontal") return
    const t = touchById(e.changedTouches, gesture.id)
    // 抬手时补一个采样：手指停了一会儿再抬起，速度应当是 0，而不是停之前的速度
    gesture.samples.push({ x: t?.clientX ?? gesture.lastX, t: e.timeStamp })
    settle(gesture, velocityOf(gesture.samples))
  }

  const onCancel = (): void => {
    if (!g) return
    const gesture = g
    g = null
    // 被系统收走（比如安卓的边缘返回手势）：只看位置，不看速度
    if (gesture.intent === "horizontal") settle(gesture, 0)
  }

  root.addEventListener("touchstart", onStart, { passive: true })
  root.addEventListener("touchmove", onMove, { passive: true })
  root.addEventListener("touchend", onEnd, { passive: true })
  root.addEventListener("touchcancel", onCancel, { passive: true })
  return () => {
    root.removeEventListener("touchstart", onStart)
    root.removeEventListener("touchmove", onMove)
    root.removeEventListener("touchend", onEnd)
    root.removeEventListener("touchcancel", onCancel)
    if (g?.intent === "horizontal" && parts) clearDragStyles(parts)
    g = null
  }
}
