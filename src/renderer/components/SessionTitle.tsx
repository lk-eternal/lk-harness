import { useRef, useState } from "react"
import { Pencil } from "lucide-react"

interface Props {
  name: string
  /** 留空表示恢复自动命名 */
  onRename: (name: string) => void
}

const MAX_CHARS = 30

/** 会话标题：名字后面一个铅笔图标，点击后原地编辑；回车/失焦保存，Esc 放弃 */
export default function SessionTitle({ name, onRename }: Props) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  const start = () => {
    cancelled.current = false
    setDraft(name)
  }

  const commit = () => {
    const next = (draft ?? "").trim()
    setDraft(null)
    if (!cancelled.current && next !== name) onRename(next)
  }

  if (draft === null) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="min-w-0 truncate text-sm font-semibold">{name}</p>
        <button
          type="button"
          onClick={start}
          title="重命名"
          className="shrink-0 rounded p-1 text-fg-faint transition hover:bg-raised hover:text-fg-soft"
        ><Pencil size={13} /></button>
      </div>
    )
  }

  return (
    <input
      autoFocus
      value={draft}
      maxLength={MAX_CHARS}
      placeholder="留空恢复自动命名"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
      className="w-full max-w-sm rounded bg-raised px-2 py-0.5 text-sm font-semibold outline-none"
    />
  )
}
