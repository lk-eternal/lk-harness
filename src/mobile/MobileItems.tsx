import { useEffect, useRef, useState, type ComponentProps } from "react"
import { ArrowDown, Download, Eye, FileText, ImageOff, Loader2, Sparkles, Terminal } from "lucide-react"
import type { AppChatFileItem, AppChatItem, AppChatUserItem } from "../shared/app-chat-types"
import { previewTypeOf } from "../shared/preview-kinds"
import AssistantTurn from "../renderer/components/chat/AssistantTurn"
import { ImageLightbox } from "../renderer/components/chat/ImageLightbox"
import { useKeepScrollOnPrepend } from "../renderer/hooks/useKeepScrollOnPrepend"
import { MessageTime, NoticePill, QuestionCard } from "../renderer/components/chat/ItemViews"
import Markdown, { CopyButton } from "../renderer/components/chat/Markdown"
import { usePreview } from "../renderer/components/preview/PreviewContext"
import { fetchMobileImageDataUrl, requestMobileFileDownloadUrl } from "./api"
import { useBackToClose } from "./back-stack"
import { MobilePreviewProvider } from "./MobilePreview"
import { useFileDownload } from "./use-file-download"

function MobileRemoteImage({
  baseUrl,
  token,
  sessionKey,
  path,
  className = "h-24 w-24",
}: {
  baseUrl: string
  token: string
  sessionKey: string
  path: string
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)
  useBackToClose(zoom, () => setZoom(false))

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void fetchMobileImageDataUrl(baseUrl, token, path, sessionKey).then((dataUrl) => {
      if (cancelled) return
      if (!dataUrl) {
        setFailed(true)
        return
      }
      setUrl(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [baseUrl, token, path, sessionKey])

  if (failed) {
    return (
      <div className={`flex items-center justify-center gap-1 rounded-lg bg-raised text-xs text-fg-muted ${className}`}>
        <ImageOff size={14} />图片不可用
      </div>
    )
  }
  if (!url) {
    return (
      <div className={`flex items-center justify-center rounded-lg bg-raised ${className}`}>
        <Loader2 size={14} className="animate-spin text-fg-muted" />
      </div>
    )
  }

  return (
    <>
      <img
        src={url}
        alt=""
        onClick={() => setZoom(true)}
        className={`cursor-zoom-in rounded-xl border border-line-subtle object-cover ${className}`}
      />
      {zoom && <ImageLightbox src={url} onClose={() => setZoom(false)} />}
    </>
  )
}

function MobileUserBubble({
  item,
  baseUrl,
  token,
  sessionKey,
}: {
  item: AppChatUserItem
  baseUrl: string
  token: string
  sessionKey: string
}) {
  return (
    <div className="flex max-w-[86%] flex-col items-end gap-1.5 self-end">
      {item.images && item.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {item.images.map((p) => (
            <MobileRemoteImage
              key={p}
              baseUrl={baseUrl}
              token={token}
              sessionKey={sessionKey}
              path={p}
              className="h-24 w-24"
            />
          ))}
        </div>
      )}
      {item.text && (
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl rounded-tr-sm bg-blue-600 px-3.5 py-2 text-[14px] leading-relaxed text-white shadow-sm">
          {item.text}
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-fg-faint">
        <MessageTime ts={item.ts} />
        {item.text && <CopyButton text={item.text} />}
      </div>
    </div>
  )
}

function MobileFileCard({
  item,
  baseUrl,
  token,
  sessionKey,
}: {
  item: AppChatFileItem
  baseUrl: string
  token: string
  sessionKey: string
}) {
  const { downloading, error, start } = useFileDownload()
  const preview = usePreview()
  // 手机上 PDF 显示不了（Android WebView 不能内嵌 PDF），不给预览按钮，直接下载
  const kind = previewTypeOf(item.name).kind
  const canPreview = preview.available && kind !== "unsupported" && kind !== "pdf"

  return (
    <div className="rounded-xl border border-line bg-surface/70 px-3.5 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600/15 text-accent">
          <FileText size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg-soft" title={item.name}>{item.name}</p>
          <p className="truncate text-[11px] text-fg-faint" title={item.path}>{item.path}</p>
        </div>
        {canPreview && (
          <button
            type="button"
            onClick={() => preview.openFile({ path: item.path, name: item.name })}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition active:scale-95"
          >
            <Eye size={13} />预览
          </button>
        )}
        <button
          type="button"
          disabled={downloading}
          onClick={() => void start(() => requestMobileFileDownloadUrl(baseUrl, token, item.path, sessionKey), item.name)}
          className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition active:scale-95 disabled:opacity-60 ${
            canPreview ? "border border-line text-fg-2" : "bg-blue-600 text-white"
          }`}
        >
          {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}下载
        </button>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-amber-400">{error}</p>}
    </div>
  )
}

/** 消息列表外面套一层文件预览：消息里的文件卡、文字里的路径都经它打开全屏预览页 */
export default function MobileItemList(props: ComponentProps<typeof MobileItemListBody>) {
  return (
    <MobilePreviewProvider baseUrl={props.baseUrl} token={props.token} sessionKey={props.sessionKey}>
      <MobileItemListBody {...props} />
    </MobilePreviewProvider>
  )
}

function MobileItemListBody({
  items,
  loading,
  busy,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  workspaceName,
  sessionKey,
  baseUrl,
  token,
  onAnswer,
  onCommand,
}: {
  items: AppChatItem[]
  loading: boolean
  /** 已加载的最早一条之前还有更早的记录：列表顶部给「加载更早的消息」 */
  hasMore: boolean
  loadingEarlier: boolean
  onLoadEarlier: () => void
  busy: boolean
  workspaceName?: string
  sessionKey: string
  baseUrl: string
  token: string
  onAnswer: (questionId: string, option: string) => void
  onCommand: (cmd: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)

  const scrollToBottom = (smooth = false) => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    stickRef.current = true
    setShowScrollBottom(false)
  }

  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = dist < 72
    stickRef.current = nearBottom
    setShowScrollBottom(!nearBottom && items.length > 0)
  }

  // 往前加载一页是把记录插在顶部，要保住用户正在看的位置
  const keepScroll = useKeepScrollOnPrepend(containerRef, items)
  const loadEarlier = () => {
    keepScroll()
    onLoadEarlier()
  }

  useEffect(() => {
    if (stickRef.current) {
      scrollToBottom(false)
    }
  }, [items])

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-fg-muted">
        <Loader2 size={15} className="animate-spin text-accent" />加载对话记录…
      </div>
    )
  }

  const hasLiveTurn = items.some((it) => it.kind === "assistant" && !it.finished)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3.5 py-3 select-text"
      >
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface text-accent shadow-sm">
              <Sparkles size={22} />
            </div>
            <p className="text-sm font-medium text-fg-2">
              {workspaceName ? `在 ${workspaceName} 中开始对话` : "开始新对话"}
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              与电脑端实时同步 · 支持代码读写、工具调用与图片上传
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["查看 git status 与最近提交", "运行项目类型检查", "/help"].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onCommand(q)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg-3 transition active:scale-95"
                >
                  <Terminal size={12} className="text-accent" />
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-2">
            {hasMore && (
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingEarlier}
                className="flex items-center gap-1.5 self-center rounded-full border border-line-subtle px-3 py-1.5 text-xs text-fg-muted transition active:bg-raised disabled:opacity-60"
              >
                {loadingEarlier && <Loader2 size={12} className="animate-spin" />}
                {loadingEarlier ? "加载中…" : "加载更早的消息"}
              </button>
            )}
            {items.map((item) => {
              switch (item.kind) {
                case "user":
                  return (
                    <MobileUserBubble
                      key={item.id}
                      item={item}
                      baseUrl={baseUrl}
                      token={token}
                      sessionKey={sessionKey}
                    />
                  )
                case "assistant":
                  return <AssistantTurn key={item.id} item={item} />
                case "text":
                  return <Markdown key={item.id} text={item.text} />
                case "question":
                  return <QuestionCard key={item.id} item={item} onAnswer={onAnswer} />
                case "image":
                  return (
                    <MobileRemoteImage
                      key={item.id}
                      baseUrl={baseUrl}
                      token={token}
                      sessionKey={sessionKey}
                      path={item.path}
                      className="max-h-72 min-h-24 min-w-24 max-w-full self-start"
                    />
                  )
                case "file":
                  return (
                    <MobileFileCard
                      key={item.id}
                      item={item}
                      baseUrl={baseUrl}
                      token={token}
                      sessionKey={sessionKey}
                    />
                  )
                case "notice":
                  return <NoticePill key={item.id} item={item} onCommand={onCommand} />
                default: {
                  // 新增消息类型漏渲染时在这里编译报错，而不是在手机上悄悄丢消息
                  const unhandled: never = item
                  return unhandled
                }
              }
            })}
            {busy && !hasLiveTurn && (
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 size={13} className="animate-spin text-accent" />Agent 正在思考…
              </div>
            )}
          </div>
        )}
      </div>

      {showScrollBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-3 right-4 z-10 inline-flex items-center gap-1 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-xs font-medium text-fg-2 shadow-lg backdrop-blur transition active:scale-95"
        >
          <ArrowDown size={13} className="text-accent" />回到底部
        </button>
      )}
    </div>
  )
}
