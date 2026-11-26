import { Fragment, useState, type ReactNode } from "react"
import { Brain, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Layers, ListChecks, Loader2, Wrench, XCircle } from "lucide-react"
import type { AppChatAssistantItem, AppChatSegment, AppChatTodo, AppChatTool } from "../../../shared/app-chat-types"
import { buildTurnFooter, type TurnFooterPart } from "../../../shared/turn-footer"
import { MessageTime } from "./ItemViews"
import Markdown, { CopyButton } from "./Markdown"
import { PathText } from "./PathLink"
import { groupSegments, summarizeGroup, type GroupSummary, type ProcessSegment } from "./segment-groups"

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 折叠头：点击切换；未手动切换时由 auto 决定（回合进行中的最新块展开、其余折叠） */
function useAutoOpen(auto: boolean): [boolean, () => void] {
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? auto
  return [open, () => setManual(!open)]
}

function lastIndexOfType(segments: AppChatSegment[], type: AppChatSegment["type"]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].type === type) return i
  }
  return -1
}

/** live：正在生成中（转圈、“思考中…”）；expanded：默认展开 */
function ThinkingBlock({ text, ms, live, expanded }: { text: string; ms?: number; live: boolean; expanded: boolean }) {
  const [open, toggle] = useAutoOpen(expanded)
  return (
    <div>
      <button type="button" onClick={toggle} className="flex items-center gap-1.5 text-xs text-fg-muted transition hover:text-fg-2">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {live ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
        <span>{live ? "思考中…" : `思考${ms != null ? ` ${fmtMs(ms)}` : ""}`}</span>
      </button>
      {open && (
        <p className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap border-l-2 border-line-subtle pl-3 text-xs leading-relaxed text-fg-muted">{text}</p>
      )}
    </div>
  )
}

function ToolIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
  if (status === "error") return <XCircle size={12} className="shrink-0 text-danger" />
  if (status === "interrupted") return <Circle size={12} className="shrink-0 text-fg-faint" />
  return <Check size={12} className="shrink-0 text-success" />
}

