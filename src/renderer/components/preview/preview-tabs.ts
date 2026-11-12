// ── 预览面板的标签页状态（纯函数；id 由调用方生成，保证 reducer 无副作用）────────
// 两层：PreviewState 是「一个会话」的标签页（文件、网页都在里面），previewReducer 管它；
// PreviewSessions 是「所有会话各一份」，previewSessionsReducer 把动作路由到对应会话那一份。

import type { PreviewWebState } from "../../../shared/preview-types"
import { hostLabel, isHttpUrl } from "../../../shared/preview-url"

export interface FileTab {
  id: string
  kind: "file"
  /** 打开时所在的会话：主进程凭它校验这个文件能不能给这个会话看 */
  sessionKey: string
  path: string
  name: string
  /** 要定位到的行号（从对话里的 src/app.ts:42 点开时有）；代码和文本查看器据此滚动并高亮那一行 */
  line?: number
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
  /**
   * 主进程里的网页视图已经销毁（同时开着的网页太多，换出去了最久没看的）：标签页还在，网址留着，
   * 下次要看它时重新加载。页面里没提交的输入、滚动位置会丢，登录状态在共用的存储分区里，不受影响
   */
  discarded?: boolean
}

export type PreviewTab = FileTab | WebTab

/** 一个会话的预览标签页 */
export interface PreviewState {
  tabs: PreviewTab[]
  activeId: string | null
  /** 面板是否展开；收起时标签页保留 */
  open: boolean
}

export const INITIAL_PREVIEW_STATE: PreviewState = { tabs: [], activeId: null, open: false }

/** 一个会话的标签页上限 */
export const MAX_PREVIEW_TABS = 12

/**
 * 所有会话加起来，主进程里同时活着的网页视图上限：每个网页标签页背后是一个完整的浏览器进程，
 * 标签页按会话分开之后总数不再有天然的上限，必须在这里兜住。超出的把最久没看的换出去（discarded）
 */
export const MAX_LIVE_WEB_TABS = 12

