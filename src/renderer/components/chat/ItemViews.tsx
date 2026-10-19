import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Check, FileText, FolderOpen, ImageOff, Loader2 } from "lucide-react"
import type { AppChatFileItem, AppChatNoticeItem, AppChatQuestionItem, AppChatUserItem } from "../../../shared/app-chat-types"

// ── 本地图片：经主进程读成 data URL（渲染层不直接访问文件系统），带小缓存 ──

const IMAGE_CACHE_MAX = 24
const imageCache = new Map<string, string>()

function useLocalImage(path: string): { url?: string; failed: boolean } {
  const [state, setState] = useState<{ url?: string; failed: boolean }>(() => ({ url: imageCache.get(path), failed: false }))
  useEffect(() => {
    const hit = imageCache.get(path)
    if (hit) { setState({ url: hit, failed: false }); return }
    let cancelled = false
    setState({ failed: false })
    void window.electronAPI.appChatReadImage(path).then((r) => {
      if (cancelled) return
      if (!r.ok) { setState({ failed: true }); return }
      if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value as string)
      imageCache.set(path, r.dataUrl)
      setState({ url: r.dataUrl, failed: false })
    })
    return () => { cancelled = true }
  }, [path])
  return state
}

function ImageViewer({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-8">
      <img src={url} alt="" className="max-h-full max-w-full rounded object-contain" />
    </div>,
    document.body,
  )
}

/** 缩略图：点击放大；加载失败/文件已被清理时给占位，不报错 */
export function LocalImage({ path, className }: { path: string; className: string }) {
  const { url, failed } = useLocalImage(path)
  const [zoom, setZoom] = useState(false)
  if (failed) {
    return <div className={`flex items-center justify-center gap-1 rounded bg-raised text-xs text-fg-muted ${className}`} title={path}><ImageOff size={14} />图片不可用</div>
  }
  if (!url) {
    return <div className={`flex items-center justify-center rounded bg-raised ${className}`}><Loader2 size={14} className="animate-spin text-fg-muted" /></div>
  }
  return (
    <>
      <img src={url} alt="" onClick={() => setZoom(true)} className={`cursor-zoom-in rounded object-cover ${className}`} />
      {zoom && <ImageViewer url={url} onClose={() => setZoom(false)} />}
    </>
  )
}

// ── 各类条目 ──

export function UserBubble({ item }: { item: AppChatUserItem }) {
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
      {item.images && item.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.images.map((p) => <LocalImage key={p} path={p} className="h-24 w-24" />)}
        </div>
      )}
      {item.text && <div className="whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-blue-600 px-3.5 py-2 text-sm leading-relaxed text-white">{item.text}</div>}
    </div>
  )
}

export function QuestionCard({ item, onAnswer }: { item: AppChatQuestionItem; onAnswer: (questionId: string, option: string) => void }) {
  const locked = !!item.answered || !!item.closedNote
  return (
    <div className="rounded-lg border border-line bg-surface/60 p-3">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-soft">{item.text}</p>
      <div className="mt-3 flex flex-col gap-1.5">
        {item.options.map((o, i) => {
          const picked = item.answered === o
          return (
            <button
              key={`${i}-${o}`}
              type="button"
              disabled={locked}
              onClick={() => onAnswer(item.messageId, o)}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition ${
                picked
                  ? "border-blue-500 bg-blue-600/20 text-accent-bright"
                  : locked
                    ? "border-line-subtle text-fg-faint"
                    : "border-line text-fg-2 hover:border-blue-500 hover:bg-raised"
              }`}
            >
              <span className="w-4 shrink-0 text-xs tabular-nums text-fg-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{o}</span>
              {picked && <Check size={14} className="shrink-0" />}
            </button>
          )
        })}
      </div>
      {item.closedNote && !item.answered && <p className="mt-2 text-xs text-fg-muted">{item.closedNote}</p>}
    </div>
  )
}

export function FileCard({ item }: { item: AppChatFileItem }) {
  const [error, setError] = useState("")
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn()
    setError(r.ok ? "" : (r.error ?? "操作失败"))
  }
  return (
    <div className="rounded-lg border border-line bg-surface/60 px-3 py-2">
      <div className="flex items-center gap-3">
        <FileText size={20} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg-soft" title={item.name}>{item.name}</p>
          <p className="truncate text-[11px] text-fg-faint" title={item.path}>{item.path}</p>
        </div>
        <button type="button" onClick={() => void run(() => window.electronAPI.appChatOpenFile(item.path))} className="shrink-0 rounded border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft">打开</button>
        <button type="button" onClick={() => void run(() => window.electronAPI.appChatShowInFolder(item.path))} className="flex shrink-0 items-center gap-1 rounded border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft"><FolderOpen size={12} />所在位置</button>
      </div>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  )
}

/** 指令回执：居中提示条；带 cmd 的按钮等同于发送该指令，按 section 分组 */
export function NoticePill({ item, onCommand }: { item: AppChatNoticeItem; onCommand: (cmd: string) => void }) {
  const groups: { section: string; buttons: NonNullable<AppChatNoticeItem["buttons"]> }[] = []
  for (const b of item.buttons ?? []) {
    const section = b.section ?? ""
    const g = groups.find((x) => x.section === section)
    if (g) g.buttons.push(b)
    else groups.push({ section, buttons: [b] })
  }
  return (
    <div className="max-w-[90%] self-center rounded-lg bg-raised/60 px-3.5 py-2 text-left text-xs text-fg-3">
      {item.text && <p className="whitespace-pre-wrap leading-relaxed">{item.text}</p>}
      {groups.map((g) => (
        <div key={g.section} className="mt-2 flex flex-wrap items-center justify-start gap-1.5">
          {g.section && <span className="text-fg-faint">{g.section}</span>}
          {g.buttons.map((b) => (
            <button key={b.cmd} type="button" onClick={() => onCommand(b.cmd)} className="rounded-md border border-line px-2 py-0.5 text-fg-2 transition hover:border-blue-500 hover:text-accent-soft">{b.label}</button>
          ))}
        </div>
      ))}
    </div>
  )
}
