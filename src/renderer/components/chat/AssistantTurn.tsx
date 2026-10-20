import { useState } from "react"
import { Brain, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, ListChecks, Loader2, Wrench, XCircle } from "lucide-react"
import type { AppChatAssistantItem, AppChatSegment, AppChatTodo, AppChatTool } from "../../../shared/app-chat-types"
import { MessageTime } from "./ItemViews"
import Markdown, { CopyButton } from "./Markdown"

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
              {t.summary && <span className="min-w-0 flex-1 truncate text-fg-muted" title={t.summary}>{t.summary}</span>}
              {t.ms != null && <span className="ml-auto shrink-0 tabular-nums text-fg-faint">{fmtMs(t.ms)}</span>}
            </li>
          ))}
        </ul>
      )}
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
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
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

export default function AssistantTurn({ item }: { item: AppChatAssistantItem }) {
  const last = item.segments.length - 1
  const lastThinking = lastIndexOfType(item.segments, "thinking")
  const lastTools = lastIndexOfType(item.segments, "tools")
  const replyText = item.segments.flatMap((s) => (s.type === "reply" ? [s.text] : [])).join("\n\n")
  return (
    <div className="space-y-2">
      {item.segments.map((seg, i) => {
        const live = !item.finished && i === last
        switch (seg.type) {
          case "thinking": return <ThinkingBlock key={i} text={seg.text} ms={seg.ms} live={live} expanded={!item.finished && i === lastThinking} />
          case "tools": return <ToolsBlock key={i} tools={seg.tools} live={live} expanded={!item.finished && i === lastTools} />
          case "todos": return <TodosBlock key={i} items={seg.items} />
          case "reply": return <Markdown key={i} text={seg.text} />
        }
      })}
      {!item.finished && item.segments.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />Agent 正在处理…</div>
      )}
      {item.finished && (
        <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
          {item.modelLabel && <><span>{item.modelLabel}</span><span>·</span></>}
          <MessageTime ts={item.ts} />
          {replyText && <CopyButton text={replyText} className="ml-1.5" />}
        </div>
      )}
    </div>
  )
}
