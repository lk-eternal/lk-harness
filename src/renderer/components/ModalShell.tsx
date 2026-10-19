import type { ReactNode } from "react"

interface ModalShellProps {
  title: string
  children: ReactNode
  footer: ReactNode
}

/**
 * 与 Dashboard / 设置页一致的深色弹层容器（替代系统 MessageBox）。
 */
export function ModalShell({ title, children, footer }: ModalShellProps) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
        }
      }}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-line-subtle bg-page shadow-2xl ring-1 ring-white/[0.06]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line-subtle px-5 py-3">
          <h2 id="modal-title" className="text-base font-semibold text-fg">
            {title}
          </h2>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4 text-sm leading-relaxed text-fg-2 [word-break:keep-all]">
          {children}
        </div>
        <div className="flex flex-col gap-3 border-t border-line-subtle bg-surface/40 px-5 py-3">
          {footer}
        </div>
      </div>
    </div>
  )
}

export const modalBtnBase =
  "rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"

export const modalBtnGhost =
  `${modalBtnBase} border border-line bg-raised/60 text-fg-soft hover:bg-strong/80`

export const modalBtnPrimary =
  `${modalBtnBase} border border-blue-600/40 bg-blue-600/20 text-accent-soft hover:bg-blue-600/30`

export const modalBtnDanger =
  `${modalBtnBase} border border-danger-line/50 bg-danger-tint/40 text-danger-soft hover:bg-danger-tint-strong/50`
