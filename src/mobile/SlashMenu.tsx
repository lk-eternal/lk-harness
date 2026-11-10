interface Props {
  /** 候选指令（slashMenuItems 的结果）；空 = 不渲染 */
  items: ReadonlyArray<{ cmd: string; desc: string }>
  onPick: (cmd: string) => void
}

/**
 * 输入框里敲 `/` 弹出的指令菜单，贴着输入栏上沿向上展开（父容器要 relative）。
 * 点选时不让输入框失焦：软键盘不收起，选完可以直接接着输参数。
 */
export default function SlashMenu({ items, onPick }: Props) {
  if (items.length === 0) return null
  return (
    <div
      data-slash-menu
      role="listbox"
      aria-label="指令"
      className="absolute inset-x-2 bottom-full z-30 mb-1 max-h-[45vh] overflow-y-auto overscroll-contain rounded-xl border border-line bg-page py-1 shadow-lg"
    >
      {items.map((c) => (
        <button
          key={c.cmd}
          type="button"
          role="option"
          aria-selected={false}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c.cmd)}
          className="flex w-full items-baseline gap-3 px-3 py-2.5 text-left text-xs transition active:bg-raised"
        >
          <span className="shrink-0 font-mono text-[13px] text-accent">{c.cmd}</span>
          <span className="min-w-0 flex-1 truncate text-fg-muted">{c.desc}</span>
        </button>
      ))}
    </div>
  )
}
