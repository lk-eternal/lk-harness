import { useState } from "react"
import { ModalShell, modalBtnGhost, modalBtnPrimary } from "./ModalShell"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface Props {
  title: string
  /** 说明建在哪个目录下，例如 my-skill/scripts/ */
  location: string
  placeholder: string
  /** 返回要显示给用户的错误；返回 null 表示成功，由调用方关掉弹窗 */
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
}

export default function SkillNameDialog({ title, location, placeholder, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    setError(null)
    try {
      const err = await onSubmit(value)
      if (err) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title={title}
      footer={
        <div className="flex w-full justify-end gap-2">
          <button type="button" className={modalBtnGhost} onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className={modalBtnPrimary} onClick={() => void submit()} disabled={busy || !value.trim()}>确定</button>
        </div>
      }
    >
      <p className="mb-2 break-all text-xs text-fg-muted">位置：<span className="font-mono">{location}</span></p>
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => { setValue(e.target.value); setError(null) }}
        onKeyDown={(e) => {
          // 输入法选字时的回车不算提交
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit()
          else if (e.key === "Escape") onCancel()
        }}
        placeholder={placeholder}
        className={inputCls}
        aria-label={title}
      />
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </ModalShell>
  )
}
