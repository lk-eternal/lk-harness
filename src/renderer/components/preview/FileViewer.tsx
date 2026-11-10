import { useEffect, useState } from "react"
import { FolderOpen } from "lucide-react"
import { canOpenWithDefaultApp, type PreviewKind } from "../../../shared/preview-kinds"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import FileBody from "./FileBody"
import { CenterMessage, Loading, NOTICE_BUTTON, NOTICE_BUTTON_PRIMARY } from "./preview-ui"
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

/** 电脑端能对文件做的事：用默认程序打开、在文件夹里显示；暂不支持的类型还可以强行按文本看 */
function DesktopActions({ tab, kind, onAsText }: { tab: FileTab; kind: PreviewKind; onAsText: () => void }) {
  const [error, setError] = useState("")
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn()
    setError(r.ok ? "" : (r.error ?? "操作失败"))
  }
  const openable = canOpenWithDefaultApp(tab.path)
  // 应用内看不了的办公文档，默认程序是最合适的出路，所以按钮做成主操作
  const primary = openable && kind === "unsupported"
  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {openable && (
          <button
            type="button"
            onClick={() => void run(() => window.electronAPI.appChatOpenFile(tab.path))}
            className={primary ? NOTICE_BUTTON_PRIMARY : NOTICE_BUTTON}
          >用默认程序打开</button>
        )}
        <button type="button" onClick={() => void run(() => window.electronAPI.appChatShowInFolder(tab.path))} className={NOTICE_BUTTON}><FolderOpen size={12} />所在位置</button>
        {kind === "unsupported" && (
          <button type="button" onClick={onAsText} className={NOTICE_BUTTON} title="把文件内容当文本显示；二进制文件会提示无法显示">按文本打开</button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </>
  )
}

/** 文件标签页的内容：先拿令牌，再按类型选查看器 */
export default function FileViewer({ tab, onAsText }: { tab: FileTab; onAsText: () => void }) {
  const ticket = useFileTicket(tab)
  if (ticket.status === "loading") return <Loading />
  if (ticket.status === "error") return <CenterMessage>{ticket.error}</CenterMessage>

  const { info } = ticket
  const kind: PreviewKind = tab.asText && info.kind === "unsupported" ? "text" : info.kind
  // 同一个文件重新打开时 reload 递增：用它当 key，iframe / 媒体元素才会真的重新加载
  const key = `${tab.reload}:${info.mtimeMs}`
  return <FileBody key={key} info={info} kind={kind} line={tab.line} actions={<DesktopActions tab={tab} kind={kind} onAsText={onAsText} />} />
}
