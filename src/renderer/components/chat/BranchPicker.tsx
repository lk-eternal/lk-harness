import { useCallback, useRef, useState } from "react"
import { Check, ChevronDown, Cloud, GitBranch, Loader2, Search } from "lucide-react"
import useOutsideClose from "../../hooks/useOutsideClose"
import {
  branchGroups,
  branchNotices,
  isDetachedLabel,
  makeBranchOverride,
  shownBranch,
  type BranchListData,
  type BranchOption,
  type BranchOverride,
} from "../../../shared/git-branch"
import { useBranchMenu } from "./useBranchMenu"

interface MenuViewProps {
  /** 还没读到列表时为 null */
  data: BranchListData | null
  loading: boolean
  error: string
  /** 正在切到的分支（branchKey） */
  switching: string | null
  query: string
  onQuery: (q: string) => void
  /** 用这个目录的会话个数（含当前这个） */
  shared: number
  onPick: (option: BranchOption) => void
  onEscape?: () => void
}

/** 分支下拉菜单的内容：提示、搜索、分组的分支列表。只管显示，数据和切换由 BranchPicker 管 */
export function BranchMenuView({ data, loading, error, switching, query, onQuery, shared, onPick, onEscape }: MenuViewProps) {
  const groups = data ? branchGroups(data, query) : []
  const notices = data ? branchNotices({ blocked: data.blocked, dirty: data.dirty, shared, truncated: data.truncated }) : []
  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-line bg-page p-1.5 shadow-lg">
      {notices.map((n) => (
        <p key={n.text} className={`px-2.5 pb-1 pt-1 text-[11px] leading-relaxed ${n.tone === "warn" ? "text-yellow-500" : "text-fg-faint"}`}>{n.text}</p>
      ))}
      <div className="relative px-0.5 pb-1.5">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-2 text-fg-faint" />
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onEscape?.() }}
          placeholder="搜索分支…"
          className="w-full rounded-lg border border-line bg-surface py-1.5 pl-7 pr-2.5 text-[12.5px] outline-none focus:border-accent"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {(loading || (!data && !error)) && (
          <p className="flex items-center gap-1.5 px-2.5 py-3 text-xs text-fg-muted"><Loader2 size={13} className="animate-spin" />读取分支…</p>
        )}
        {data && groups.length === 0 && <p className="px-2.5 py-3 text-xs text-fg-muted">没有匹配的分支</p>}
        {groups.map((g) => (
          <div key={g.kind}>
            <p className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] text-fg-faint">{g.label}</p>
            {g.rows.map((row) => {
              const cur = !!row.option.current
              const busy = switching === row.key
              return (
                <button
                  key={row.key}
                  type="button"
                  disabled={row.disabled || (switching !== null && !busy)}
                  aria-current={cur ? "true" : undefined}
                  onClick={() => onPick(row.option)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-strong/40 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                >
                  {g.kind === "remote" ? <Cloud size={14} className="shrink-0 text-fg-muted" /> : <GitBranch size={14} className={`shrink-0 ${cur ? "text-accent" : "text-fg-muted"}`} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-fg-2">{row.option.name}</span>
                    {row.note && <span className="block truncate text-[10.5px] text-fg-faint">{row.note}</span>}
                  </span>
                  {busy ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" /> : cur && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              )
            })}
            {g.hidden > 0 && <p className="px-2.5 py-1 text-[10.5px] text-fg-faint">还有 {g.hidden} 个，输入关键字缩小范围</p>}
          </div>
        ))}
      </div>
      {error && <p className="mt-1 border-t border-line-subtle px-2.5 pb-1 pt-2 text-[11.5px] leading-relaxed text-danger">{error}</p>}
    </div>
  )
}

interface Props {
  sessionKey: string
  /** 会话列表上读到的当前分支（游离 HEAD 时是 HEAD(abc1234)） */
  branch: string
  /** 用这个目录的会话个数（含当前这个）：切换对它们都生效 */
  shared: number
  /** 这个目录里有会话正在回复：按钮置灰，打开菜单会说明原因 */
  working: boolean
  /** 切换成功：刷新会话列表上的分支 */
  onSwitched: () => void
  /** 切换失败而菜单已经关掉了（切的过程中点了别处）：失败原因没有地方显示，交给外面提示 */
  onError: (message: string) => void
}

/**
 * 输入框下方的分支选择：分支是工作目录的，所以和目录选择放在一起，不和模型挤在一行。
 * 项目会话不显示它（分支由项目管，项目栏里有）。
 */
export default function BranchPicker({ sessionKey, branch, shared, working, onSwitched, onError }: Props) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  openRef.current = open
  const [query, setQuery] = useState("")
  const [override, setOverride] = useState<BranchOverride | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useOutsideClose(open, rootRef, close)

  const menu = useBranchMenu(open, {
    load: () => window.electronAPI.appChatListBranches(sessionKey),
    switchTo: (target) => window.electronAPI.appChatSwitchBranch(sessionKey, target),
  })

  const label = shownBranch(branch, override, Date.now()) ?? branch
  const detached = isDetachedLabel(label)

  const pick = async (option: BranchOption) => {
    if (option.current) { close(); return }
    const r = await menu.choose(option)
    if (!r) return
    if (!r.ok) {
      if (!openRef.current) onError(r.error)
      return
    }
    setOverride(makeBranchOverride(branch, r.current, Date.now()))
    close()
    onSwitched()
  }

  return (
    <div className="relative min-w-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => { setQuery(""); setOpen((o) => !o) }}
        title={working ? "有会话正在这个目录里回复，暂时不能切换分支" : detached ? "游离 HEAD：不在任何分支上，点开可以切回某个分支" : "切换分支"}
        className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition ${open ? "border-accent bg-raised" : "border-line hover:border-line-strong"} ${working ? "text-fg-faint" : detached ? "text-yellow-500" : "text-fg-2"}`}
      >
        <GitBranch size={14} className="shrink-0 text-fg-muted" />
        <span className="truncate">{label}</span>
        {menu.switching ? <Loader2 size={12} className="shrink-0 animate-spin text-accent" /> : <ChevronDown size={12} className="shrink-0 text-fg-faint" />}
      </button>
      {open && (
        <BranchMenuView
          data={menu.data}
          loading={menu.loading}
          error={menu.error}
          switching={menu.switching}
          query={query}
          onQuery={setQuery}
          shared={shared}
          onPick={(o) => void pick(o)}
          onEscape={close}
        />
      )}
    </div>
  )
}