function ToolsBlock({ tools, live, expanded }: { tools: AppChatTool[]; live: boolean; expanded: boolean }) {
  const running = live && tools.some((t) => t.status === "running")
  const failed = tools.filter((t) => t.status === "error").length
  const [open, toggle] = useAutoOpen(expanded)
  const names = [...new Set(tools.map((t) => t.name))]
  return (
    <div>
      <button type="button" onClick={toggle} className="flex w-full items-center gap-1.5 text-left text-xs text-fg-muted transition hover:text-fg-2">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {running ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
        <span>工具调用 {tools.length} 项</span>
        {failed > 0 && <span className="text-danger">{failed} 失败</span>}
        {!open && <span className="min-w-0 flex-1 truncate text-fg-faint">{names.slice(0, 4).join(" · ")}{names.length > 4 ? ` +${names.length - 4}` : ""}</span>}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 border-l-2 border-line-subtle pl-3">
          {tools.map((t, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              <ToolIcon status={t.status} />
              <span className="shrink-0 font-mono text-fg-2">{t.name}</span>
              {t.summary && <span className="min-w-0 flex-1 truncate text-fg-muted" title={t.summary}><PathText key={t.status} text={t.summary} /></span>}
              {t.ms != null && <span className="ml-auto shrink-0 tabular-nums text-fg-faint">{fmtMs(t.ms)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 折叠时那一行的后半截：只展示最后一条具体的操作 */
function GroupTail({ summary, live }: { summary: GroupSummary; live: boolean }) {
  const tail = "min-w-0 flex-1 truncate text-fg-faint"
  if (live && summary.endsWithThinking) return <span className={tail}>思考中…</span>
  const tool = summary.lastTool
  if (!tool) return <span className={tail}>思考{summary.lastThinkingMs != null ? ` ${fmtMs(summary.lastThinkingMs)}` : ""}</span>
  // 回合已结束工具却还停在 running：是被中断了，不要一直转圈
  const status = !live && tool.status === "running" ? "interrupted" : tool.status
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <ToolIcon status={status} />
      <span className="shrink-0 font-mono text-fg-3">{tool.name}</span>
      {tool.summary && <span className="min-w-0 truncate text-fg-faint" title={tool.summary}><PathText key={status} text={tool.summary} stopClick /></span>}
    </span>
  )
}

/**
 * 连续的多个思考/工具块折成一行：折叠时只显示"思考 N · 工具 M"和最后一条操作，点开才看到每个块。
 * 回合进行中同样默认折叠，那一行会随最新动作刷新
 */
function ProcessGroup({ segs, live, renderSegment }: { segs: ProcessSegment[]; live: boolean; renderSegment: (seg: ProcessSegment, offset: number) => ReactNode }) {
  const [open, toggle] = useAutoOpen(false)
  const summary = summarizeGroup(segs)
  const counts = [
    summary.thinkings > 0 ? `思考 ${summary.thinkings}` : "",
    summary.toolCalls > 0 ? `工具 ${summary.toolCalls}` : "",
  ].filter(Boolean).join(" · ")
  return (
    <div>
      <button type="button" onClick={toggle} className="flex w-full items-center gap-1.5 text-left text-xs text-fg-muted transition hover:text-fg-2">
        {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
        {live ? <Loader2 size={12} className="shrink-0 animate-spin" /> : <Layers size={12} className="shrink-0" />}
        <span className="shrink-0">{counts}</span>
        {summary.failed > 0 && <span className="shrink-0 text-danger">{summary.failed} 失败</span>}
        {!open && <><span className="shrink-0 text-fg-faint">·</span><GroupTail summary={summary} live={live} /></>}
      </button>
      {open && <div className="mt-1 space-y-1 pl-4">{segs.map((seg, j) => renderSegment(seg, j))}</div>}
    </div>
  )
}

function TodoIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={13} className="shrink-0 text-success" />
  if (status === "in_progress") return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
  if (status === "cancelled") return <XCircle size={13} className="shrink-0 text-fg-faint" />
  return <Circle size={13} className="shrink-0 text-fg-faint" />
}

function TodosBlock({ items }: { items: AppChatTodo[] }) {
  const done = items.filter((t) => t.status === "completed").length
  const pct = items.length > 0 ? Math.round((done / items.length) * 100) : 0
  return (
    <div className="rounded-lg border border-line-subtle bg-surface/40 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-fg-3">
        <ListChecks size={13} />
        <span>任务清单</span>
        <span className="tabular-nums text-fg-muted">{done}/{items.length}</span>
        <div className="ml-auto h-1 w-24 overflow-hidden rounded bg-raised">
          <div className="h-full bg-success transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5"><TodoIcon status={t.status} /></span>
            <span className={t.status === "completed" || t.status === "cancelled" ? "text-fg-faint line-through" : t.status === "in_progress" ? "text-fg-soft" : "text-fg-3"}>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FooterPart({ part }: { part: TurnFooterPart }) {
  switch (part.kind) {
    case "status": return <span className={part.status === "interrupted" ? "text-warning" : "text-accent"}>{part.text}</span>
    case "time": return <MessageTime ts={part.ts} />
    default: return <span>{part.text}</span>
  }
}

/**
 * 回合页脚：显示哪几项、什么顺序由共享的 buildTurnFooter 定（飞书卡片页脚用的是同一个函数），这里只负责画。
 * 时间是回合完成的时刻；旧记录没存完成时间，退回显示开始时间，也就没有耗时。
 */
function TurnFooter({ item, replyText }: { item: AppChatAssistantItem; replyText: string }) {
  const parts = buildTurnFooter({
    modelLabel: item.modelLabel,
    status: item.interrupted ? "interrupted" : undefined,
    elapsedMs: item.finishedAt !== undefined ? item.finishedAt - item.ts : undefined,
    time: item.finishedAt ?? item.ts,
  })
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
      {parts.map((part, i) => (
        <Fragment key={part.kind}>
          {i > 0 && <span>·</span>}
          <FooterPart part={part} />
        </Fragment>
      ))}
      {replyText && <CopyButton text={replyText} className="ml-1.5" />}
    </div>
  )
}

/** 最后一段流式输出的下标：被引用进来的记录不算，它挂在后面也不该让前面还在跑的思考/工具块停止转圈 */
function lastStreamedIndex(segments: AppChatSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].type !== "item") return i
  }
  return -1
}

/** renderInline：画这个回合里引用的那条记录（问题、图片、文件）；找不到记录时什么都不画 */
export default function AssistantTurn({ item, renderInline }: { item: AppChatAssistantItem; renderInline: (itemId: string) => ReactNode }) {
  const last = lastStreamedIndex(item.segments)
  const lastThinking = lastIndexOfType(item.segments, "thinking")
  const lastTools = lastIndexOfType(item.segments, "tools")
  const replyText = item.segments.flatMap((s) => (s.type === "reply" ? [s.text] : [])).join("\n\n")
  const renderSegment = (seg: AppChatSegment, i: number): ReactNode => {
    const live = !item.finished && i === last
    switch (seg.type) {
      case "thinking": return <ThinkingBlock key={i} text={seg.text} ms={seg.ms} live={live} expanded={!item.finished && i === lastThinking} />
      case "tools": return <ToolsBlock key={i} tools={seg.tools} live={live} expanded={!item.finished && i === lastTools} />
      case "todos": return <TodosBlock key={i} items={seg.items} />
      case "reply": return <Markdown key={i} text={seg.text} />
      case "item": return <Fragment key={i}>{renderInline(seg.itemId)}</Fragment>
    }
  }
  return (
    <div className="space-y-2">
      {groupSegments(item.segments).map((block) => {
        if (block.kind === "single") return renderSegment(block.seg, block.index)
        const end = block.start + block.segs.length - 1
        return (
          <ProcessGroup
            key={`group-${block.start}`}
            segs={block.segs}
            live={!item.finished && end === last}
            renderSegment={(seg, offset) => renderSegment(seg, block.start + offset)}
          />
        )
      })}
      {!item.finished && item.segments.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />Agent 正在处理…</div>
      )}
      {item.finished && <TurnFooter item={item} replyText={replyText} />}
    </div>
  )
}
