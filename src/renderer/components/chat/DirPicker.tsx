import { useCallback, useRef, useState } from "react"
import { Check, ChevronDown, Folder, FolderOpen, FolderPlus } from "lucide-react"
import useOutsideClose from "../../hooks/useOutsideClose"

export interface DirOption {
  name: string
  dir: string
}

interface Props {
  /** 当前会话的目录名；没有指定目录时为空，芯片显示「选择目录」 */
  currentName?: string
  options: DirOption[]
  /** 选了一个已有目录 */
  onSelect: (dir: string) => void
  /** 选一个新目录 */
  onPickNew: () => void
  isCurrent: (dir: string) => boolean
  /** 菜单顶部的说明：选目录的效果取决于会话开没开始（改本会话的目录 / 用该目录新开一个会话） */
  hint: string
}

/** 输入框里的目录选择：目录是会话的工作目录，不是会话的身份——多个会话可以用同一个目录 */
export default function DirPicker({ currentName, options, onSelect, onPickNew, isCurrent, hint }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useOutsideClose(open, rootRef, close)

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="工作目录"
        className={`inline-flex max-w-[14rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition ${open ? "border-accent bg-raised" : "border-line hover:border-line-strong"} ${currentName ? "text-fg-2" : "border-dashed text-fg-muted"}`}
      >
        <FolderOpen size={14} className="shrink-0 text-fg-muted" />
        <span className="truncate">{currentName ?? "选择目录"}</span>
        <ChevronDown size={12} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-line bg-page p-1.5 shadow-lg">
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] leading-relaxed text-fg-faint">{hint}</p>
          <div className="max-h-64 overflow-y-auto">
            {options.map((o) => {
              const cur = isCurrent(o.dir)
              return (
                <button
                  key={o.dir}
                  type="button"
                  onClick={() => { setOpen(false); if (!cur) onSelect(o.dir) }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-strong/40"
                >
                  {cur ? <FolderOpen size={16} className="shrink-0 text-accent" /> : <Folder size={16} className="shrink-0 text-fg-muted" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg-2">{o.name}</span>
                    <span className="block truncate font-mono text-[11px] text-fg-faint">{o.dir}</span>
                  </span>
                  {cur && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              )
            })}
          </div>
          {options.length > 0 && <div className="mx-1 my-1.5 h-px bg-line-subtle" />}
          <button
            type="button"
            onClick={() => { setOpen(false); onPickNew() }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-fg-2 transition hover:bg-strong/40"
          >
            <FolderPlus size={16} className="shrink-0 text-fg-muted" />选择新目录…
          </button>
        </div>
      )}
    </div>
  )
}
