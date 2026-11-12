import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { baseName } from "../../../shared/preview-kinds"
import { normalizeAddressInput } from "../../../shared/preview-url"
import type { LinkMode } from "./link-mode"
import { createPathResolver } from "./path-resolver"
import { createPreviewStore, previewSessionId, type PreviewHost } from "./preview-store"
import type { PreviewState } from "./preview-tabs"

export type { LinkMode }

/** 对话里的文件卡、链接用它打开预览；外层没有预览面板时（手机端等）available 为 false，调用方用各自原来的行为 */
export interface PreviewApi {
  available: boolean
  linkMode: LinkMode
  openFile(file: { path: string; name?: string; line?: number }): void
  openUrl(url: string): void
  /** 对话文字里出现的路径能不能预览：能就返回绝对路径，不能返回 null（带缓存，同一时刻的多个请求合并成一次主进程调用） */
  resolvePath(raw: string): Promise<string | null>
}

const UNAVAILABLE: PreviewApi = {
  available: false, linkMode: "external", openFile: () => undefined, openUrl: () => undefined, resolvePath: async () => null,
}

export const PreviewContext = createContext<PreviewApi>(UNAVAILABLE)

export function usePreview(): PreviewApi {
  return useContext(PreviewContext)
}

const LINK_MODE_KEY = "lk.preview.linkMode"
const WIDTH_KEY = "lk.preview.width"
export const DEFAULT_PANEL_WIDTH = 520

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch { /* 存不了就只在本次运行里生效 */ }
}

/** 仓库和主进程的接线；用到时才读 window.electronAPI */
const ELECTRON_HOST: PreviewHost = {
  webOpen: (id, url) => { void window.electronAPI.previewWebOpen(id, url) },
  webClose: (id) => { void window.electronAPI.previewWebClose(id) },
}

export interface PreviewController {
  api: PreviewApi
  /** 当前会话的标签页：文件和网页都跟着会话走，换会话看到的就是那个会话自己的 */
  state: PreviewState
  linkMode: LinkMode
  setLinkMode(mode: LinkMode): void
  width: number
  setWidth(width: number): void
  /** 标题栏按钮：有标签页就展开/收起面板，没有就新开一个空白浏览器标签页 */
  togglePanel(): void
  openBlankBrowser(): void
  activate(id: string): void
  close(id: string): void
  setOpen(open: boolean): void
  /** 地址栏提交；返回错误提示，成功返回 null */
  navigate(id: string, input: string): string | null
  reloadFile(id: string): void
  openAsText(id: string): void
  /** 会话被删了：它的标签页全部关掉，网页视图一并销毁 */
  dropSession(sessionKey: string): void
}

/**
 * 预览面板的全部状态与和主进程的接线；放在对话页最外层，面板本身只管渲染。
 * 每个会话各有一份标签页（文件、网页都是）和各自的展开/收起；面板宽度和点链接的方式是整个应用共用的。
 * 状态在 preview-store 里，这里只订阅 sessionKey 这个会话的那一份：别的会话里的网页状态变化不会引起重绘。
 */
export function usePreviewController(sessionKey: string | null): PreviewController {
  const [store] = useState(() => createPreviewStore(ELECTRON_HOST))
  const sessionId = useMemo(() => (sessionKey ? previewSessionId(sessionKey) : null), [sessionKey])
  const getView = () => store.view(sessionId)
  const state = useSyncExternalStore(store.subscribe, getView, getView)
  const [linkMode, setLinkModeState] = useState<LinkMode>(() => (readStored(LINK_MODE_KEY) === "external" ? "external" : "internal"))
  const [width, setWidthState] = useState<number>(() => {
    const stored = Number(readStored(WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_PANEL_WIDTH
  })

  useEffect(() => {
    const offState = window.electronAPI.onPreviewWebState((s) => store.webState(s))
    // 网页里的 target=_blank / window.open：开成新标签页，开在发起它的那个标签页所在的会话里
    const offOpen = window.electronAPI.onPreviewWebOpenTab((p) => store.openWebFrom(p.fromTabId, p.url))
    return () => { offState(); offOpen() }
  }, [store])

  // 对话页卸载：主进程里的网页视图不能留下
  useEffect(() => () => store.dispose(), [store])

  // 告诉仓库正看着哪个会话：它的网页标签页不会被换出去，已经被换出去的立刻换回来（在绘制前，不闪空白）
  useLayoutEffect(() => { store.setViewing(sessionId) }, [store, sessionId])

  const sessionRef = useRef(sessionKey)
  sessionRef.current = sessionKey

  const setLinkMode = useCallback((mode: LinkMode) => {
    setLinkModeState(mode)
    writeStored(LINK_MODE_KEY, mode)
  }, [])
  const setWidth = useCallback((w: number) => {
    setWidthState(w)
    writeStored(WIDTH_KEY, String(Math.round(w)))
  }, [])

  const openFile = useCallback((file: { path: string; name?: string; line?: number }) => {
    const key = sessionRef.current
    if (!key) return
    store.openFile(key, { path: file.path, name: file.name || baseName(file.path), line: file.line })
  }, [store])
  const openUrl = useCallback((url: string) => {
    const key = sessionRef.current
    if (key) store.openWeb(key, url)
  }, [store])
  // 缓存跟着会话走：换会话工作目录就变了，同一个相对路径指向的文件也不同
  const resolvePath = useMemo(
    () => (sessionKey ? createPathResolver((paths) => window.electronAPI.previewFileCheck(sessionKey, paths)) : async () => null),
    [sessionKey],
  )

  const api = useMemo<PreviewApi>(() => ({ available: true, linkMode, openFile, openUrl, resolvePath }), [linkMode, openFile, openUrl, resolvePath])

  const openBlankBrowser = useCallback(() => {
    const key = sessionRef.current
    if (key) store.openBlankWeb(key)
  }, [store])
  const setOpen = useCallback((open: boolean) => {
    if (sessionId) store.setOpen(sessionId, open)
  }, [store, sessionId])
  const togglePanel = useCallback(() => {
    if (state.tabs.length === 0) openBlankBrowser()
    else setOpen(!state.open)
  }, [state.tabs.length, state.open, openBlankBrowser, setOpen])

  const navigate = useCallback((id: string, input: string) => {
    const r = normalizeAddressInput(input)
    if (!r.ok) return r.error
    store.navigate(id, r.url)
    return null
  }, [store])

  return {
    api,
    state,
    linkMode,
    setLinkMode,
    width,
    setWidth,
    togglePanel,
    openBlankBrowser,
    activate: useCallback((id: string) => store.activate(id), [store]),
    close: useCallback((id: string) => store.close(id), [store]),
    setOpen,
    navigate,
    reloadFile: useCallback((id: string) => store.reloadFile(id), [store]),
    openAsText: useCallback((id: string) => store.openAsText(id), [store]),
    dropSession: useCallback((key: string) => store.dropSession(previewSessionId(key)), [store]),
  }
}
