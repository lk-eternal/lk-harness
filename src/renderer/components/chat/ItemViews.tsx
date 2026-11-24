import { useEffect, useState } from "react"
import { Check, Copy, Download, FileText, FolderOpen, FolderSearch, ImageOff, Loader2 } from "lucide-react"
import type { AppChatFileItem, AppChatNoticeItem, AppChatQuestionItem, AppChatUserItem } from "../../../shared/app-chat-types"
import { joinChoices, splitChoices, toggleChoice } from "../../../shared/question-multi"
import { formatFullTime, formatMessageTime } from "../../time-ago"
import { canOpenWithDefaultApp, isPreviewable, parentPath, previewTypeOf } from "../../../shared/preview-kinds"
import { imageFailureView } from "../../../shared/app-chat-image"
import { usePreview } from "../preview/PreviewContext"
import { ImageLightbox, LIGHTBOX_ICON_SIZE, LIGHTBOX_TOOL_BUTTON } from "./ImageLightbox"
import Markdown, { CopyButton } from "./Markdown"

// ── 本地图片：经主进程读成 data URL（渲染层不直接访问文件系统），带小缓存 ──

const IMAGE_CACHE_MAX = 24
const imageCache = new Map<string, string>()

function useLocalImage(path: string): { url?: string; failed: boolean; error?: string } {
  const [state, setState] = useState<{ url?: string; failed: boolean; error?: string }>(() => ({ url: imageCache.get(path), failed: false }))
  useEffect(() => {
    const hit = imageCache.get(path)
    if (hit) { setState({ url: hit, failed: false }); return }
    let cancelled = false
    setState({ failed: false })
    void window.electronAPI.appChatReadImage(path).then((r) => {
      if (cancelled) return
      if (!r.ok) { setState({ failed: true, error: r.error }); return }
      if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value as string)
      imageCache.set(path, r.dataUrl)
      setState({ url: r.dataUrl, failed: false })
    })
    return () => { cancelled = true }
  }, [path])
  return state
}

/**
 * 复制到系统剪贴板 / 另存为；悬浮在图片上和放大查看器里共用。
 * large：放在放大查看器里，按钮和查看器自己的缩放、关闭按钮同样大；否则是缩略图上悬浮的小按钮
 */
