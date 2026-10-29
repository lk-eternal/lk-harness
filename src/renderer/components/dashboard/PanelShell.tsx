/** 功能区里「一块带标题行的面板」的统一外壳：撑满功能区高度，标题行固定，内容区独立滚动 */
export default function PanelShell({
  title,
  meta,
  children,
}: {
  title: string
  meta?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface/80">
      <div className="flex shrink-0 items-center justify-between border-b border-line-subtle px-3 py-2">
        <span className="text-xs font-medium text-fg-3">{title}</span>
        {meta != null && <span className="text-xs text-fg-faint">{meta}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
