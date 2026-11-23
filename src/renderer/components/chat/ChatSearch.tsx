import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { SEARCH_MAX_HITS, highlightParts, searchTokens, type ChatSearchHit, type ChatSearchKind } from "../../../shared/app-chat-search"
import { formatFindCount, stepMatch } from "../../../shared/preview-find"
import { formatFullTime, formatMessageTime } from "../../time-ago"
import { BarButton } from "../preview/preview-ui"

/** 停止输入多久之后再去搜：连续打字只搜一次 */
const SEARCH_DELAY_MS = 200

const KIND_LABEL: Record<ChatSearchKind, string> = { user: "我", assistant: "AI", text: "AI", question: "问题", notice: "提示" }

interface Found {
  /** 这批命中是用哪个关键词搜出来的：高亮按它切，输入框里的字已经变了也不会错位 */
  query: string
  hits: ChatSearchHit[]
  capped: boolean
}

interface Props {
  sessionKey: string
  /** 加一就重新聚焦输入框并全选（已经开着时再按一次 Ctrl+F） */
  focusTick: number
  /** 定位到这条记录；记录已经不在了、没能定位返回 false */
  onLocate: (id: string) => Promise<boolean>
  onClose: () => void
}

/**
 * 对话里的搜索条：输入关键词，下面列出命中（最新的在前），点一条就定位过去。
 * 定位之后结果列表收起、只留这一条搜索条，上下按钮（和 Enter）在命中之间逐条切换。
 * 搜的是完整历史（在 daemon 里搜），不只是界面上已经加载的那一页。
 */
export default function ChatSearch({ sessionKey, focusTick, onLocate, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState("")
  const [found, setFound] = useState<Found | null>(null)
  const [error, setError] = useState("")
  const [active, setActive] = useState(0)
  const [listOpen, setListOpen] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusTick])

  useEffect(() => {
    if (searchTokens(query).length === 0) {
      setFound(null)
      setError("")
      setListOpen(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.electronAPI.appChatSearch(sessionKey, query).then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setFound(null)
          setError(r.error ?? "搜索失败")
          return
        }
        setError("")
        setFound({ query, hits: r.hits ?? [], capped: !!r.capped })
        setActive(0)
        setListOpen(true)
      })
    }, SEARCH_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sessionKey, query])

  // 方向键换选中项时，让它留在列表的可见范围里
  useEffect(() => {
    if (listOpen) activeRowRef.current?.scrollIntoView({ block: "nearest" })
  }, [active, listOpen])

  const hits = found?.hits ?? []
  const tokens = found ? searchTokens(found.query) : []

  const locate = async (index: number) => {
    const hit = hits[index]
    if (!hit) return
    setActive(index)
    setListOpen(false)
    setError((await onLocate(hit.id)) ? "" : "没能定位到这条记录（可能已被清理），请再试一次")
  }
  /** 往更早（1）或更新（-1）的一条命中走，到头了绕回另一头 */
  const step = (direction: 1 | -1) => void locate(stepMatch(active, hits.length, direction))

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法选字时的回车是「确认拼音」，方向键是选候选词，都不是我们的
    if (e.nativeEvent.isComposing || e.keyCode === 229 || hits.length === 0) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setListOpen(true)
      setActive(stepMatch(active, hits.length, e.key === "ArrowDown" ? 1 : -1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (listOpen) void locate(active)
      else step(e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div
      role="search"
      className="absolute right-4 top-2 z-20 w-[min(28rem,calc(100%-2rem))]"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return
        e.preventDefault()
        onClose()
      }}
    >
      <div
        // 点工具条上的按钮时输入框不失焦：之后 Enter、方向键接着在输入框里生效
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault() }}
        className="flex items-center gap-1 rounded-lg border border-line bg-page py-1 pl-2.5 pr-1 shadow-lg"
      >
        <Search size={13} className="shrink-0 text-fg-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          onClick={() => { if (hits.length > 0) setListOpen(true) }}
          spellCheck={false}
          aria-label="搜索聊天记录"
          placeholder="搜索聊天记录"
          className="h-6 min-w-0 flex-1 bg-transparent px-1 text-xs text-fg-soft outline-none placeholder:text-fg-faint"
        />
        <span aria-live="polite" className={`min-w-[3.75rem] shrink-0 text-center text-[11px] tabular-nums ${found && hits.length === 0 ? "text-danger" : "text-fg-muted"}`}>
          {found ? formatFindCount(active, hits.length, found.capped) : ""}
        </span>
        <BarButton title="更早的一条（Enter）" disabled={hits.length === 0} onClick={() => step(1)}><ChevronUp size={15} /></BarButton>
        <BarButton title="更新的一条（Shift+Enter）" disabled={hits.length === 0} onClick={() => step(-1)}><ChevronDown size={15} /></BarButton>
        <BarButton title="关闭（Esc）" onClick={onClose}><X size={14} /></BarButton>
      </div>
      {error && <p className="mt-1 rounded-lg border border-danger-line bg-page px-2.5 py-1.5 text-xs text-danger shadow-lg">{error}</p>}
      {listOpen && hits.length > 0 && (
        <div className="mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-page py-1 shadow-lg">
          {hits.map((hit, i) => (
            <button
              key={hit.id}
              ref={i === active ? activeRowRef : undefined}
              type="button"
              // 点结果时输入框不失焦，定位之后 Enter、方向键接着能用
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void locate(i)}
              className={`flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition ${i === active ? "bg-raised" : "hover:bg-raised/60"}`}
            >
              <span className="mt-px w-9 shrink-0 rounded bg-strong/40 py-px text-center text-[10px] text-fg-3">{KIND_LABEL[hit.kind]}</span>
              <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-fg-3">
                {highlightParts(hit.snippet, tokens).map((part, j) => (
                  part.hit ? <mark key={j} className="rounded-sm bg-warning/40 text-fg">{part.text}</mark> : <span key={j}>{part.text}</span>
                ))}
              </span>
              <span className="mt-px shrink-0 text-[11px] text-fg-faint" title={formatFullTime(hit.ts)}>{formatMessageTime(hit.ts)}</span>
            </button>
          ))}
          {found?.capped && <p className="px-3 py-1.5 text-[11px] text-fg-faint">只显示最新的 {SEARCH_MAX_HITS} 条，关键词写具体些可以缩小范围</p>}
        </div>
      )}
    </div>
  )
}
