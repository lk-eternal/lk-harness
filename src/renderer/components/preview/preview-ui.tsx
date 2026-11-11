import { Component, type ReactNode } from "react"
import { FileQuestion, Loader2 } from "lucide-react"
import { formatBytes } from "../../../shared/preview-text"
import "./preview.css"

/**
 * 懒加载的查看器加载失败（网络断了、资源缺失）或渲染时出错，显示 fallback，而不是让整个界面白屏。
 * 注意：React.lazy 加载失败的结果会被缓存，重新渲染也不会重试，要恢复得重新进入页面。
 */
export class LoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

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

/** 选项条里的文字按钮（折叠全部 / 展开全部 这类） */
export function BarTextButton({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded-md border border-line-subtle px-2 py-0.5 text-xs text-fg-muted transition hover:border-line hover:text-fg-2"
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

export function Loading() {
  return <CenterMessage><Loader2 size={18} className="animate-spin" /></CenterMessage>
}

/** 说明页里的操作按钮样式 */
export const NOTICE_BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft"
/** 主操作（说明页里最该点的那个） */
export const NOTICE_BUTTON_PRIMARY = "inline-flex items-center gap-1.5 rounded-lg border border-blue-500 px-3 py-1.5 text-xs text-accent-soft transition hover:bg-blue-500/10"

/** 文件没法在应用内显示时的说明页：文件名、原因，下面放这个环境里能做的操作（用默认程序打开、下载等） */
export function FileNotice({ file, reason, children }: { file: { name: string; size: number }; reason: string; children?: ReactNode }) {
  return (
    <CenterMessage>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-raised text-fg-3"><FileQuestion size={30} /></div>
      <div>
        <p className="break-all text-sm font-medium text-fg-soft">{file.name}</p>
        <p className="mt-1 text-xs text-fg-faint">{formatBytes(file.size)} · {reason}</p>
      </div>
      {children}
    </CenterMessage>
  )
}
