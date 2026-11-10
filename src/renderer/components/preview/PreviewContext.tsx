import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { baseName } from "../../../shared/preview-kinds"
import { normalizeAddressInput } from "../../../shared/preview-url"
import type { LinkMode } from "./link-mode"
import { createPathResolver } from "./path-resolver"
import { INITIAL_PREVIEW_STATE, previewReducer, removedWebTabIds, type PreviewState } from "./preview-tabs"

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

let idSeq = 0
const newTabId = () => `pv${Date.now().toString(36)}${(idSeq++).toString(36)}`

export interface PreviewController {
  api: PreviewApi
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
}

/** 预览面板的全部状态与和主进程的接线；放在对话页最外层，面板本身只管渲染 */
export function usePreviewController(sessionKey: string | null): PreviewController {
  const [state, dispatch] = useReducer(previewReducer, INITIAL_PREVIEW_STATE)
  const [linkMode, setLinkModeState] = useState<LinkMode>(() => (readStored(LINK_MODE_KEY) === "external" ? "external" : "internal"))
  const [width, setWidthState] = useState<number>(() => {
    const stored = Number(readStored(WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_PANEL_WIDTH
  })

  useEffect(() => {
    const offState = window.electronAPI.onPreviewWebState((s) => dispatch({ type: "webState", state: s }))
    // 网页里的 target=_blank / window.open：开成新标签页
    const offOpen = window.electronAPI.onPreviewWebOpenTab((p) => dispatch({ type: "openWeb", id: newTabId(), url: p.url }))
    return () => { offState(); offOpen() }
  }, [])

  // 新开或跳转的网页标签页：把网址交给主进程去加载（只交一次）
  useEffect(() => {
    for (const tab of state.tabs) {
      if (tab.kind !== "web" || !tab.pendingUrl) continue
      void window.electronAPI.previewWebOpen(tab.id, tab.pendingUrl)
      dispatch({ type: "webStarted", id: tab.id })
    }
  }, [state.tabs])

  // 标签页关掉了，主进程里对应的网页视图也要销毁
  const prevState = useRef(state)
  useEffect(() => {
    for (const id of removedWebTabIds(prevState.current, state)) void window.electronAPI.previewWebClose(id)
    prevState.current = state
  }, [state])

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
    dispatch({ type: "openFile", id: newTabId(), sessionKey: key, path: file.path, name: file.name || baseName(file.path), line: file.line })
  }, [])
  const openUrl = useCallback((url: string) => dispatch({ type: "openWeb", id: newTabId(), url }), [])
  // 缓存跟着会话走：换会话工作目录就变了，同一个相对路径指向的文件也不同
  const resolvePath = useMemo(
    () => (sessionKey ? createPathResolver((paths) => window.electronAPI.previewFileCheck(sessionKey, paths)) : async () => null),
    [sessionKey],
  )

  const api = useMemo<PreviewApi>(() => ({ available: true, linkMode, openFile, openUrl, resolvePath }), [linkMode, openFile, openUrl, resolvePath])

  const openBlankBrowser = useCallback(() => dispatch({ type: "openBlankWeb", id: newTabId() }), [])
  const togglePanel = useCallback(() => {
    if (state.tabs.length === 0) openBlankBrowser()
    else dispatch({ type: "setOpen", open: !state.open })
  }, [state.tabs.length, state.open, openBlankBrowser])

  const navigate = useCallback((id: string, input: string) => {
    const r = normalizeAddressInput(input)
    if (!r.ok) return r.error
    dispatch({ type: "navigateWeb", id, url: r.url })
    return null
  }, [])

  return {
    api,
    state,
    linkMode,
    setLinkMode,
    width,
    setWidth,
    togglePanel,
    openBlankBrowser,
    activate: useCallback((id: string) => dispatch({ type: "activate", id }), []),
    close: useCallback((id: string) => dispatch({ type: "close", id }), []),
    setOpen: useCallback((open: boolean) => dispatch({ type: "setOpen", open }), []),
    navigate,
    reloadFile: useCallback((id: string) => dispatch({ type: "reloadFile", id }), []),
    openAsText: useCallback((id: string) => dispatch({ type: "asText", id }), []),
  }
}
