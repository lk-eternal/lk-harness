import type { ReactNode } from "react"
import "./preview.css"

/** 视图切换（预览 / 源码 这类）：一组互斥的小按钮 */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex rounded-md border border-line-subtle bg-surface p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-0.5 transition ${value === o.value ? "bg-strong/60 font-medium text-fg" : "text-fg-muted hover:text-fg-2"}`}
        >{o.label}</button>
      ))}
    </div>
  )
}

/** 工具栏上的图标按钮 */
export function BarButton({ title, onClick, disabled, active, children }: {
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:cursor-default disabled:opacity-35 ${active ? "bg-strong/60 text-fg" : "text-fg-muted enabled:hover:bg-raised enabled:hover:text-fg-soft"}`}
    >{children}</button>
  )
}

/** 查看器顶部的选项条：左边放视图切换，右边放文件信息 */
export function ViewerBar({ children }: { children: ReactNode }) {
  return <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle bg-surface/60 px-3 py-1.5 text-xs text-fg-muted">{children}</div>
}

export function ViewerNotice({ children }: { children: ReactNode }) {
  return <p className="shrink-0 border-b border-warning-line/40 bg-warning-tint/30 px-3 py-1 text-[11px] text-warning-soft">{children}</p>
}

export function CenterMessage({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-fg-muted">{children}</div>
}
