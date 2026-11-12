// ── 预览面板的状态仓库：所有会话各一份标签页，界面只订阅正在看的那个会话 ─────────
//
// 为什么不用 useReducer：主进程会隔三差五推网页状态（标题、加载中、前进后退），后台会话里的网页也一样。
// 放在 React 状态里，每一条都会让整个对话页重绘；放在这里，界面用 useSyncExternalStore 只取当前会话那一份，
// 别的会话里的变化不会引起任何重绘。
//
// 副作用（让主进程加载网页、销毁网页视图）也在这里做，不依赖界面渲染：
// 每次状态变化后「落定」一次——换回正在看的网页、兜住网页视图总数、把待加载的网址交给主进程、销毁不要的视图。

import { appChatSessionId } from "../../../shared/app-chat-types"
import type { PreviewWebState } from "../../../shared/preview-types"
import {
  liveWebTabIds, MAX_LIVE_WEB_TABS, NO_SESSIONS, pickDiscards, previewSessionsReducer, releasedWebTabIds, sessionPreview,
  type PreviewAction, type PreviewSessions, type PreviewSessionsAction, type PreviewState,
} from "./preview-tabs"

/** 仓库和主进程之间的接口（界面里是 window.electronAPI，测试里是桩） */
export interface PreviewHost {
  /** 让主进程加载网页；这个标签页在主进程里还没有视图就先建一个 */
  webOpen(id: string, url: string): void
  /** 销毁主进程里的网页视图 */
  webClose(id: string): void
}

export interface PreviewStoreOptions {
  /** 同时活着的网页视图上限 */
  maxLiveWeb?: number
  newId?: () => string
}

export interface PreviewStore {
  subscribe(listener: () => void): () => void
  /** 某个会话的标签页；会话键用 previewSessionId 换算。引用稳定：这个会话的标签页没变，拿到的就是同一个对象 */
  view(sessionId: string | null): PreviewState
  /** 全部会话（测试和排查用） */
  all(): PreviewSessions
  /** 「最近看过」的记录条数：只该有活着视图的网页标签页（测试和排查用，防止记录一直攒） */
  trackedTabCount(): number
  /** 界面正在看哪个会话。它当前的网页标签页不会被换出去；换出去的话立刻换回来 */
  setViewing(sessionId: string | null): void
  openFile(sessionKey: string, file: { path: string; name: string; line?: number }): void
  openWeb(sessionKey: string, url: string): void
  openBlankWeb(sessionKey: string): void
  /** 网页里要求新开窗口：开在发起它的那个标签页所在的会话里，不管用户现在看着哪个会话 */
  openWebFrom(fromTabId: string, url: string): void
  navigate(tabId: string, url: string): void
  activate(tabId: string): void
  close(tabId: string): void
  setOpen(sessionId: string, open: boolean): void
  reloadFile(tabId: string): void
  openAsText(tabId: string): void
  /** 主进程推来的网页状态 */
  webState(state: PreviewWebState): void
  /** 会话没了（被删）：它的标签页全部关掉 */
  dropSession(sessionId: string): void
  /** 界面卸载：销毁所有网页视图，清空 */
  dispose(): void
}

/** 会话键换算成仓库里的键 */
export const previewSessionId = appChatSessionId

