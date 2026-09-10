import { useState, useCallback, type ReactNode } from "react"
import { ModalShell, modalBtnGhost, modalBtnPrimary, modalBtnDanger } from "./ModalShell"

type BtnVariant = "primary" | "ghost" | "danger"

interface ModalBtn {
  label: string
  variant?: BtnVariant
}

const variantCls: Record<BtnVariant, string> = {
  primary: modalBtnPrimary,
  ghost: modalBtnGhost,
  danger: modalBtnDanger,
}

interface ShowOptions {
  title: string
  message: string
  buttons?: (string | ModalBtn)[]
}

export type UnsavedChoice = "save" | "discard" | "cancel"

export default function useInlineModal(): {
  showAlert: (title: string, message: string) => Promise<void>
  showConfirm: (title: string, message: string, ok?: string, cancel?: string) => Promise<boolean>
  /** 未保存三选项：保存 / 丢弃(放弃) / 取消(继续编辑) */
  showUnsavedChoice: (title: string, message: string, labels?: { save?: string; discard?: string; cancel?: string }) => Promise<UnsavedChoice>
  ModalPortal: ReactNode
} {
  const [state, setState] = useState<{ opts: ShowOptions; resolve: (idx: number) => void } | null>(null)

  const show = useCallback((opts: ShowOptions): Promise<number> => {
    return new Promise((resolve) => setState({ opts, resolve }))
  }, [])

  const close = (idx: number) => {
    state?.resolve(idx)
    setState(null)
  }

  const showAlert = useCallback(
    (title: string, message: string) => show({ title, message, buttons: ["确定"] }).then(() => {}),
    [show],
  )

  const showConfirm = useCallback(
    (title: string, message: string, ok = "确定", cancel = "取消") =>
      show({ title, message, buttons: [{ label: cancel, variant: "ghost" }, ok] }).then((i) => i === 1),
    [show],
  )

  const showUnsavedChoice = useCallback(
    (title: string, message: string, labels?: { save?: string; discard?: string; cancel?: string }) =>
      show({
        title,
        message,
        buttons: [
          { label: labels?.cancel ?? "取消", variant: "ghost" },
          { label: labels?.discard ?? "丢弃", variant: "danger" },
          { label: labels?.save ?? "保存并继续", variant: "primary" },
        ],
      }).then((i): UnsavedChoice => (i === 2 ? "save" : i === 1 ? "discard" : "cancel")),
    [show],
  )

  const ModalPortal = state ? (
    <ModalShell
      title={state.opts.title}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          {(state.opts.buttons ?? ["确定"]).map((b, i) => {
            const btn: ModalBtn = typeof b === "string" ? { label: b, variant: "primary" } : b
            return (
              <button key={i} type="button" className={variantCls[btn.variant ?? "primary"]} onClick={() => close(i)}>
                {btn.label}
              </button>
            )
          })}
        </div>
      }
    >
      <p className="whitespace-pre-wrap text-gray-200">{state.opts.message}</p>
    </ModalShell>
  ) : null

  return { showAlert, showConfirm, showUnsavedChoice, ModalPortal }
}
