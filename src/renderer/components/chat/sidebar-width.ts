import { useState } from "react"
import { defaultStorage, type StorageLike } from "./sidebar-state"

const KEY = "lk.chat.sidebarWidth"

export const DEFAULT_SIDEBAR_WIDTH = 240
/**
 * 最窄就是默认宽度，只能往宽调：会话栏底部「手机端 / 记录占用 / 清空全部」一行在 240 以下放不下。
 * 这个功能是为了让会话标题显示得全，不是为了把栏变窄。
 */
export const MIN_SIDEBAR_WIDTH = DEFAULT_SIDEBAR_WIDTH
export const MAX_SIDEBAR_WIDTH = 480
/** 键盘左右键每按一下调多少 */
export const SIDEBAR_KEY_STEP = 16

/** 对话区至少要留的宽度：会话栏和预览面板不能把它挤没 */
export const MIN_CHAT_WIDTH = 300
/** 预览面板最窄 */
export const MIN_PANEL_WIDTH = 320

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

/** 会话栏最宽能调到多少：不超过上限，也不能把对话区（预览面板展开时还有它的最小宽度）挤没；窗口太窄时就是最窄 */
export function maxSidebarWidth(windowWidth: number, previewShown: boolean): number {
  const room = windowWidth - MIN_CHAT_WIDTH - (previewShown ? MIN_PANEL_WIDTH : 0)
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, room))
}

/** 存着的宽度，在窗口现在这么宽时实际显示多宽（窗口缩小后栏会跟着收，窗口放大后又回到存着的宽度） */
export function clampSidebarWidth(width: number, windowWidth: number, previewShown: boolean): number {
  return clamp(width, MIN_SIDEBAR_WIDTH, maxSidebarWidth(windowWidth, previewShown))
}

/** 会话栏此刻在屏幕上占多宽；收起时不占 */
export function shownSidebarWidth(stored: number, windowWidth: number, previewShown: boolean, collapsed: boolean): number {
  return collapsed ? 0 : clampSidebarWidth(stored, windowWidth, previewShown)
}

/** 预览面板最宽能调到多少：会话栏占了多少就让出多少，窗口太窄时就是最窄 */
export function maxPreviewWidth(windowWidth: number, sidebarWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH, windowWidth - sidebarWidth - MIN_CHAT_WIDTH)
}

export function clampPreviewWidth(width: number, windowWidth: number, sidebarWidth: number): number {
  return clamp(width, MIN_PANEL_WIDTH, maxPreviewWidth(windowWidth, sidebarWidth))
}

/** 拖动中：分隔条在会话栏右边，指针往右移多少，栏就宽多少 */
export function draggedSidebarWidth(startWidth: number, startX: number, clientX: number, windowWidth: number, previewShown: boolean): number {
  return clampSidebarWidth(startWidth + (clientX - startX), windowWidth, previewShown)
}

/** 键盘调整：direction 为 1 变宽、-1 变窄 */
export function steppedSidebarWidth(width: number, direction: 1 | -1, windowWidth: number, previewShown: boolean): number {
  return clampSidebarWidth(width + direction * SIDEBAR_KEY_STEP, windowWidth, previewShown)
}

/** 上次存的宽度；没存过、存的不是正数、读不了都用默认宽度，超出范围的收回范围内 */
export function loadSidebarWidth(storage: StorageLike | undefined = defaultStorage()): number {
  try {
    const raw = storage?.getItem(KEY)
    if (raw == null) return DEFAULT_SIDEBAR_WIDTH
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIDEBAR_WIDTH
    return clamp(Math.round(n), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

export function saveSidebarWidth(width: number, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(KEY, String(Math.round(width)))
  } catch { /* 存不了就只在本次运行里生效 */ }
}

/**
 * 会话栏宽度的存放处。拖动时宽度每一帧都在变，放在 React state 里会让整个对话页跟着每帧重绘，
 * 所以放在外面：只有订阅它的组件（会话栏外壳、预览面板）会重绘，对话页和聊天列表不动。
 */
export interface SidebarWidthStore {
  get(): number
  subscribe(listener: () => void): () => void
  /** 拖动中：只改内存里的值并通知订阅者，不写存储（每帧写一次存储没有必要） */
  preview(width: number): void
  /** 定下来：不传就按当前值，写进存储 */
  commit(width?: number): void
  /** 恢复默认宽度，并写进存储 */
  reset(): void
}

export function createSidebarWidthStore(storage: StorageLike | undefined = defaultStorage()): SidebarWidthStore {
  let width = loadSidebarWidth(storage)
  const listeners = new Set<() => void>()
  const set = (next: number) => {
    const w = clamp(Math.round(next), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
    if (w === width) return
    width = w
    for (const fn of [...listeners]) fn()
  }
  return {
    get: () => width,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    preview: set,
    commit(next) {
      if (next !== undefined) set(next)
      saveSidebarWidth(width, storage)
    },
    reset() {
      set(DEFAULT_SIDEBAR_WIDTH)
      saveSidebarWidth(width, storage)
    },
  }
}

export interface SidebarDrag {
  readonly active: boolean
  /** 开始拖：width 是栏此刻显示的宽度（不是存着的）。已经在拖了就忽略，返回 false */
  start(clientX: number, width: number): boolean
  /** 指针移动：只改内存里的宽度，不写存储 */
  move(clientX: number): void
  /** 松手、取消、指针捕获丢了都走这里：撤销让位并把最终宽度存一次。可以重复调用，返回这次是否真的结束了一次拖动 */
  end(): boolean
  /** 拖动中组件被卸载：只撤销让位，不存 */
  dispose(): void
}

/**
 * 一次拖动调宽的全过程，和 DOM 无关，组件只负责把指针事件接进来。
 * 右边预览面板里的网页是盖在界面上的原生视图，指针划过它时这边就收不到事件了，
 * 所以拖动期间要登记一个「让位」，让网页视图先藏起来；登记了就必须撤销，否则网页视图会一直藏着。
 */
export function createSidebarDrag(deps: {
  store: SidebarWidthStore
  /** 登记让位，返回撤销函数（用 overlay-presence 的 acquireOverlay） */
  acquireOverlay: () => () => void
  windowWidth: () => number
  previewShown: () => boolean
}): SidebarDrag {
  let current: { x: number; width: number; release: () => void } | null = null
  return {
    get active() { return current !== null },
    start(clientX, width) {
      if (current) return false
      current = { x: clientX, width, release: deps.acquireOverlay() }
      return true
    },
    move(clientX) {
      if (!current) return
      deps.store.preview(draggedSidebarWidth(current.width, current.x, clientX, deps.windowWidth(), deps.previewShown()))
    },
    end() {
      if (!current) return false
      const { release } = current
      current = null
      release()
      deps.store.commit()
      return true
    },
    dispose() {
      if (!current) return
      const { release } = current
      current = null
      release()
    },
  }
}

/** 对话页用的那一份：整个页面生命周期里只建一次 */
export function useSidebarWidthStore(): SidebarWidthStore {
  const [store] = useState(() => createSidebarWidthStore())
  return store
}
