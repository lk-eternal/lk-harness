import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import {
  ArrowLeft, ArrowRight, Check, ChevronsRight, Copy, ExternalLink, FileCode, FileText, Film, FolderOpen,
  Globe, Image as ImageIcon, Loader2, MoreHorizontal, Music, Plus, RotateCw, Table, X,
} from "lucide-react"
import { canOpenWithDefaultApp, previewTypeOf, type PreviewKind } from "../../../shared/preview-kinds"
import { acquireOverlay } from "../overlay-presence"
import useOutsideClose from "../../hooks/useOutsideClose"
import FileViewer from "./FileViewer"
import WebViewer from "./WebViewer"
import { BarButton } from "./preview-ui"
import { tabTitle, type FileTab, type PreviewTab, type WebTab } from "./preview-tabs"
import type { PreviewController } from "./PreviewContext"

export const MIN_PANEL_WIDTH = 320
/** 对话页左侧会话列表的宽度，加上对话区至少要留的宽度：面板不能把它们挤没 */
const RESERVED_WIDTH = 240 + 300

function clampWidth(width: number, windowWidth: number): number {
  return Math.min(Math.max(width, MIN_PANEL_WIDTH), Math.max(MIN_PANEL_WIDTH, windowWidth - RESERVED_WIDTH))
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  return width
}

const KIND_ICON: Record<PreviewKind, typeof FileText> = {
  text: FileText, code: FileCode, markdown: FileText, html: FileCode, csv: Table,
  image: ImageIcon, pdf: FileText, audio: Music, video: Film, unsupported: FileText,
}

function TabIcon({ tab }: { tab: PreviewTab }) {
  if (tab.kind === "web") {
    if (tab.loading) return <Loader2 size={13} className="shrink-0 animate-spin text-fg-muted" />
    if (tab.favicon) return <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" onError={(e) => { e.currentTarget.style.display = "none" }} />
    return <Globe size={13} className="shrink-0 text-fg-muted" />
  }
  const Icon = KIND_ICON[previewTypeOf(tab.name).kind]
  return <Icon size={13} className="shrink-0 text-accent" />
}

function TabStrip({ controller }: { controller: PreviewController }) {
  const { state } = controller
  const stripRef = useRef<HTMLDivElement>(null)
  // 标签页多了会横向溢出：当前标签页滚进可视区
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>("[data-active=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [state.activeId, state.tabs.length])
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line-subtle bg-surface/60">
      {/* 不显示滚动条（占高度又难看）；鼠标滚轮直接横向滚动 */}
      <div
        ref={stripRef}
        onWheel={(e) => { if (e.deltaY !== 0 && e.currentTarget.scrollWidth > e.currentTarget.clientWidth) e.currentTarget.scrollLeft += e.deltaY }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {state.tabs.map((tab) => {
          const on = tab.id === state.activeId
          return (
            <div
              key={tab.id}
              data-active={on}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); controller.close(tab.id) } }}
              className={`group/tab flex max-w-[180px] shrink-0 items-center border-r border-line-subtle ${on ? "bg-page text-fg" : "text-fg-muted hover:bg-raised/50 hover:text-fg-2"}`}
            >
              <button type="button" onClick={() => controller.activate(tab.id)} title={tab.kind === "file" ? tab.path : tab.url || "新标签页"} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2.5 pr-1 text-xs">
                <TabIcon tab={tab} />
                <span className="truncate">{tabTitle(tab)}</span>
              </button>
              <button type="button" onClick={() => controller.close(tab.id)} title="关闭标签页" className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint transition hover:bg-strong/60 hover:text-fg"><X size={12} /></button>
            </div>
          )
        })}
        <button type="button" onClick={controller.openBlankBrowser} title="新建浏览器标签页" className="flex w-8 shrink-0 items-center justify-center text-fg-muted transition hover:bg-raised/50 hover:text-fg-2"><Plus size={14} /></button>
      </div>
      <button type="button" onClick={() => controller.setOpen(false)} title="收起预览面板" className="flex w-8 shrink-0 items-center justify-center border-l border-line-subtle text-fg-muted transition hover:bg-raised/50 hover:text-fg-2"><ChevronsRight size={15} /></button>
    </div>
  )
}

/** 弹出的菜单会盖在原生网页视图上，打开期间登记成界面弹层，让网页视图先让位 */
function useMenuOverlay(open: boolean): void {
  useEffect(() => (open ? acquireOverlay() : undefined), [open])
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return [copied, (text) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }]
}

