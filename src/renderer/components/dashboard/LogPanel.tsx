import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, Clock, Search, X } from "lucide-react"
import { formatLogLineForUi } from "../../../shared/log-format"
import { useStickToBottom } from "../../hooks/useStickToBottom"

const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] (\w+) (.*)$/

/** 与主进程 escapeLogContentSingleLine 对应：展示时把 ⏎ 标记还原为换行 */
function displayLogMessageBody(msg: string): string {
  return msg.replace(/⏎/g, "\n")
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: "text-danger",
  WARN: "text-warning",
  INFO: "text-accent",
  DEBUG: "text-fg-muted",
}

const PROCESS_COLORS: Record<string, string> = {
  Daemon: "text-purple",
  Agent: "text-cyan",
  Electron: "text-orange",
  Scheduler: "text-teal",
}

/** 命中片段高亮渲染（大小写不敏感） */
function renderHighlighted(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let idx: number
  while ((idx = lower.indexOf(q, i)) >= 0) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={idx} className="rounded-sm bg-yellow-500/40 text-warning-bright">{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  if (parts.length === 0) return text
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

const LogLine = memo(function LogLine({ line, highlight = "", resolveLabel }: { line: string; highlight?: string; resolveLabel?: (sk: string) => string | undefined }) {
  const view = formatLogLineForUi(line, resolveLabel)
  const m = LOG_RE.exec(view)
  if (!m) {
    return <div className="whitespace-pre-wrap break-all text-fg-3">{renderHighlighted(displayLogMessageBody(view), highlight)}</div>
  }
  const [, ts, proc, level, msg] = m
  const body = displayLogMessageBody(msg)
  return (
    <div className="whitespace-pre-wrap break-all" title={line.length > 120 ? line : undefined}>
      <span className="text-fg-faint">{renderHighlighted(ts, highlight)}</span>
      {" "}
      <span className={PROCESS_COLORS[proc] ?? "text-fg-3"}>{renderHighlighted(`[${proc}]`, highlight)}</span>
      {" "}
      <span className={LEVEL_COLORS[level] ?? "text-fg-3"}>{renderHighlighted(level, highlight)}</span>
      {" "}
      <span className={level === "ERROR" ? "text-danger-soft" : level === "WARN" ? "text-warning-soft" : "text-fg-2"}>{renderHighlighted(body, highlight)}</span>
    </div>
  )
})

/**
 * 工作台的日志区：Daemon / Agent / Electron / Scheduler 四类进程的日志混在一起。
 * 日志行、搜索词、滚动位置都存在这个组件里，所以工作台切到别的页签时它只是被藏起来、不卸载：
 * 藏着的时候日志照常累积，切回来时搜索词和滚动位置都还在。
 */
export default function LogPanel({
  resolveLabel,
  onError,
}: {
  /** 会话键 → 日志里显示的标签（📦 / 📂 / ⏰ + 名字） */
  resolveLabel: (sessionKey: string) => string | undefined
  onError: (message: string) => void
}) {
  const [logLines, setLogLines] = useState<string[]>([])
  const [logFilter, setLogFilter] = useState("")
  const [logMatchCursor, setLogMatchCursor] = useState(0)
  const [exportingDiag, setExportingDiag] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const logBufRef = useRef<string[]>([])
  const logFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { sentinelRef: logSentinelRef, atBottom: logAtBottom, stickRef: logStickRef, scrollToBottom: scrollLogToBottom } =
    useStickToBottom(logRef, [logLines])

  /** 回到底部后再裁到窗口大小；阅读中只增不裁 */
  useEffect(() => {
    if (!logAtBottom) return
    setLogLines((prev) => (prev.length > 300 ? prev.slice(-300) : prev))
  }, [logAtBottom])

  useEffect(() => {
    window.electronAPI.getLogBuffer().then((buf) => {
      if (buf.length > 0) setLogLines(buf.slice(-300))
    })
    const unsubLog = window.electronAPI.onDaemonLog((line) => {
      // 攒批 250ms 再 setState：聊天时 thinking/工具日志逐行刷屏会打爆渲染
      logBufRef.current.push(line)
      if (logFlushTimer.current) return
      logFlushTimer.current = setTimeout(() => {
        logFlushTimer.current = null
        const batch = logBufRef.current
        logBufRef.current = []
        if (!batch.length) return
        setLogLines((prev) => {
          const next = prev.concat(batch)
          // 置顶浏览历史时也封顶（此前无上限，久聊会堆内存）
          const cap = logStickRef.current ? 300 : 1000
          if (next.length > cap) return next.slice(-cap)
          return next
        })
      }, 250)
    })
    return () => {
      if (logFlushTimer.current) {
        clearTimeout(logFlushTimer.current)
        logFlushTimer.current = null
      }
      unsubLog()
    }
  }, [logStickRef])

  const logQuery = logFilter.trim()
  const logMatchIndexes = useMemo(() => {
    const q = logQuery.toLowerCase()
    if (!q) return [] as number[]
    const out: number[] = []
    for (let i = 0; i < logLines.length; i++) {
      if (logLines[i].toLowerCase().includes(q)) out.push(i)
    }
    return out
  }, [logLines, logQuery])

  useEffect(() => {
    setLogMatchCursor(0)
  }, [logQuery])

  const jumpToLogMatch = (dir: -1 | 1) => {
    if (logMatchIndexes.length === 0) return
    const next = (logMatchCursor + dir + logMatchIndexes.length) % logMatchIndexes.length
    setLogMatchCursor(next)
    const lineIdx = logMatchIndexes[next]
    const el = logRef.current?.querySelector(`[data-log-idx="${lineIdx}"]`)
    if (!el) return
    el.scrollIntoView({ block: "center" })
  }

  const handleExportDiagnostics = useCallback(async () => {
    setExportingDiag(true)
    try {
      const r = await window.electronAPI.exportDiagnostics()
      if (!r.ok) onError(r.error ?? "诊断包导出失败")
    } finally {
      setExportingDiag(false)
    }
  }, [onError])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between gap-3 text-sm text-fg-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Clock size={14} className="shrink-0" />
          <span className="shrink-0">日志</span>
          <div className="relative ml-2 flex max-w-[260px] flex-1 items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-fg-faint" />
            <input
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              placeholder="搜索日志..."
              className="w-full rounded-md border border-line-subtle bg-surface/60 py-1 pl-7 pr-7 text-xs text-fg-2 placeholder-fg-faint outline-none transition focus:border-line-strong"
            />
            {logFilter && (
              <button
                onClick={() => setLogFilter("")}
                className="absolute right-1.5 rounded p-0.5 text-fg-faint transition hover:text-fg-2"
                title="清除搜索"
              >
                <X size={11} />
              </button>
            )}
          </div>
          {logQuery && (
            <>
              <span className="shrink-0 text-[10px] text-fg-faint">
                {logMatchIndexes.length > 0
                  ? `${logMatchCursor + 1}/${logMatchIndexes.length}`
                  : "0 条命中"}
              </span>
              <button
                type="button"
                onClick={() => jumpToLogMatch(-1)}
                disabled={logMatchIndexes.length === 0}
                className="rounded p-0.5 text-fg-muted transition hover:bg-raised hover:text-fg-2 disabled:opacity-40"
                title="上一条命中"
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                onClick={() => jumpToLogMatch(1)}
                disabled={logMatchIndexes.length === 0}
                className="rounded p-0.5 text-fg-muted transition hover:bg-raised hover:text-fg-2 disabled:opacity-40"
                title="下一条命中"
              >
                <ChevronDown size={14} />
              </button>
            </>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => void handleExportDiagnostics()}
            disabled={exportingDiag}
            className="rounded px-2 py-0.5 text-xs text-fg-muted transition hover:bg-raised hover:text-fg-2 disabled:opacity-50"
            title="汇总日志、脱敏配置、会话与队列快照到单个文件，用于远程排障"
          >
            {exportingDiag ? "导出中..." : "导出诊断包"}
          </button>
          {logLines.length > 0 && (
            <button
              onClick={() => { navigator.clipboard.writeText(logLines.join("\n")) }}
              className="rounded px-2 py-0.5 text-xs text-fg-muted transition hover:bg-raised hover:text-fg-2"
              title="复制全部日志"
            >
              复制
            </button>
          )}
          {logLines.length > 0 && (
            <button
              onClick={() => setLogLines([])}
              className="rounded px-2 py-0.5 text-xs text-fg-muted transition hover:bg-raised hover:text-fg-2"
            >
              清空
            </button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={logRef}
          data-log-scroll
          className="h-full overflow-auto overscroll-contain rounded-lg border border-line-subtle bg-surface/50 p-3 font-mono text-xs leading-5"
        >
          {logLines.length > 0
            ? logLines.map((line, i) => (
                <div
                  key={i}
                  data-log-idx={i}
                  className={logMatchIndexes[logMatchCursor] === i ? "rounded bg-yellow-500/10" : undefined}
                >
                  <LogLine
                    line={line}
                    highlight={logQuery}
                    resolveLabel={resolveLabel}
                  />
                </div>
              ))
            : <span className="text-fg-faint">暂无日志</span>}
          <div ref={logSentinelRef} className="h-px shrink-0" aria-hidden />
        </div>
        {!logAtBottom && (
          <button
            onClick={scrollLogToBottom}
            className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-line bg-raised/95 px-2.5 py-1 text-[11px] text-fg-2 shadow-lg transition hover:bg-strong"
            title="恢复自动滚动"
          >
            <ChevronDown size={12} />
            回到底部
          </button>
        )}
      </div>
    </div>
  )
}
