import { useEffect, useRef, useState } from "react"
import { Check, Clock, ImageIcon, Loader2, Pencil, SendHorizontal, Trash2, X } from "lucide-react"
import type { AppChatUserItem } from "../../../shared/app-chat-types"
import { HANDOFF_HINT_MAX_MS, phaseAfterSend, queuedHeaderText, type HandoffPhase, type SendNowOutcome } from "./queued-strip-text"

interface Props {
  /** 排队中、还没投递给 Agent 的消息，按发送顺序 */
  items: AppChatUserItem[]
  /** 改正文；返回 false 表示没改成（已送达等），界面保持原样 */
  onEdit: (id: string, text: string) => Promise<boolean>
  onRemove: (id: string) => Promise<void>
  /** 打断当前回合，让排队的消息立刻交给 Agent；返回交接结果，用来显示「已打断 / 正在启动」提示 */
  onSendNow: () => Promise<SendNowOutcome>
  /** 手机端：按钮的点按区域放大，手指点得中 */
  touch?: boolean
}

/**
 * 输入框上方的暂存区：Agent 干活时发出的消息先排在这里，不进聊天流。
 * 当前回合结束、Agent 领走后消息才进入聊天流；在那之前可以改、可以删、可以让它立刻发出（打断当前回合）。
 */
export default function QueuedStrip({ items, onEdit, onRemove, onSendNow, touch = false }: Props) {
  const iconPad = touch ? "p-2" : "p-1"
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  /** 点「立即发送」之后到消息被 Agent 领走之间的提示阶段；null = 平时的排队提示 */
  const [handoff, setHandoff] = useState<HandoffPhase>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  // 正在编辑的那条已经送达或被删：退出编辑态，别留一个指向不存在消息的编辑框
  useEffect(() => {
    if (editingId && !items.some((i) => i.id === editingId)) setEditingId(null)
  }, [items, editingId])

  // 消息被领走（暂存区清空）：交接结束，下次排队从平时的提示开始
  useEffect(() => {
    if (items.length === 0) setHandoff(null)
  }, [items.length])

  // 交接提示不能永远挂着：Agent 一直没领走（比如启动失败）时回到平时的提示
  useEffect(() => {
    if (handoff !== "soft" && handoff !== "starting") return
    const t = setTimeout(() => setHandoff(null), HANDOFF_HINT_MAX_MS)
    return () => clearTimeout(t)
  }, [handoff])

  useEffect(() => {
    if (!editingId) return
    const el = editorRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editingId])

  if (items.length === 0) return null

  const startEdit = (item: AppChatUserItem) => {
    setEditingId(item.id)
    setDraft(item.text)
  }

  const save = async () => {
    if (!editingId || saving) return
    const id = editingId
    const text = draft.trim()
    const item = items.find((i) => i.id === id)
    // 没改动：直接收起，不打扰服务端
    if (item && text === item.text.trim()) { setEditingId(null); return }
    setSaving(true)
    try {
      if (await onEdit(id, text)) setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  const sendNow = async () => {
    if (sending) return
    setSending(true)
    setHandoff("interrupting")
    let next: HandoffPhase = null
    try {
      next = phaseAfterSend(await onSendNow())
    } finally {
      setSending(false)
      setHandoff(next)
    }
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-surface/70">
      <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-[12px] text-fg-muted">
        <Clock size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{queuedHeaderText(items.length, handoff)}</span>
        <button
          type="button"
          onClick={() => void sendNow()}
          disabled={sending}
          title="打断当前回合，立刻把排队的消息交给 Agent"
          className={`inline-flex shrink-0 items-center gap-1 rounded-md ${touch ? "px-3 py-1.5" : "px-2 py-0.5"} text-accent transition hover:bg-raised disabled:opacity-50`}
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : <SendHorizontal size={12} />}立即发送
        </button>
      </div>
      <ul className="max-h-40 divide-y divide-line-subtle overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="group flex items-start gap-2 px-3 py-1.5">
            {editingId === item.id ? (
              <>
                <textarea
                  ref={editorRef}
                  value={draft}
                  rows={Math.min(5, Math.max(2, draft.split("\n").length))}
                  disabled={saving}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === "Escape") { e.preventDefault(); setEditingId(null); return }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save() }
                  }}
                  className="min-w-0 flex-1 resize-none rounded-md border border-line bg-page px-2 py-1 text-[13px] leading-snug outline-none focus:border-blue-500"
                />
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving || (draft.trim() === "" && !item.images?.length)}
                    title="保存（Enter）"
                    className={`rounded ${iconPad} text-accent transition hover:bg-raised disabled:opacity-40`}
                  >{saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}</button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    disabled={saving}
                    title="取消（Esc）"
                    className={`rounded ${iconPad} text-fg-muted transition hover:bg-raised hover:text-fg-soft`}
                  ><X size={13} /></button>
                </div>
              </>
            ) : (
              <>
                <div className="min-w-0 flex-1 py-0.5 text-[13px] leading-snug text-fg-2">
                  {item.images && item.images.length > 0 && (
                    <span className="mr-1.5 inline-flex items-center gap-0.5 rounded bg-raised px-1 text-[11px] text-fg-muted">
                      <ImageIcon size={11} />{item.images.length}
                    </span>
                  )}
                  <span className="line-clamp-2 whitespace-pre-wrap break-words">{item.text}</span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => startEdit(item)}
                    title="编辑"
                    className={`rounded ${iconPad} text-fg-muted transition hover:bg-raised hover:text-fg-soft`}
                  ><Pencil size={13} /></button>
                  <button
                    type="button"
                    onClick={() => void onRemove(item.id)}
                    title="删除"
                    className={`rounded ${iconPad} text-fg-muted transition hover:bg-raised hover:text-danger`}
                  ><Trash2 size={13} /></button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
