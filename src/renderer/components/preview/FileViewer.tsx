import { useEffect, useState } from "react"
import { FileQuestion, FolderOpen, Loader2 } from "lucide-react"
import { canOpenWithDefaultApp, type PreviewKind } from "../../../shared/preview-kinds"
import { formatBytes } from "../../../shared/preview-text"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import { MediaView, PdfView, ImageView } from "./MediaViewers"
import { CodeView, CsvView, HtmlView, MarkdownView } from "./TextViewers"
import { CenterMessage } from "./preview-ui"
import type { FileTab } from "./preview-tabs"

type Ticket =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; info: PreviewFileInfo }

/** 向主进程要这个文件的预览令牌（同时做权限校验）；tab.reload 变化就重新要 */
export function useFileTicket(tab: FileTab): Ticket {
  const [ticket, setTicket] = useState<Ticket>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    setTicket({ status: "loading" })
    window.electronAPI.previewFileOpen(tab.sessionKey, tab.path).then((r) => {
      if (cancelled) return
      setTicket(r.ok ? { status: "ready", info: r } : { status: "error", error: r.error })
    }).catch((e: unknown) => {
      if (!cancelled) setTicket({ status: "error", error: e instanceof Error ? e.message : String(e) })
    })
    return () => { cancelled = true }
  }, [tab.sessionKey, tab.path, tab.reload])
  return ticket
}

function Unsupported({ tab, info, onAsText }: { tab: FileTab; info: PreviewFileInfo; onAsText: () => void }) {
  const [error, setError] = useState("")
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn()
    setError(r.ok ? "" : (r.error ?? "操作失败"))
  }
  const btn = "inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft"
  return (
    <CenterMessage>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-raised text-fg-3"><FileQuestion size={30} /></div>
      <div>
        <p className="break-all text-sm font-medium text-fg-soft">{info.name}</p>
        <p className="mt-1 text-xs text-fg-faint">{formatBytes(info.size)} · 暂不支持在应用内预览这种文件</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canOpenWithDefaultApp(tab.path) && (
          <button type="button" onClick={() => void run(() => window.electronAPI.appChatOpenFile(tab.path))} className={btn}>用默认程序打开</button>
        )}
        <button type="button" onClick={() => void run(() => window.electronAPI.appChatShowInFolder(tab.path))} className={btn}><FolderOpen size={12} />所在位置</button>
        <button type="button" onClick={onAsText} className={btn} title="把文件内容当文本显示；二进制文件会提示无法显示">按文本打开</button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </CenterMessage>
  )
}

/** 文件标签页的内容：先拿令牌，再按类型选查看器 */
export default function FileViewer({ tab, onAsText }: { tab: FileTab; onAsText: () => void }) {
  const ticket = useFileTicket(tab)
  if (ticket.status === "loading") return <CenterMessage><Loader2 size={18} className="animate-spin" /></CenterMessage>
  if (ticket.status === "error") return <CenterMessage>{ticket.error}</CenterMessage>

  const { info } = ticket
  const kind: PreviewKind = tab.asText && info.kind === "unsupported" ? "text" : info.kind
  // 同一个文件重新打开时 reload 递增：用它当 key，iframe / 媒体元素才会真的重新加载
  const key = `${tab.reload}:${info.mtimeMs}`
  switch (kind) {
    case "text":
    case "code":
      return <CodeView key={key} info={{ ...info, kind }} />
    case "markdown": return <MarkdownView key={key} info={info} />
    case "html": return <HtmlView key={key} info={info} />
    case "csv": return <CsvView key={key} info={info} />
    case "image": return <ImageView key={key} info={info} />
    case "pdf": return <PdfView key={key} info={info} />
    case "audio": return <MediaView key={key} info={info} video={false} />
    case "video": return <MediaView key={key} info={info} video />
    case "unsupported": return <Unsupported tab={tab} info={info} onAsText={onAsText} />
  }
}
