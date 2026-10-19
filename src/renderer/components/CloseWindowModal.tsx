import { useState } from "react"
import { ModalShell, modalBtnGhost, modalBtnPrimary, modalBtnDanger } from "./ModalShell"

interface Props {
  open: boolean
  onClose: () => void
}

export default function CloseWindowModal({ open, onClose }: Props) {
  const [remember, setRemember] = useState(false)

  if (!open) return null

  const send = (action: "minimize" | "quit" | "cancel") => {
    void window.electronAPI.respondWindowClose({ action, remember })
    setRemember(false)
    onClose()
  }

  return (
    <ModalShell
      title="关闭窗口"
      footer={
        <>
          <label className="flex w-full cursor-pointer items-start gap-2 text-xs leading-snug text-fg-3">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 shrink-0 rounded border-line-strong bg-raised text-blue-500 focus:ring-blue-500/40"
            />
            <span>不再提醒，以后按本次选择执行</span>
          </label>
          <div className="flex w-full flex-wrap justify-end gap-2">
            <button type="button" className={modalBtnGhost} onClick={() => send("cancel")}>
              取消
            </button>
            <button type="button" className={`${modalBtnPrimary} whitespace-nowrap`} onClick={() => send("minimize")}>
              最小化到托盘
            </button>
            <button type="button" className={`${modalBtnDanger} whitespace-nowrap`} onClick={() => send("quit")}>
              退出应用
            </button>
          </div>
        </>
      }
    >
      <p className="mb-2 text-fg-soft">请选择关闭主窗口后的操作：</p>
      <p className="text-xs text-fg-muted">
        可在
        <span className="whitespace-nowrap">「设置 → 通用」</span>
        中随时修改默认行为。
      </p>
    </ModalShell>
  )
}
