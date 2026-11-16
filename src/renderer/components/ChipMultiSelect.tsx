import { useState, useEffect, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Search, Check, X } from "lucide-react"

export interface ChipOption {
  id: string
  label: string
  /** 分组标题（同组的选项挨在一起显示）；缺省不分组 */
  group?: string
  /** 鼠标悬停时的说明 */
  hint?: string
}

const DROP_MAX_H = 300

/**
 * 多选下拉：选中的逐个填成 chip，下拉里可搜索、可按 group 分组。
 * value 里有、options 里已经没有的（比如被删掉的 Skill）也照样显示成 chip，方便用户看到并移除。
 */
export default function ChipMultiSelect({ options, value, onChange, placeholder, searchPlaceholder = "搜索...", emptyText = "暂无可选项" }: {
  options: ChipOption[]
  value: string[]
  onChange: (ids: string[]) => void
  placeholder: string
  searchPlaceholder?: string
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [style, setStyle] = useState<React.CSSProperties>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const picked = new Set(value)
  const byId = new Map(options.map((o) => [o.id, o]))
  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.group ?? "").toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q))
    : options

  const toggle = (id: string) => {
    onChange(picked.has(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  const reposition = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom - 8
    const spaceAbove = r.top - 8
    if (spaceBelow < DROP_MAX_H && spaceAbove > spaceBelow) {
      setStyle({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width, maxHeight: Math.min(spaceAbove, DROP_MAX_H) })
    } else {
      setStyle({ top: r.bottom + 4, left: r.left, width: r.width, maxHeight: Math.min(spaceBelow, DROP_MAX_H) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    inputRef.current?.focus({ preventScroll: true })
    const onLayout = () => reposition()
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || dropRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener("scroll", onLayout, true)
    window.addEventListener("resize", onLayout)
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onDown)
    return () => {
      window.removeEventListener("scroll", onLayout, true)
      window.removeEventListener("resize", onLayout)
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onDown)
    }
  }, [open, reposition])

  // 按分组归并，组内保持原顺序；没有分组的放最前面
  const groups: { title: string; items: ChipOption[] }[] = []
  for (const o of filtered) {
    const title = o.group ?? ""
    let g = groups.find((x) => x.title === title)
    if (!g) { g = { title, items: [] }; groups.push(g) }
    g.items.push(o)
  }
  groups.sort((a, b) => (a.title === "" ? -1 : b.title === "" ? 1 : 0))

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { setOpen(!open); setQuery("") }}
        className="flex min-h-[34px] w-full items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-left text-sm outline-none transition hover:border-line-strong focus:border-blue-500"
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {value.length === 0
            ? <span className="px-1 text-fg-muted">{placeholder}</span>
            : value.map((id) => {
              const o = byId.get(id)
              const label = o?.label ?? id
              return (
                <span key={id} className={`flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs ${o ? "bg-blue-600/25 text-accent-bright" : "bg-raised text-fg-faint line-through"}`}>
                  <span className="truncate" title={o ? (o.hint || label) : `${id}（已不存在）`}>{label}</span>
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); toggle(id) }}
                    className="cursor-pointer rounded hover:text-fg"
                    title="移除"
                  ><X size={12} /></span>
                </span>
              )
            })}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-fg-muted transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[9999] flex flex-col rounded-lg border border-line bg-surface shadow-xl"
          style={style}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-2">
            <Search size={14} className="text-fg-muted" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" onWheel={(e) => e.stopPropagation()}>
            {options.length === 0
              ? <div className="px-3 py-2 text-xs text-fg-muted">{emptyText}</div>
              : filtered.length === 0
                ? <div className="px-3 py-2 text-xs text-fg-muted">无匹配结果</div>
                : groups.map((g) => (
                  <div key={g.title || "_"}>
                    {g.title && <div className="truncate px-3 pb-0.5 pt-1.5 text-[11px] text-fg-faint" title={g.title}>{g.title}</div>}
                    {g.items.map((o) => {
                      const checked = picked.has(o.id)
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => toggle(o.id)}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-raised ${checked ? "text-accent-soft" : "text-fg-2"}`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "border-blue-500 bg-blue-600" : "border-line-strong"}`}>
                            {checked && <Check size={12} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate" title={o.label}>{o.label}</span>
                            {o.hint && <span className="block truncate text-[11px] text-fg-faint" title={o.hint}>{o.hint}</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
