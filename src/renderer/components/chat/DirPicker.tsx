import { useCallback, useRef, useState } from "react"
import { Check, ChevronDown, Folder, FolderOpen, FolderPlus } from "lucide-react"
import useOutsideClose from "../../hooks/useOutsideClose"

export interface DirOption {
  sessionKey: string
  name: string
  dir: string
}

interface Props {
  /** 当前会话的目录名；没有指定目录时为空，芯片显示「选择目录」 */
  currentName?: string
  options: DirOption[]
  /** 切到已有目录对应的会话 */
  onSelect: (sessionKey: string) => void
  /** 选一个新目录并切到它的会话 */
  onPickNew: () => void
  isCurrent: (sessionKey: string) => boolean
}

/** 输入框里的目录选择：一个目录对应一个会话，换目录就是切到（或新建）那个目录的会话 */
export default function DirPicker({ currentName, options, onSelect, onPickNew, isCurrent }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useOutsideClose(open, rootRef, close)

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="切换目录"
        className={`inline-flex max-w-[14rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition ${open ? "border-accent bg-raised" : "border-line hover:border-line-strong"} ${currentName ? "text-fg-2" : "border-dashed text-fg-muted"}`}
      >
        <FolderOpen size={14} className="shrink-0 text-fg-muted" />
        <span className="truncate">{currentName ?? "选择目录"}</span>
        <ChevronDown size={12} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-line bg-page p-1.5 shadow-lg">
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] leading-relaxed text-fg-faint">切换目录会打开该目录的会话，没有就新建一个</p>
          <div className="max-h-64 overflow-y-auto">
            {options.map((o) => {
              const cur = isCurrent(o.sessionKey)
              return (
                <button
                  key={o.sessionKey}
                  type="button"
                  onClick={() => { setOpen(false); if (!cur) onSelect(o.sessionKey) }}
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