function WebToolbar({ tab, controller }: { tab: WebTab; controller: PreviewController }) {
  const [draft, setDraft] = useState(tab.url)
  const [editing, setEditing] = useState(false)
  const [addrError, setAddrError] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, copy] = useCopied()
  const [cleared, setCleared] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useMenuOverlay(menuOpen)
  useOutsideClose(menuOpen, menuRef, closeMenu)

  // 没在输入时，地址栏跟着页面当前网址走；空白标签页自动聚焦地址栏
  useEffect(() => { if (!editing) setDraft(tab.url) }, [tab.url, editing])
  useEffect(() => { if (!tab.url) inputRef.current?.focus() }, [tab.id, tab.url])

  const submit = () => {
    const error = controller.navigate(tab.id, draft)
    setAddrError(error ?? "")
    if (!error) inputRef.current?.blur()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit()
    else if (e.key === "Escape") { setDraft(tab.url); setAddrError(""); inputRef.current?.blur() }
  }
  const nav = (action: "back" | "forward" | "reload" | "stop") => void window.electronAPI.previewWebNav(tab.id, action)

  return (
    <div className="shrink-0 border-b border-line-subtle">
      <div className="flex h-10 items-center gap-1 px-2">
        <BarButton title="后退" disabled={!tab.canGoBack} onClick={() => nav("back")}><ArrowLeft size={15} /></BarButton>
        <BarButton title="前进" disabled={!tab.canGoForward} onClick={() => nav("forward")}><ArrowRight size={15} /></BarButton>
        {tab.loading
          ? <BarButton title="停止加载" onClick={() => nav("stop")}><X size={15} /></BarButton>
          : <BarButton title="刷新" disabled={!tab.url} onClick={() => nav("reload")}><RotateCw size={14} /></BarButton>}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => { setEditing(true); e.currentTarget.select() }}
          onBlur={() => { setEditing(false); setAddrError("") }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="输入网址，回车打开"
          className={`mx-1 h-7 min-w-0 flex-1 rounded-md border bg-surface px-2.5 text-xs text-fg-soft outline-none transition placeholder:text-fg-faint focus:border-blue-500 ${addrError ? "border-danger-line" : "border-line-subtle"}`}
        />
        <BarButton title="用系统浏览器打开" disabled={!tab.url} onClick={() => void window.electronAPI.previewOpenExternalUrl(tab.url)}><ExternalLink size={14} /></BarButton>
        <div className="relative" ref={menuRef}>
          <BarButton title="更多" active={menuOpen} onClick={() => setMenuOpen((o) => !o)}><MoreHorizontal size={15} /></BarButton>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded border border-line bg-page py-1 shadow-lg">
              <button type="button" disabled={!tab.url} onClick={() => { copy(tab.url); setMenuOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-surface disabled:opacity-40"><Copy size={12} />复制网址</button>
              <button
                type="button"
                onClick={() => { void window.electronAPI.previewWebClearData().then(() => { setCleared(true); window.setTimeout(() => setCleared(false), 2000) }); setMenuOpen(false) }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-surface"
              >清除浏览数据</button>
            </div>
          )}
        </div>
      </div>
      {(addrError || copied || cleared) && (
        <p className={`px-3 pb-1 text-[11px] ${addrError ? "text-danger" : "text-success"}`}>{addrError || (copied ? "网址已复制" : "已清除登录状态、Cookie 和缓存")}</p>
      )}
    </div>
  )
}

function FileToolbar({ tab, controller }: { tab: FileTab; controller: PreviewController }) {
  const [copied, copy] = useCopied()
  const [error, setError] = useState("")
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn()
    setError(r.ok ? "" : (r.error ?? "操作失败"))
  }
  return (
    <div className="shrink-0 border-b border-line-subtle">
      <div className="flex h-10 items-center gap-1 px-2">
        <p className="mx-1 min-w-0 flex-1 truncate text-xs text-fg-muted" title={tab.path}>{tab.path}</p>
        <BarButton title="重新读取文件" onClick={() => controller.reloadFile(tab.id)}><RotateCw size={14} /></BarButton>
        <BarButton title={copied ? "已复制" : "复制路径"} onClick={() => copy(tab.path)}>{copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}</BarButton>
        {canOpenWithDefaultApp(tab.path) && (
          <BarButton title="用默认程序打开" onClick={() => void run(() => window.electronAPI.appChatOpenFile(tab.path))}><ExternalLink size={14} /></BarButton>
        )}
        <BarButton title="在文件夹中显示" onClick={() => void run(() => window.electronAPI.appChatShowInFolder(tab.path))}><FolderOpen size={14} /></BarButton>
      </div>
      {error && <p className="px-3 pb-1 text-[11px] text-danger">{error}</p>}
    </div>
  )
}

/** 对话页右侧的预览面板：多标签页，文件和网页可以混开 */
export default function PreviewPanel({ controller, visible }: { controller: PreviewController; visible: boolean }) {
  const { state } = controller
  const windowWidth = useWindowWidth()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  // 拖动的起点和最新宽度放 ref：pointer 事件连发时处理函数里读 state 会读到旧值
  const drag = useRef<{ x: number; width: number; latest: number } | null>(null)
  const tab = state.tabs.find((t) => t.id === state.activeId)
  if (!state.open || !tab) return null

  const width = dragWidth ?? clampWidth(controller.width, windowWidth)
  const dragging = dragWidth !== null

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width, latest: width }
    setDragWidth(width)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    d.latest = clampWidth(d.width + (d.x - e.clientX), window.innerWidth)
    setDragWidth(d.latest)
  }
  /** 松手、取消、指针捕获被丢掉都走这里：拖动状态不能卡住（卡住了网页视图会一直让位） */
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    controller.setWidth(d.latest)
    setDragWidth(null)
  }

  return (
    <>
      {/* 分隔条放在布局流里（不压在任何一侧上）：原生网页视图盖在面板内容上，压在面板上的分隔条会被它挡住一半 */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        title="拖动调整宽度"
        className={`w-1.5 shrink-0 cursor-col-resize touch-none transition hover:bg-blue-500/30 ${dragging ? "bg-blue-500/40" : ""}`}
      />
      <aside style={{ width }} className="flex shrink-0 flex-col border-l border-line-subtle bg-page">
        <TabStrip controller={controller} />
        {tab.kind === "web" ? <WebToolbar key={tab.id} tab={tab} controller={controller} /> : <FileToolbar tab={tab} controller={controller} />}
        <div className="min-h-0 flex-1">
          {tab.kind === "web"
            ? <WebViewer key={tab.id} tab={tab} visible={visible} dragging={dragging} />
            : <FileViewer key={tab.id} tab={tab} onAsText={() => controller.openAsText(tab.id)} />}
        </div>
      </aside>
    </>
  )
}
