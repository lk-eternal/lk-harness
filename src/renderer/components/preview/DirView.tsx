import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowUp, ChevronRight, File, Folder } from "lucide-react"
import { parentPath, pathCrumbs } from "../../../shared/preview-kinds"
import { formatBytes } from "../../../shared/preview-text"
import { useLoaded, usePreviewHost } from "./preview-host"
import { BarButton, CenterMessage, Loading, ViewerBar, ViewerNotice } from "./preview-ui"

function formatTime(ms: number): string {
  if (ms === 0) return ""
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 文件夹的内容（只一层）。点子文件夹、点面包屑、点「上一级」都交给 onOpenDir（在原地换成那个文件夹），
 * 点文件交给 onOpenFile，由调用方决定开在哪。电脑端的预览面板和手机端的预览页共用。
 */
export default function DirView({ sessionKey, path, reload = 0, onOpenFile, onOpenDir, actions }: {
  sessionKey: string
  /** 要显示的文件夹（绝对路径） */
  path: string
  /** 递增即重新读取 */
  reload?: number
  onOpenFile: (file: { path: string; name: string }) => void
  onOpenDir: (path: string) => void
  /** 放在面包屑那一行的最右边（电脑端的重新读取、复制路径这类按钮）；这一行允许换行，按钮可以带自己的提示行 */
  actions?: ReactNode
}) {
  const host = usePreviewHost()
  const state = useLoaded(async () => {
    const r = await host.dirList(sessionKey, path)
    return r.ok ? { ok: true as const, value: r } : r
  }, [host, sessionKey, path, reload])
  const [query, setQuery] = useState("")
  const crumbsRef = useRef<HTMLElement>(null)
  // 进入另一个文件夹：搜索清空；路径太长放不下时，显示最深的那几级
  useEffect(() => {
    setQuery("")
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [path])

  const crumbs = useMemo(() => pathCrumbs(path), [path])
  const parent = parentPath(path)

  const listing = state.status === "ready" ? state.value : undefined
  const shown = useMemo(() => {
    if (!listing) return []
    const q = query.trim().toLowerCase()
    return q ? listing.entries.filter((e) => e.name.toLowerCase().includes(q)) : listing.entries
  }, [listing, query])

  let body: ReactNode
  if (state.status === "loading") {
    body = <Loading />
  } else if (state.status === "error") {
    body = <CenterMessage>{state.error}</CenterMessage>
  } else if (shown.length === 0) {
    body = <p className="px-4 py-6 text-center text-xs text-fg-faint">{state.value.total === 0 ? "文件夹是空的" : "没有匹配的项"}</p>
  } else {
    body = (
      <ul>
        {shown.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              title={e.path}
              onClick={() => (e.isDir ? onOpenDir(e.path) : onOpenFile({ path: e.path, name: e.name }))}
              className="flex w-full items-center gap-2 border-b border-line-subtle/60 px-3 py-1.5 text-left text-xs transition hover:bg-raised/50 active:bg-raised"
            >
              {e.isDir ? <Folder size={14} className="shrink-0 text-accent" /> : <File size={14} className="shrink-0 text-fg-faint" />}
              <span className={`min-w-0 flex-1 truncate ${e.isDir ? "text-fg" : "text-fg-2"}`}>{e.name}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">{e.isDir ? "" : formatBytes(e.size)}</span>
              <span className="hidden w-32 shrink-0 whitespace-nowrap tabular-nums text-fg-muted sm:block">{formatTime(e.mtimeMs)}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <BarButton title="上一级" disabled={!parent} onClick={() => parent && onOpenDir(parent)}><ArrowUp size={14} /></BarButton>
        <nav ref={crumbsRef} aria-label="当前位置" className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight size={12} className="text-fg-faint" />}
              {i === crumbs.length - 1
                ? <span className="px-1 text-fg">{c.name}</span>
                : <button type="button" onClick={() => onOpenDir(c.path)} className="rounded px-1 transition hover:bg-raised hover:text-fg-2">{c.name}</button>}
            </span>
          ))}
        </nav>
        {actions}
      </ViewerBar>
      <ViewerBar>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称"
          spellCheck={false}
          className="h-6 w-40 rounded border border-line-subtle bg-surface px-2 text-xs text-fg-soft outline-none placeholder:text-fg-faint focus:border-blue-500"
        />
        {listing && <span className="ml-auto">{listing.total.toLocaleString()} 项</span>}
      </ViewerBar>
      {listing && listing.total > listing.entries.length && (
        <ViewerNotice>文件夹里有 {listing.total.toLocaleString()} 项，只列出了前 {listing.entries.length.toLocaleString()} 项。</ViewerNotice>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  )
}
