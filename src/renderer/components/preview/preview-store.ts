// ── 预览面板的状态仓库：所有会话各一份标签页，界面只订阅正在看的那个会话 ─────────
//
// 为什么不用 useReducer：主进程会隔三差五推网页状态（标题、加载中、前进后退），后台会话里的网页也一样。
// 放在 React 状态里，每一条都会让整个对话页重绘；放在这里，界面用 useSyncExternalStore 只取当前会话那一份，
// 别的会话里的变化不会引起任何重绘。
//
// 副作用（让主进程加载网页、销毁网页视图）也在这里做，不依赖界面渲染：
// 每次状态变化后「落定」一次——把待加载的网址交给主进程、销毁不要的视图。

import { appChatSessionId } from "../../../shared/app-chat-types"
import type { PreviewWebState } from "../../../shared/preview-types"
import {
  NO_SESSIONS, previewSessionsReducer, releasedWebTabIds, sessionPreview,
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
  newId?: () => string
}

export interface PreviewStore {
  subscribe(listener: () => void): () => void
  /** 某个会话的标签页；会话键用 previewSessionId 换算。引用稳定：这个会话的标签页没变，拿到的就是同一个对象 */
  view(sessionId: string | null): PreviewState
  /** 全部会话（测试和排查用） */
  all(): PreviewSessions
  openFile(sessionKey: string, file: { path: string; name: string; line?: number }): void
  openDir(sessionKey: string, dir: { path: string }): void
  /** 文件夹标签页里换成另一个文件夹（进入子文件夹、回上一级、点面包屑） */
  navigateDir(tabId: string, path: string): void
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
  let idSeq = 0
  const newId = options.newId ?? (() => `pv${Date.now().toString(36)}${(idSeq++).toString(36)}`)

  let sessions: PreviewSessions = NO_SESSIONS
  const listeners = new Set<() => void>()

  const reduce = (action: PreviewSessionsAction) => { sessions = previewSessionsReducer(sessions, action) }

  /** 状态变了之后的善后；before 是变化之前的状态 */
  function settle(before: PreviewSessions): void {
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
    // 关掉的、会话没了的：主进程里的视图一并销毁
    for (const id of releasedWebTabIds(before, sessions)) host.webClose(id)
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
    openFile(sessionKey, file) {
      inSession(previewSessionId(sessionKey), { type: "openFile", id: newId(), sessionKey, path: file.path, name: file.name, line: file.line })
    },
    openDir: (sessionKey, dir) => inSession(previewSessionId(sessionKey), { type: "openDir", id: newId(), sessionKey, path: dir.path }),
    navigateDir: (tabId, path) => onTab(tabId, { type: "navigateDir", id: tabId, path }),
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
      for (const id of releasedWebTabIds(before, sessions)) host.webClose(id)
      if (before !== sessions) emit()
    },
  }
}
