import { useEffect, useRef, useState } from "react"
import { AlarmClock, ChevronUp, Loader2, Trash2, Zap } from "lucide-react"
import {
  describeScheduleDetail,
  describeScheduleItem,
  runNowHint,
  summarizeSchedules,
  type SessionScheduleItem,
} from "../../../shared/session-schedule"
import useOutsideClose from "../../hooks/useOutsideClose"
import { useSessionSchedules } from "./useSessionSchedules"

interface Props {
  /** 当前会话键；没有会话（空白页）时不显示 */
  sessionKey: string | null
  /** 对话页当前是否可见（不可见时不轮询） */
  active: boolean
  /** 删用户建的任务前确认（沿用对话页的确认弹窗） */
  confirm: (title: string, message: string, ok: string) => Promise<boolean>
  /** 打开设置页的定时任务 */
  onOpenSettings: () => void
}

type Note = { ok: boolean; text: string }

/**
 * 输入框上方的「这个会话的定时」：折叠条显示几个、下次什么时候；点开列出每个任务，
 * 可以立即运行一次、或删除（AI 排程是取消）。会话里没有定时任务时整块不显示。
 */
export default function SessionSchedules({ sessionKey, active, confirm, onOpenSettings }: Props) {
  const { items, reload } = useSessionSchedules(sessionKey, active)
  const [open, setOpen] = useState(false)
  /** 正在处理的任务：run = 立即运行中，del = 删除 / 取消中 */
  const [busy, setBusy] = useState<Record<string, "run" | "del">>({})
  const [note, setNote] = useState<Note | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const closePopover = () => setOpen(false)
  useOutsideClose(open, rootRef, closePopover)

  // 换会话：上一个会话的弹层和提示不带过来
  useEffect(() => { setOpen(false); setNote(null); setBusy({}) }, [sessionKey])
  // 最后一个任务没了：收起弹层，别留一个空壳
  useEffect(() => { if (items.length === 0) setOpen(false) }, [items.length])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])
  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(() => setNote(null), 4000)
    return () => window.clearTimeout(t)
  }, [note])

  if (items.length === 0) return null

  const now = Date.now()
  const mark = (id: string, what: "run" | "del" | null) =>
    setBusy((prev) => {
      const next = { ...prev }
      if (what) next[id] = what
      else delete next[id]
      return next
    })

  const runNow = async (item: SessionScheduleItem) => {
    if (busy[item.id]) return
    mark(item.id, "run")
    try {
      const r = await window.electronAPI.triggerScheduledTask(item.id)
      setNote(r.ok ? { ok: true, text: `已触发「${item.name}」` } : { ok: false, text: `触发失败：${r.error ?? "未知原因"}` })
    } catch (e: unknown) {
      setNote({ ok: false, text: `触发失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      mark(item.id, null)
      void reload()
    }
  }

  const remove = async (item: SessionScheduleItem) => {
    if (busy[item.id]) return
    // AI 排程是有次数 / 期限的临时任务，取消即可；用户在设置页建的是正式配置，删之前问一句
    if (item.origin === "user" && !(await confirm("删除定时任务", `确定删除「${item.name}」吗？\n这是在设置页创建的任务，删除后不会再触发。`, "删除"))) return
    mark(item.id, "del")
    try {
      const r = item.origin === "ai"
        ? await window.electronAPI.cancelAiScheduledTask(item.id)
        : await window.electronAPI.deleteScheduledTask(item.id)
      if (!r.ok) setNote({ ok: false, text: `${item.origin === "ai" ? "取消" : "删除"}失败：${r.error ?? "未知原因"}` })
    } catch (e: unknown) {
      setNote({ ok: false, text: `操作失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      mark(item.id, null)
      await reload()
    }
  }

  const anyRunning = items.some((i) => i.running)

  return (
    <div ref={rootRef} className="relative mb-2">
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-20 mb-1.5 overflow-hidden rounded-xl border border-line bg-page shadow-lg">
          <p className="px-3 pb-1 pt-2 text-[12px] font-medium text-fg-3">这个会话的定时</p>
          <ul className="max-h-64 divide-y divide-line-subtle overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} title={describeScheduleDetail(item)} className="flex items-center gap-2 px-3 py-2">
                {item.running
                  ? <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
                  : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.enabled ? "bg-accent" : "bg-fg-faint"}`} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate text-[13px] ${item.enabled ? "text-fg-2" : "text-fg-muted line-through"}`}>{item.name}</span>
                    {item.origin === "ai" && <span className="shrink-0 rounded bg-raised px-1 text-[10px] leading-4 text-fg-muted">AI</span>}
                  </div>
                  <p className="truncate text-[11.5px] text-fg-muted">{describeScheduleItem(item, now)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void runNow(item)}
                    disabled={!!busy[item.id] || item.running}
                    title={item.running ? "正在运行" : runNowHint(item)}
                    className="rounded p-1.5 text-fg-muted transition hover:bg-raised hover:text-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                  >{busy[item.id] === "run" ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}</button>
                  <button
                    type="button"
                    onClick={() => void remove(item)}
                    disabled={!!busy[item.id]}
                    title={item.origin === "ai" ? "取消这个定时（之后不再触发）" : "删除这个定时任务"}
                    className="rounded p-1.5 text-fg-muted transition hover:bg-raised hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                  >{busy[item.id] === "del" ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}</button>
                </div>
              </li>
            ))}
          </ul>
          {note && (
            <p role="status" className={`border-t border-line-subtle px-3 py-1.5 text-[12px] ${note.ok ? "text-success" : "text-danger"}`}>{note.text}</p>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line-subtle px-3 py-1.5 text-[11px] text-fg-faint">
            <span className="min-w-0 truncate">立即运行只多跑一次，不改变原计划，也不计入已触发次数</span>
            <button type="button" onClick={onOpenSettings} className="shrink-0 text-accent transition hover:underline">全部定时任务</button>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface/70 px-3 py-1.5 text-left text-[12px] text-fg-3 transition hover:bg-raised/50"
      >
        {anyRunning ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" /> : <AlarmClock size={13} className="shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 truncate">{summarizeSchedules(items, now)}</span>
        <ChevronUp size={13} className={`shrink-0 text-fg-muted transition ${open ? "" : "rotate-180"}`} />
      </button>
    </div>
  )
}
