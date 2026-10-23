import { useEffect, useRef, useState } from "react"
import { Check, Clock, ImageIcon, Loader2, Pencil, SendHorizontal, Trash2, X } from "lucide-react"
import type { AppChatUserItem } from "../../../shared/app-chat-types"

interface Props {
  /** 排队中、还没投递给 Agent 的消息，按发送顺序 */
  items: AppChatUserItem[]
  /** 改正文；返回 false 表示没改成（已送达等），界面保持原样 */
  onEdit: (id: string, text: string) => Promise<boolean>
  onRemove: (id: string) => Promise<void>
  /** 打断当前回合，让排队的消息立刻交给 Agent */
  onSendNow: () => Promise<void>
}

/**
 * 输入框上方的暂存区：Agent 干活时发出的消息先排在这里，不进聊天流。
 * 当前回合结束、Agent 领走后消息才进入聊天流；在那之前可以改、可以删、可以让它立刻发出（打断当前回合）。
 */
export default function QueuedStrip({ items, onEdit, onRemove, onSendNow }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  // 正在编辑的那条已经送达或被删：退出编辑态，别留一个指向不存在消息的编辑框
  useEffect(() => {
    if (editingId && !items.some((i) => i.id === editingId)) setEditingId(null)
  }, [items, editingId])

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
    try {
      await onSendNow()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-surface/70">
      <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-[12px] text-fg-muted">
        <Clock size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">排队中 · {items.length} 条，Agent 完成当前回合后自动发出</span>
        <button
          type="button"
          onClick={() => void sendNow()}
          disabled={sending}
          title="停止当前回合，立刻把排队的消息交给 Agent"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-accent transition hover:bg-raised disabled:opacity-50"
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
                    className="rounded p-1 text-accent transition hover:bg-raised disabled:opacity-40"
                  >{saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}</button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    disabled={saving}
                    title="取消（Esc）"
                    className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-soft"
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
                    className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-soft"
                  ><Pencil size={13} /></button>
                  <button
                    type="button"
                    onClick={() => void onRemove(item.id)}
                    title="删除"
                    className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-danger"
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