export type PreviewAction =
  | { type: "openFile"; id: string; sessionKey: string; path: string; name: string; line?: number }
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
  /** 换出去这些网页标签页（主进程里的视图由调用方销毁） */
  | { type: "discard"; ids: string[] }
  /** 换出去的网页标签页要看了：重新加载它最后停留的网址 */
  | { type: "revive"; id: string }

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
        // 再次点开同一个文件：切过去并重新读取，Agent 可能刚改过它；行号以这一次为准（没带就回到顶部）
        const tabs = state.tabs.map((t) => (t.id === existing.id ? { ...existing, sessionKey: action.sessionKey, line: action.line, reload: existing.reload + 1 } : t))
        return withActive(state, tabs, existing.id)
      }
      const tab: FileTab = {
        id: action.id, kind: "file", sessionKey: action.sessionKey, path: action.path, name: action.name, reload: 0,
        ...(action.line ? { line: action.line } : {}),
      }
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
        tabs: state.tabs.map((t) => (t.id === action.id && t.kind === "web" ? { ...t, url: action.url, pendingUrl: action.url, loading: true, error: undefined, discarded: undefined } : t)),
      }
    }
    case "webStarted":
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id && t.kind === "web" && t.pendingUrl ? { ...t, pendingUrl: undefined } : t)) }
    case "webState": {
      const s = action.state
      const index = state.tabs.findIndex((t) => t.id === s.tabId && t.kind === "web")
      if (index < 0) return state
      const t = state.tabs[index] as WebTab
      // 已经换出去的标签页，主进程里的视图销毁前后可能还有几条状态晚到：不能让它们盖掉换出时的状态
      if (t.discarded) return state
      const next: WebTab = { ...t, url: s.url || t.url, title: s.title, loading: s.loading, canGoBack: s.canGoBack, canGoForward: s.canGoForward, error: s.error, favicon: s.favicon }
      // 页面里标题、前进后退状态隔一会儿就推一条，多半什么都没变：原样返回，订阅它的界面就不用重绘
      if (sameWebView(t, next)) return state
      return { ...state, tabs: state.tabs.map((x, i) => (i === index ? next : x)) }
    }
    case "discard": {
      if (!state.tabs.some((t) => hasNativeView(t) && action.ids.includes(t.id))) return state
      return {
        ...state,
        tabs: state.tabs.map((t) => (
          hasNativeView(t) && action.ids.includes(t.id)
            ? { ...t, discarded: true, pendingUrl: undefined, loading: false, canGoBack: false, canGoForward: false, error: undefined }
            : t
        )),
      }
    }
    case "revive": {
      if (!state.tabs.some((t) => t.id === action.id && t.kind === "web" && t.discarded)) return state
      return {
        ...state,
        tabs: state.tabs.map((t) => (
          t.id === action.id && t.kind === "web" && t.discarded
            ? { ...t, discarded: undefined, pendingUrl: t.url, loading: true }
            : t
        )),
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

/** 这个标签页在主进程里有网页视图：开着网页、没被换出去。空白标签页还没有加载过任何网址，没有视图 */
function hasNativeView(tab: PreviewTab): tab is WebTab {
  return tab.kind === "web" && !!tab.url && !tab.discarded
}

function sameWebView(a: WebTab, b: WebTab): boolean {
  return a.url === b.url && a.title === b.title && a.loading === b.loading && a.canGoBack === b.canGoBack
    && a.canGoForward === b.canGoForward && a.error === b.error && a.favicon === b.favicon
}

// ── 所有会话各一份 ─────────────────────────────────────────────────────────

/** 键是会话的统一标识（appChatSessionId）；没有标签页的会话不留记录 */
export type PreviewSessions = Readonly<Record<string, PreviewState>>

export const NO_SESSIONS: PreviewSessions = {}

export type PreviewSessionsAction =
  /** 对指定会话的标签页做 action */
  | { type: "in"; session: string; action: PreviewAction }
  /** 对 id 这个标签页做 action：它在哪个会话里就对哪个会话做（主进程推来的网页状态、界面上点的标签页） */
  | { type: "byTab"; tabId: string; action: PreviewAction }
  /** 会话没了：它的标签页全部丢掉 */
  | { type: "drop"; session: string }
  /** 换出去这些网页标签页，不管它们在哪个会话里 */
  | { type: "discard"; ids: string[] }

/** 某个会话的标签页；没有就是共用的空状态（引用稳定，可以直接当 useSyncExternalStore 的快照） */
export function sessionPreview(sessions: PreviewSessions, session: string | null): PreviewState {
  return (session && sessions[session]) || INITIAL_PREVIEW_STATE
}

/** 标签页在哪个会话里 */
export function ownerSession(sessions: PreviewSessions, tabId: string): string | undefined {
  for (const key of Object.keys(sessions)) if (sessions[key].tabs.some((t) => t.id === tabId)) return key
  return undefined
}

/** 把一个会话的新状态放回去；没变就原样返回，空了就不留记录 */
function withSession(sessions: PreviewSessions, session: string, inner: PreviewState): PreviewSessions {
  if (inner === sessionPreview(sessions, session)) return sessions
  if (inner.tabs.length === 0) return dropSession(sessions, session)
  return { ...sessions, [session]: inner }
}

function dropSession(sessions: PreviewSessions, session: string): PreviewSessions {
  if (!(session in sessions)) return sessions
  const { [session]: _gone, ...rest } = sessions
  return rest
}

export function previewSessionsReducer(sessions: PreviewSessions, action: PreviewSessionsAction): PreviewSessions {
  switch (action.type) {
    case "in":
      return withSession(sessions, action.session, previewReducer(sessionPreview(sessions, action.session), action.action))
    case "byTab": {
      const session = ownerSession(sessions, action.tabId)
      return session ? withSession(sessions, session, previewReducer(sessions[session], action.action)) : sessions
    }
    case "drop":
      return dropSession(sessions, action.session)
    case "discard": {
      let next = sessions
      for (const key of Object.keys(sessions)) {
        next = withSession(next, key, previewReducer(next[key], { type: "discard", ids: action.ids }))
      }
      return next
    }
  }
}

/** 前后两个状态之间，主进程里的网页视图要销毁的标签页：被关掉、被淘汰、会话没了、被换出去 */
export function releasedWebTabIds(prev: PreviewSessions, next: PreviewSessions): string[] {
  const released: string[] = []
  for (const key of Object.keys(prev)) {
    const before = prev[key]
    const after = next[key]
    if (before === after) continue
    const alive = new Set((after?.tabs ?? []).filter(hasNativeView).map((t) => t.id))
    for (const t of before.tabs) if (hasNativeView(t) && !alive.has(t.id)) released.push(t.id)
  }
  return released
}

/** 所有会话里，主进程中现在活着网页视图的标签页 */
export function liveWebTabIds(sessions: PreviewSessions): string[] {
  const ids: string[] = []
  for (const key of Object.keys(sessions)) for (const t of sessions[key].tabs) if (hasNativeView(t)) ids.push(t.id)
  return ids
}

/**
 * 网页视图超过上限时该换出去的标签页：最久没看的先走。keepId（正在看的标签页）一定留下。
 * lastUsed 是标签页最近一次被看的时间（单调递增的序号即可），没有记录的按最久没看算。
 */
export function pickDiscards(sessions: PreviewSessions, lastUsed: ReadonlyMap<string, number>, keepId: string | null, max: number = MAX_LIVE_WEB_TABS): string[] {
  const live = liveWebTabIds(sessions)
  const over = live.length - max
  if (over <= 0) return []
  return live
    .filter((id) => id !== keepId)
    .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))
    .slice(0, over)
}

/** 标签页上显示的名字 */
export function tabTitle(tab: PreviewTab): string {
  if (tab.kind === "file") return tab.name
  if (tab.title) return tab.title
  return tab.url ? hostLabel(tab.url) : "新标签页"
}
