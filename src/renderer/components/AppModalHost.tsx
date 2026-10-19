import { useEffect, useState } from "react"
import { ModalShell, modalBtnGhost, modalBtnPrimary } from "./ModalShell"

export type AppModalPayload = {
  requestId: string
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
  variant?: "info" | "error" | "warning"
}

function buttonClass(payload: AppModalPayload, index: number): string {
  if (payload.buttons.length === 1) {
    return modalBtnPrimary
  }
  const def = payload.defaultId ?? 0
  if (index === def) {
    return modalBtnPrimary
  }
  return modalBtnGhost
}

export default function AppModalHost() {
  const [payload, setPayload] = useState<AppModalPayload | null>(null)

  useEffect(() => {
    if (!window.electronAPI?.onAppModalRequest) {
      return
    }
    return window.electronAPI.onAppModalRequest((p) => {
      setPayload(p)
    })
  }, [])

  if (!payload) {
    return null
  }

  const respond = (response: number) => {
    void window.electronAPI.respondAppModal(payload.requestId, response)
    setPayload(null)
  }

  return (
    <ModalShell
      title={payload.title}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          {payload.buttons.map((label, i) => (
            <button key={i} type="button" className={buttonClass(payload, i)} onClick={() => respond(i)}>
              {label}
            </button>
          ))}
        </div>
      }
    >
      <p className="mb-2 whitespace-pre-wrap text-fg-soft">{payload.message}</p>
      {payload.detail ? <p className="whitespace-pre-wrap text-xs text-fg-muted">{payload.detail}</p> : null}
    </ModalShell>
  )
}