export function ImageActions({ path, large }: { path: string; large?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const buttonClass = large ? LIGHTBOX_TOOL_BUTTON : "rounded bg-black/70 p-1 text-white ring-1 ring-white/40 transition hover:bg-black/90"
  const iconSize = large ? LIGHTBOX_ICON_SIZE : 12

  const copy = async () => {
    const r = await window.electronAPI.appChatCopyImage(path)
    setError(r.ok ? "" : (r.error ?? "复制失败"))
    if (!r.ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const save = async () => {
    const r = await window.electronAPI.appChatSaveImageAs(path)
    setError(r.ok ? "" : (r.error ?? "保存失败"))
  }

  return (
    <div className="flex flex-col items-end gap-1" onClick={(e) => e.stopPropagation()}>
      <div className={`flex ${large ? "gap-2" : "gap-1"}`}>
        <button type="button" onClick={() => void copy()} title="复制图片" className={buttonClass}>{copied ? <Check size={iconSize} /> : <Copy size={iconSize} />}</button>
        <button type="button" onClick={() => void save()} title="另存为" className={buttonClass}><Download size={iconSize} /></button>
      </div>
      {error && <span className="max-w-full break-all rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{error}</span>}
    </div>
  )
}

/** 缩略图：点击放大，悬浮出现复制/另存为；加载失败/文件已被清理时给占位，不报错 */
export function LocalImage({ path, className }: { path: string; className: string }) {
  const { url, failed, error } = useLocalImage(path)
  const [zoom, setZoom] = useState(false)
  if (failed) {
    const view = imageFailureView(error, path)
    return <div className={`flex items-center justify-center gap-1 rounded bg-raised text-xs text-fg-muted ${className}`} title={view.hint}><ImageOff size={14} />{view.label}</div>
  }
  if (!url) {
    return <div className={`flex items-center justify-center rounded bg-raised ${className}`}><Loader2 size={14} className="animate-spin text-fg-muted" /></div>
  }
  return (
    <>
      <div className="group/img relative self-start">
        <img src={url} alt="" onClick={() => setZoom(true)} className={`cursor-zoom-in rounded object-cover ${className}`} />
        <div className="absolute inset-x-1.5 top-1.5 hidden justify-end group-hover/img:flex"><ImageActions path={path} /></div>
      </div>
      {zoom && <ImageLightbox src={url} onClose={() => setZoom(false)} actions={<ImageActions path={path} large />} />}
    </>
  )
}

// ── 各类条目 ──

/** 消息时间：显示简短形式，悬停看到精确到秒的完整时间 */
export function MessageTime({ ts }: { ts: number }) {
  return <span title={formatFullTime(ts)}>{formatMessageTime(ts)}</span>
}

export function UserBubble({ item }: { item: AppChatUserItem }) {
  return (
    <div data-user-item={item.id} className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
      {item.images && item.images.length > 0 && (
        <div data-user-flash className="flex flex-wrap justify-end gap-1.5 rounded">
          {item.images.map((p) => <LocalImage key={p} path={p} className="h-24 w-24" />)}
        </div>
      )}
      {item.text && <div data-user-flash className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-tr-sm bg-raised px-3.5 py-2 text-sm leading-relaxed text-fg">{item.text}</div>}
      <div className="flex items-center gap-2 text-[11px] text-fg-faint">
        <MessageTime ts={item.ts} />
        {item.text && <CopyButton text={item.text} />}
      </div>
    </div>
  )
}

/** 已选、但答案还在等：AI 这一轮没说完，或这一轮的问题还有没选的 */
const WAITING_ANSWER_HINT = "已选择，等 AI 说完、问题都选完后一起提交；也可以直接发消息说明"

/**
 * 多选题：先勾选（只在本地记着草稿），点「提交」才作答。答案是勾选项按题目顺序连成的一条，
 * 和单选一样走 onAnswer；答案还没交给 Agent 时（waiting：等 AI 说完、或同一轮还有别的问题没选完），已提交的答案可以改勾后重新提交。
 */
function MultiQuestionCard({ item, onAnswer, waiting, locked }: {
  item: AppChatQuestionItem
  onAnswer: (questionId: string, option: string) => void
  waiting: boolean
  locked: boolean
}) {
  const [draft, setDraft] = useState<string[]>(() => splitChoices(item.answered, item.options))
  // 提交结果（含另一端改的）变了就跟着变；没提交过时用户在勾的草稿不被打断
  useEffect(() => { setDraft(splitChoices(item.answered, item.options)) }, [item.answered])
  const shown = locked ? splitChoices(item.answered, item.options) : draft
  const answer = joinChoices(item.options, draft)
  const dirty = answer !== (item.answered ?? "")
  return (
    <div className="rounded-lg border border-line bg-surface/60 p-3">
      <Markdown text={item.text} />
      <div className="mt-3 flex flex-col gap-1.5">
        {item.options.map((o, i) => {
          const picked = shown.includes(o)
          return (
            <button
              key={`${i}-${o}`}
              type="button"
              role="checkbox"
              aria-checked={picked}
              disabled={locked}
              onClick={() => setDraft((d) => toggleChoice(item.options, d, o))}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition ${
                picked
                  ? "border-focus bg-primary/15 text-accent-bright"
                  : locked
                    ? "border-line-subtle text-fg-faint"
                    : "border-line text-fg-2 hover:border-focus hover:bg-raised"
              }`}
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${picked ? "border-primary bg-primary text-on-primary" : "border-line"}`}>
                {picked && <Check size={12} />}
              </span>
              <span className="min-w-0 flex-1 break-words">{o}</span>
            </button>
          )
        })}
      </div>
      {!locked && (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={!answer || !dirty}
            onClick={() => onAnswer(item.messageId, answer)}
            className="rounded-md bg-primary px-3 py-1 text-sm text-on-primary transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {waiting ? "更新选择" : "提交"}{draft.length > 0 ? `（${draft.length}）` : ""}
          </button>
          <span className="text-xs text-fg-muted">
            {waiting ? WAITING_ANSWER_HINT : "可多选，选好后点提交"}
          </span>
        </div>
      )}
      {item.closedNote && !item.answered && <p className="mt-2 text-xs text-fg-muted">{item.closedNote}</p>}
    </div>
  )
}

export function QuestionCard({ item, onAnswer }: { item: AppChatQuestionItem; onAnswer: (questionId: string, option: string) => void }) {
  // 选了还不会交给 Agent（要等 AI 这一轮说完、且这一轮的问题都选完才一起提交）：这期间可以改选，交出去或被关闭之后才锁定
  const waiting = !!item.answered && item.held === true && !item.closedNote
  const locked = (!!item.answered && !waiting) || !!item.closedNote
  if (item.multi) return <MultiQuestionCard item={item} onAnswer={onAnswer} waiting={waiting} locked={locked} />
  return (
    <div className="rounded-lg border border-line bg-surface/60 p-3">
      <Markdown text={item.text} />
      <div className="mt-3 flex flex-col gap-1.5">
        {item.options.map((o, i) => {
          const picked = item.answered === o
          return (
            <button
              key={`${i}-${o}`}
              type="button"
              disabled={locked}
              onClick={() => { if (!picked) onAnswer(item.messageId, o) }}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm transition ${
                picked
                  ? "border-focus bg-primary/15 text-accent-bright"
                  : locked
                    ? "border-line-subtle text-fg-faint"
                    : "border-line text-fg-2 hover:border-focus hover:bg-raised"
              }`}
            >
              <span className="w-4 shrink-0 text-xs tabular-nums text-fg-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{o}</span>
              {picked && <Check size={14} className="shrink-0" />}
            </button>
          )
        })}
      </div>
      {waiting && <p className="mt-2 text-xs text-fg-muted">{WAITING_ANSWER_HINT}</p>}
      {item.closedNote && !item.answered && <p className="mt-2 text-xs text-fg-muted">{item.closedNote}</p>}
    </div>
  )
}

export function FileCard({ item }: { item: AppChatFileItem }) {
  const [error, setError] = useState("")
  const preview = usePreview()
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    const r = await fn()
    setError(r.ok ? "" : (r.error ?? "操作失败"))
  }
  const canPreview = preview.available && isPreviewable(previewTypeOf(item.path).kind)
  const dir = parentPath(item.path)
  return (
    <div className="rounded-lg border border-line bg-surface/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FileText size={20} className="shrink-0 text-accent" />
        <div className="min-w-[9rem] flex-1">
          <p className="truncate text-sm text-fg-soft" title={item.name}>{item.name}</p>
          <p className="truncate text-[11px] text-fg-faint" title={item.path}>{item.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canPreview && (
            <button type="button" onClick={() => preview.openFile({ path: item.path, name: item.name })} className="shrink-0 rounded border border-focus/60 px-2.5 py-1 text-xs text-accent-soft transition hover:bg-primary/10">预览</button>
          )}
          {(!canPreview || canOpenWithDefaultApp(item.path)) && (
            <button type="button" onClick={() => void run(() => window.electronAPI.appChatOpenFile(item.path))} className="shrink-0 rounded border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-focus hover:text-accent-soft">打开</button>
          )}
          {preview.available && dir && (
            <button type="button" onClick={() => preview.openDir({ path: dir })} className="flex shrink-0 items-center gap-1 rounded border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-focus hover:text-accent-soft"><FolderSearch size={12} />预览所在文件夹</button>
          )}
          <button type="button" onClick={() => void run(() => window.electronAPI.appChatShowInFolder(item.path))} className="flex shrink-0 items-center gap-1 rounded border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-focus hover:text-accent-soft"><FolderOpen size={12} />所在位置</button>
        </div>
      </div>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  )
}

/**
 * 指令回执 / 系统提示：居中提示条；带 cmd 的按钮等同于发送该指令，按 section 分组。
 * 有 detail 时标题下面给「展开全文」；reveal 变了（搜索刚定位到这条）就自动展开，免得命中藏在折叠里。
 */
export function NoticePill({ item, onCommand, reveal }: { item: AppChatNoticeItem; onCommand: (cmd: string) => void; reveal?: number }) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (reveal !== undefined) setOpen(true) }, [reveal])
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
      {item.detail && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 block text-fg-faint transition hover:text-fg-2">{open ? "收起" : "展开全文"}</button>
          {open && <p className="mt-2 whitespace-pre-wrap break-words border-t border-line-subtle pt-2 leading-relaxed">{item.detail}</p>}
        </>
      )}
      {groups.map((g) => (
        <div key={g.section} className="mt-2 flex flex-wrap items-center justify-start gap-1.5">
          {g.section && <span className="text-fg-faint">{g.section}</span>}
          {g.buttons.map((b) => (
            <button key={b.cmd} type="button" onClick={() => onCommand(b.cmd)} className="rounded-md border border-line px-2 py-0.5 text-fg-2 transition hover:border-focus hover:text-accent-soft">{b.label}</button>
          ))}
        </div>
      ))}
    </div>
  )
}
