/**
 * 主窗口位置的记忆与还原。纯函数、不依赖 Electron：主进程把显示器列表传进来，单测直接覆盖。
 *
 * 为什么要记显示器：窗口最大化时，`getNormalBounds()` 只给「还原后」的那块矩形，看不出它现在在哪块屏上。
 * 以前启动时对最大化的窗口干脆不传 x/y，窗口先在主屏居中创建、再最大化，于是在副屏上最大化的窗口
 * 重启后永远回到主屏，存下来的还原位置也被覆盖成主屏居中的值。
 * 现在最大化时一并记下它所在的显示器，启动时先把窗口放到那块屏上再最大化（Windows 按窗口当前所在的屏最大化）。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 显示器的最小描述（Electron 的 Display 满足它） */
export interface DisplayLike {
  id: number
  /** 整块屏在虚拟桌面里的范围 */
  bounds: Rect
  /** 去掉任务栏/菜单栏后的可用范围 */
  workArea: Rect
}

/** 落盘的显示器：id + 它在虚拟桌面里的范围 */
export interface SavedDisplay extends Rect {
  id: number
}

export interface SavedWindowBounds extends Rect {
  maximized: boolean
  /** 窗口当时所在的显示器；旧版本存的没有这一项 */
  display?: SavedDisplay
}

export interface WindowPlacement {
  width: number
  height: number
  /** 缺省 = 交给系统摆（主屏居中） */
  x?: number
  y?: number
  /** 创建后是否要最大化 */
  maximize: boolean
}

export const DEFAULT_WINDOW_SIZE = { width: 900, height: 680 } as const

const MIN_SAVED_WIDTH = 400
const MIN_SAVED_HEIGHT = 300
/** 窗口和屏幕至少要有这么多像素重叠才算「看得见」，免得显示器拔掉后窗口开到看不见的地方 */
const MIN_VISIBLE = 50

function isFiniteRect(r: Rect | undefined | null): r is Rect {
  return !!r
    && Number.isFinite(r.x) && Number.isFinite(r.y)
    && Number.isFinite(r.width) && Number.isFinite(r.height)
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function overlapsWorkArea(r: Rect, wa: Rect): boolean {
  return r.x + r.width > wa.x + MIN_VISIBLE && r.x + MIN_VISIBLE < wa.x + wa.width
    && r.y + r.height > wa.y + MIN_VISIBLE && r.y + MIN_VISIBLE < wa.y + wa.height
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** 窗口一多半（严格大于一半）在这块屏上：这时系统一定把它算作这块屏的窗口 */
function mostlyOn(r: Rect, display: DisplayLike): boolean {
  return intersectionArea(r, display.bounds) * 2 > r.width * r.height
}

/** 在可用范围里居中；窗口比可用范围大就缩到刚好放下 */
function centerIn(workArea: Rect, width: number, height: number): Rect {
  const w = Math.min(width, workArea.width)
  const h = Math.min(height, workArea.height)
  return {
    x: workArea.x + Math.round((workArea.width - w) / 2),
    y: workArea.y + Math.round((workArea.height - h) / 2),
    width: w,
    height: h,
  }
}

export function toSavedDisplay(d: DisplayLike): SavedDisplay {
  return { id: d.id, x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }
}

/**
 * 找回存下来的那块屏。先比范围再比 id：
 * Windows 重启或换驱动后显示器编号可能互换，但「右边那块」的范围不变，用户认的是位置；
 * 范围对不上（用户重新排过屏幕）才退回比 id。
 */
export function findSavedDisplay(saved: SavedDisplay | undefined, displays: readonly DisplayLike[]): DisplayLike | undefined {
  if (!isFiniteRect(saved)) return undefined
  return displays.find((d) => sameRect(d.bounds, saved)) ?? displays.find((d) => d.id === saved.id)
}

/** 启动时窗口该怎么摆。存的东西不可信（手改、旧版本、显示器变了），拿不准就回落默认 */
export function resolveWindowPlacement(
  saved: SavedWindowBounds | undefined,
  displays: readonly DisplayLike[],
): WindowPlacement {
  const fallback: WindowPlacement = { ...DEFAULT_WINDOW_SIZE, maximize: false }
  if (!saved || !isFiniteRect(saved) || saved.width < MIN_SAVED_WIDTH || saved.height < MIN_SAVED_HEIGHT) return fallback
  const normal: Rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }

  if (saved.maximized !== true) {
    return displays.some((d) => overlapsWorkArea(normal, d.workArea)) ? { ...normal, maximize: false } : fallback
  }

  // 最大化：系统按窗口当前所在的屏来最大化，所以要先把窗口放到记下的那块屏上
  const target = findSavedDisplay(saved.display, displays)
  if (target) {
    const rect = mostlyOn(normal, target) ? normal : centerIn(target.workArea, normal.width, normal.height)
    return { ...rect, maximize: true }
  }
  // 旧版本存的没有显示器，或那块屏已经拔了：还原位置还看得见就放原处（在哪块屏上就最大化到哪块），否则交给系统摆在主屏
  if (displays.some((d) => overlapsWorkArea(normal, d.workArea))) return { ...normal, maximize: true }
  return { width: normal.width, height: normal.height, maximize: true }
}

export interface SnapshotInput {
  /** `win.getNormalBounds()`：最大化时是还原后的矩形，最小化时也是 */
  normal: Rect
  /** `win.isMaximized()`；最小化时这个值不可靠（见 minimized） */
  maximized: boolean
  minimized: boolean
  /** 窗口当前所在的显示器（`screen.getDisplayMatching(win.getBounds())`）；最小化时不要传 */
  display: DisplayLike | undefined
  /** 上一次记下的最大化状态：最小化时沿用它 */
  previousMaximized: boolean
  /** 上一次记下的显示器：最小化时沿用它 */
  previousDisplay: SavedDisplay | undefined
}

/**
 * 要落盘的窗口位置。
 *
 * 最小化时不能信窗口自己报的状态：Windows 上最大化的窗口一最小化，`isMaximized()` 就变成 false，
 * `getBounds()` 也变成还原后的矩形（`restore()` 之后才又回到最大化）。
 * 如果这时记下去，用户把窗口最小化后退出或自动更新重启，下次启动就不再是最大化了。
 * 所以最小化时「是否最大化」和「在哪块屏」都沿用最近一次可靠的值。
 * 只是 `hide()`（关闭到托盘）时这些值是可靠的，不用特殊处理。
 */
export function buildSavedBounds(input: SnapshotInput): SavedWindowBounds {
  const display = !input.minimized && input.display ? toSavedDisplay(input.display) : input.previousDisplay
  return {
    x: input.normal.x,
    y: input.normal.y,
    width: input.normal.width,
    height: input.normal.height,
    maximized: input.minimized ? input.previousMaximized : input.maximized,
    ...(display ? { display } : {}),
  }
}
