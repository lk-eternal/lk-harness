import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowDown, Download, FileText, ImageOff, Loader2, Sparkles, Terminal, X } from "lucide-react"
import type { AppChatFileItem, AppChatItem, AppChatUserItem } from "../shared/app-chat-types"
import AssistantTurn from "../renderer/components/chat/AssistantTurn"
import { MessageTime, NoticePill, QuestionCard } from "../renderer/components/chat/ItemViews"
import { CopyButton } from "../renderer/components/chat/Markdown"
import { buildMobileFileDownloadUrl, fetchMobileImageDataUrl } from "./api"

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
      {zoom &&
        createPortal(
          <div
            onClick={() => setZoom(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          >
            <button
              type="button"
              onClick={() => setZoom(false)}
              className="absolute right-4 top-6 rounded-full bg-white/15 p-2 text-white"
            >
              <X size={18} />
            </button>
            <img src={url} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          </div>,
          document.body,
        )}
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
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-blue-600 px-3.5 py-2 text-[14px] leading-relaxed text-white shadow-sm">
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
  const downloadUrl = buildMobileFileDownloadUrl(baseUrl, token, item.path, sessionKey)
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
        <a
          href={downloadUrl}
          download={item.name}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition active:scale-95"
        >
          <Download size={13} />下载
        </a>
      </div>
    </div>
  )
}

export default function MobileItemList({
  items,
  loading,
  busy,
  workspaceName,
  sessionKey,
  baseUrl,
  token,
  onAnswer,
  onCommand,
}: {
  items: AppChatItem[]
  loading: boolean
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
                case "question":
                  return <QuestionCard key={item.id} item={item} onAnswer={onAnswer} />
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
