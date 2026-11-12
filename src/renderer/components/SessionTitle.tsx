import { useRef, useState } from "react"
import { Pencil } from "lucide-react"

interface Props {
  name: string
  /** 回车 / 失焦时名字有变化才调用；是否允许留空（恢复自动命名）由调用方的处理决定 */
  onRename: (name: string) => void
  /** 名字最多几个字，缺省 30（会话标题）；项目会话的名字就是项目名，上限更长 */
  maxLength?: number
  /** 编辑框的占位文字，缺省提示留空恢复自动命名；不能留空的名字（项目名）要换成别的提示 */
  placeholder?: string
}

const MAX_CHARS = 30

/** 会话标题：名字后面一个铅笔图标，点击后原地编辑；回车/失焦保存，Esc 放弃 */
export default function SessionTitle({ name, onRename, maxLength = MAX_CHARS, placeholder = "留空恢复自动命名" }: Props) {
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
      maxLength={maxLength}
      placeholder={placeholder}
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
