// ── 预览面板的标签页状态（纯函数；id 由调用方生成，保证 reducer 无副作用）────────

import type { PreviewWebState } from "../../../shared/preview-types"
import { hostLabel, isHttpUrl } from "../../../shared/preview-url"

export interface FileTab {
  id: string
  kind: "file"
  /** 打开时所在的会话：主进程凭它校验这个文件能不能给这个会话看 */
  sessionKey: string
  path: string
  name: string
  /** 用户选了「按文本打开」：不认识的类型也当文本读 */
  asText?: boolean
  /** 递增即重新读取（再次点开同一文件、手动刷新） */
  reload: number
}

export interface WebTab {
  id: string
  kind: "web"
  /** 当前网址；还没打开过任何网页的空白标签页为空 */
  url: string
  /** 等着交给主进程去加载的网址；加载一经发出就清掉 */
  pendingUrl?: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
  favicon?: string
}

export type PreviewTab = FileTab | WebTab

export interface PreviewState {
  tabs: PreviewTab[]
  activeId: string | null
  /** 面板是否展开；收起时标签页保留 */
  open: boolean
}

export const INITIAL_PREVIEW_STATE: PreviewState = { tabs: [], activeId: null, open: false }

/** 标签页上限：每个网页标签页背后是一个完整的浏览器进程，不能无限开 */
export const MAX_PREVIEW_TABS = 12

export type PreviewAction =
  | { type: "openFile"; id: string; sessionKey: string; path: string; name: string }
  | { type: "openWeb"; id: string; url: string }
  | { type: "openBlankWeb"; id: string }
  | { type: "navigateWeb"; id: string; url: string }
  | { type: "webStarted"; id: string }
  | { type: "webState"; state: PreviewWebState }
  | { type: "asText"; id: string }
  | { type: "reloadFile"; id: string }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "setOpen"; open: boolean }

const norm = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase()

/** 超过上限就丢最早打开的、且不是当前正看的那个 */
function capTabs(tabs: PreviewTab[], activeId: string | null): PreviewTab[] {
  let next = tabs
  while (next.length > MAX_PREVIEW_TABS) {
    const drop = next.findIndex((t) => t.id !== activeId)
    next = next.filter((_, i) => i !== drop)
  }
  return next
}

function withActive(state: PreviewState, tabs: PreviewTab[], activeId: string): PreviewState {
  return { tabs: capTabs(tabs, activeId), activeId, open: true }
}

function blankWebTab(id: string): WebTab {
  return { id, kind: "web", url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
}

export function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case "openFile": {
      const existing = state.tabs.find((t): t is FileTab => t.kind === "file" && norm(t.path) === norm(action.path))
      if (existing) {
        // 再次点开同一个文件：切过去并重新读取，Agent 可能刚改过它
        const tabs = state.tabs.map((t) => (t.id === existing.id ? { ...existing, sessionKey: action.sessionKey, reload: existing.reload + 1 } : t))
        return withActive(state, tabs, existing.id)
      }
      const tab: FileTab = { id: action.id, kind: "file", sessionKey: action.sessionKey, path: action.path, name: action.name, reload: 0 }
      return withActive(state, [...state.tabs, tab], tab.id)
    }
    case "openWeb": {
      if (!isHttpUrl(action.url)) return state
      const existing = state.tabs.find((t) => t.kind === "web" && t.url === action.url)
      if (existing) return withActive(state, state.tabs, existing.id)
      const tab: WebTab = { ...blankWebTab(action.id), url: action.url, pendingUrl: action.url, loading: true }
      return withActive(state, [...state.tabs, tab], tab.id)
    }
    case "openBlankWeb":
      return withActive(state, [...state.tabs, blankWebTab(action.id)], action.id)
    case "navigateWeb": {
      if (!isHttpUrl(action.url)) return state
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.id && t.kind === "web" ? { ...t, url: action.url, pendingUrl: action.url, loading: true, error: undefined } : t)),
      }
    }
    case "webStarted":
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id && t.kind === "web" && t.pendingUrl ? { ...t, pendingUrl: undefined } : t)) }
    case "webState": {
      const s = action.state
      return {
        ...state,
        tabs: state.tabs.map((t) => {
          if (t.id !== s.tabId || t.kind !== "web") return t
          return { ...t, url: s.url || t.url, title: s.title, loading: s.loading, canGoBack: s.canGoBack, canGoForward: s.canGoForward, error: s.error, favicon: s.favicon }
        }),
      }
    }
    case "asText":
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id && t.kind === "file" ? { ...t, asText: true, reload: t.reload + 1 } : t)) }
    case "reloadFile":
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id && t.kind === "file" ? { ...t, reload: t.reload + 1 } : t)) }
    case "activate":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeId: action.id, open: true } : state
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id)
      if (index < 0) return state
      const tabs = state.tabs.filter((t) => t.id !== action.id)
      if (tabs.length === 0) return { tabs, activeId: null, open: false }
      // 关的是当前标签页：切到右边那个，没有就切到左边那个
      const activeId = state.activeId === action.id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId
      return { ...state, tabs, activeId }
    }
    case "setOpen":
      return state.tabs.length === 0 ? state : { ...state, open: action.open }
  }
}

/** 前后两个状态之间被移除的网页标签页：主进程里对应的视图要跟着销毁 */
export function removedWebTabIds(prev: PreviewState, next: PreviewState): string[] {
  const alive = new Set(next.tabs.map((t) => t.id))
  return prev.tabs.filter((t) => t.kind === "web" && !alive.has(t.id)).map((t) => t.id)
}

/** 标签页上显示的名字 */
export function tabTitle(tab: PreviewTab): string {
  if (tab.kind === "file") return tab.name
  if (tab.title) return tab.title
  return tab.url ? hostLabel(tab.url) : "新标签页"
}
