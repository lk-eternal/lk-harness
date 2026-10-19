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
    return <div className={`flex items-center justify-center gap-1 rounded bg-gray-800 text-xs text-gray-500 ${className}`} title={path}><ImageOff size={14} />图片不可用</div>
  }
  if (!url) {
    return <div className={`flex items-center justify-center rounded bg-gray-800 ${className}`}><Loader2 size={14} className="animate-spin text-gray-500" /></div>
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
    <div className="rounded-lg border border-gray-700 bg-gray-900/60 p-3">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-200">{item.text}</p>
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
                  ? "border-blue-500 bg-blue-600/20 text-blue-200"
                  : locked
                    ? "border-gray-800 text-gray-600"
                    : "border-gray-700 text-gray-300 hover:border-blue-500 hover:bg-gray-800"
              }`}
            >
              <span className="w-4 shrink-0 text-xs tabular-nums text-gray-500">{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{o}</span>
              {picked && <Check size={14} className="shrink-0" />}
            </button>
          )
        })}
      </div>
      {item.closedNote && !item.answered && <p className="mt-2 text-xs text-gray-500">{item.closedNote}</p>}
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
    <div className="rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2">
      <div className="flex items-center gap-3">
        <FileText size={20} className="shrink-0 text-blue-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-gray-200" title={item.name}>{item.name}</p>
          <p className="truncate text-[11px] text-gray-600" title={item.path}>{item.path}</p>
        </div>
        <button type="button" onClick={() => void run(() => window.electronAPI.appChatOpenFile(item.path))} className="shrink-0 rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-300">打开</button>
        <button type="button" onClick={() => void run(() => window.electronAPI.appChatShowInFolder(item.path))} className="flex shrink-0 items-center gap-1 rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-300"><FolderOpen size={12} />所在位置</button>
      </div>
      {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
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
    <div className="max-w-[90%] self-center rounded-lg bg-gray-800/60 px-3.5 py-2 text-center text-xs text-gray-400">
      {item.text && <p className="whitespace-pre-wrap leading-relaxed">{item.text}</p>}
      {groups.map((g) => (
        <div key={g.section} className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
          {g.section && <span className="text-gray-600">{g.section}</span>}
          {g.buttons.map((b) => (
            <button key={b.cmd} type="button" onClick={() => onCommand(b.cmd)} className="rounded-md border border-gray-700 px-2 py-0.5 text-gray-300 transition hover:border-blue-500 hover:text-blue-300">{b.label}</button>
          ))}
        </div>
      ))}
    </div>
  )
}