export function createPreviewStore(host: PreviewHost, options: PreviewStoreOptions = {}): PreviewStore {
  const maxLive = options.maxLiveWeb ?? MAX_LIVE_WEB_TABS
  let idSeq = 0
  const newId = options.newId ?? (() => `pv${Date.now().toString(36)}${(idSeq++).toString(36)}`)

  let sessions: PreviewSessions = NO_SESSIONS
  let viewing: string | null = null
  /** 标签页最近一次被看的序号，换出网页视图时用：最小的先走 */
  const lastUsed = new Map<string, number>()
  let clock = 0
  const listeners = new Set<() => void>()

  const reduce = (action: PreviewSessionsAction) => { sessions = previewSessionsReducer(sessions, action) }
  const touch = (tabId: string | null | undefined) => { if (tabId) lastUsed.set(tabId, ++clock) }
  const viewedActiveId = (): string | null => sessionPreview(sessions, viewing).activeId

  /** 状态变了之后的善后；before 是变化之前的状态 */
  function settle(before: PreviewSessions): void {
    // 正在看的标签页是换出去的：马上换回来（面板收起时没人看，不换）
    const viewed = sessionPreview(sessions, viewing)
    if (viewed.open) {
      const active = viewed.tabs.find((t) => t.id === viewed.activeId)
      if (active?.kind === "web" && active.discarded) reduce({ type: "byTab", tabId: active.id, action: { type: "revive", id: active.id } })
    }
    // 哪个会话换了当前标签页（新开、点选），新的当前标签页就是刚被看过的；
    // 换的是正在看的会话，被换下去的那个直到刚才还在看，同样算刚看过
    for (const key of Object.keys(sessions)) {
      if (sessions[key] === before[key]) continue
      const prevActive = before[key]?.activeId
      const activeId = sessions[key].activeId
      if (activeId === prevActive) continue
      if (key === viewing) touch(prevActive)
      touch(activeId)
    }
    // 同时活着的网页视图不能超过上限
    const victims = pickDiscards(sessions, lastUsed, viewedActiveId(), maxLive)
    if (victims.length > 0) reduce({ type: "discard", ids: victims })
    // 待加载的网址交给主进程，只交一次
    const started: string[] = []
    for (const key of Object.keys(sessions)) {
      for (const t of sessions[key].tabs) {
        if (t.kind !== "web" || !t.pendingUrl) continue
        host.webOpen(t.id, t.pendingUrl)
        started.push(t.id)
      }
    }
    for (const id of started) reduce({ type: "byTab", tabId: id, action: { type: "webStarted", id } })
    // 关掉的、淘汰的、会话没了的、换出去的：主进程里的视图一并销毁
    for (const id of releasedWebTabIds(before, sessions)) host.webClose(id)
    // 看过的记录只留给还活着视图的网页标签页，别的（文件标签页、关掉的、换出去的）不能一直攒着
    const alive = new Set(liveWebTabIds(sessions))
    for (const id of [...lastUsed.keys()]) if (!alive.has(id)) lastUsed.delete(id)
  }

  function emit(): void {
    for (const fn of [...listeners]) fn()
  }

  function apply(action: PreviewSessionsAction): void {
    const before = sessions
    reduce(action)
    if (sessions === before) return
    settle(before)
    emit()
  }

  const inSession = (session: string, action: PreviewAction) => apply({ type: "in", session, action })
  const onTab = (tabId: string, action: PreviewAction) => apply({ type: "byTab", tabId, action })

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    view: (sessionId) => sessionPreview(sessions, sessionId),
    all: () => sessions,
    trackedTabCount: () => lastUsed.size,
    setViewing(sessionId) {
      if (sessionId === viewing) return
      const before = sessions
      touch(viewedActiveId()) // 离开的这个会话，它当前的标签页直到刚才还在看
      viewing = sessionId
      touch(viewedActiveId())
      settle(before)
      if (sessions !== before) emit()
    },
    openFile(sessionKey, file) {
      inSession(previewSessionId(sessionKey), { type: "openFile", id: newId(), sessionKey, path: file.path, name: file.name, line: file.line })
    },
    openWeb: (sessionKey, url) => inSession(previewSessionId(sessionKey), { type: "openWeb", id: newId(), url }),
    openBlankWeb: (sessionKey) => inSession(previewSessionId(sessionKey), { type: "openBlankWeb", id: newId() }),
    openWebFrom: (fromTabId, url) => onTab(fromTabId, { type: "openWeb", id: newId(), url }),
    navigate: (tabId, url) => onTab(tabId, { type: "navigateWeb", id: tabId, url }),
    activate: (tabId) => onTab(tabId, { type: "activate", id: tabId }),
    close: (tabId) => onTab(tabId, { type: "close", id: tabId }),
    setOpen: (sessionId, open) => inSession(sessionId, { type: "setOpen", open }),
    reloadFile: (tabId) => onTab(tabId, { type: "reloadFile", id: tabId }),
    openAsText: (tabId) => onTab(tabId, { type: "asText", id: tabId }),
    webState: (state) => onTab(state.tabId, { type: "webState", state }),
    dropSession: (sessionId) => apply({ type: "drop", session: sessionId }),
    dispose() {
      const before = sessions
      sessions = NO_SESSIONS
      viewing = null
      for (const id of releasedWebTabIds(before, sessions)) host.webClose(id)
      lastUsed.clear()
      if (before !== sessions) emit()
    },
  }
}
