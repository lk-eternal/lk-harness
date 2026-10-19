/** 卡片展开面板的统一外壳：同样的圆角/底色/标题行/高度上限，内容区独立滚动 */
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
    <div className="mx-6 mb-3 flex max-h-[45vh] shrink-0 flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface/80">
      <div className="flex shrink-0 items-center justify-between border-b border-line-subtle px-3 py-2">
        <span className="text-xs font-medium text-fg-3">{title}</span>
        {meta != null && <span className="text-xs text-fg-faint">{meta}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
