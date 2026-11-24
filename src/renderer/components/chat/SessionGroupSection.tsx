import type { ReactNode } from "react"
import { Archive, ChevronDown, ChevronUp, FolderKanban, Loader2, MessageCircle } from "lucide-react"
import {
  SESSION_GROUP_TITLES,
  summarizeStatus,
  viewGroup,
  type GroupFooter,
  type GroupLevel,
  type GroupRowStatus,
  type SessionListGroupId,
} from "../../../shared/session-groups"
import type { SessionGroupControl } from "./session-groups-state"

/** 桌面端会话栏和手机端抽屉共用同一个分类标题和底部按钮，只是触控尺寸不同 */
export type SessionGroupVariant = "desktop" | "mobile"

const STYLE: Record<SessionGroupVariant, { wrap: string; head: string; footer: string; icon: number; body: string; rows: string }> = {
  desktop: {
    wrap: "pt-3",
    head: "rounded-lg px-2.5 py-1.5 hover:brightness-125",
    footer: "rounded-lg px-2.5 py-1.5 hover:bg-strong/25 hover:text-fg-2",
    icon: 12,
    body: "ml-3 mt-1 border-l-2 pl-1",
    rows: "space-y-0.5",
  },
  mobile: {
    wrap: "",
    head: "rounded-xl px-3 py-2 active:brightness-125",
    footer: "rounded-xl px-3 py-2 active:bg-raised",
    icon: 13,
    body: "ml-3 mt-1 border-l-2 pl-1",
    rows: "space-y-1",
  },
}

const GROUP_ICON = { project: FolderKanban, chat: MessageCircle, archived: Archive }

/** 每一类自己的颜色：标题是一条带底色的胶囊，下面的行左边有一道同色竖线，一眼分得出哪几行属于哪一类 */
const GROUP_LOOK: Record<SessionListGroupId, { head: string; bar: string }> = {
  project: { head: "bg-accent/20 text-accent", bar: "border-accent/40" },
  chat: { head: "bg-teal/20 text-teal", bar: "border-teal/40" },
  archived: { head: "bg-strong/40 text-fg-3", bar: "border-line-strong" },
}

/** 收起的会话里有在回复的、有新回复没看的：折叠后看不到行上的转圈和绿点，在标题 / 底部按钮上补一个 */
function HiddenMark({ status }: { status: GroupRowStatus }) {
  if (status === "working") return <Loader2 size={11} role="img" aria-label="有会话正在回复" className="shrink-0 animate-spin text-accent" />
  if (status === "unread") return <span role="img" aria-label="有会话有新回复" className="h-2 w-2 shrink-0 rounded-full bg-success" />
  return null
}

function footerLabel(footer: GroupFooter, hiddenCount: number): string {
  if (footer.kind === "less") return "收起"
  return `${footer.kind === "more" ? "展开更多" : "展开全部"}（还有 ${hiddenCount} 个）`
}

/** 一类会话：标题（点了整类折叠 / 展开）+ 行 + 底部的展开按钮。要画哪些行由 viewGroup 算好，见 renderSessionGroup */
export default function SessionGroupSection({ group, count, collapsed, footer, hiddenCount, hiddenStatus, variant, onToggle, onFooter, children }: {
  group: SessionListGroupId
  /** 这一类一共几个会话（折叠、收起的也算） */
  count: number
  collapsed: boolean
  footer: GroupFooter | null
  hiddenCount: number
  hiddenStatus: GroupRowStatus
  variant: SessionGroupVariant
  onToggle: () => void
  onFooter: (to: GroupLevel) => void
  children: ReactNode
}) {
  const style = STYLE[variant]
  const look = GROUP_LOOK[group]
  const Icon = GROUP_ICON[group]
  return (
    <div data-session-group={group} className={style.wrap}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={`flex w-full items-center gap-1.5 text-left text-[12px] font-semibold transition ${style.head} ${look.head}`}
      >
        <Icon size={style.icon} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{SESSION_GROUP_TITLES[group]}</span>
        {collapsed && <HiddenMark status={hiddenStatus} />}
        <span className="shrink-0 text-[11px] font-normal opacity-70">{count}</span>
        <ChevronDown size={style.icon} className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-180"}`} />
      </button>
      {!collapsed && (
        <div className={`${style.body} ${look.bar}`}>
          <div className={style.rows}>{children}</div>
          {footer && (
            <button
              type="button"
              data-session-group-footer={footer.kind}
              onClick={() => onFooter(footer.to)}
              className={`flex w-full items-center gap-1.5 text-left text-[11px] text-fg-faint transition ${style.footer}`}
            >
              {footer.kind === "less" ? <ChevronUp size={style.icon} className="shrink-0" /> : <ChevronDown size={style.icon} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{footerLabel(footer, hiddenCount)}</span>
              <HiddenMark status={hiddenStatus} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 画一类会话。这是个普通函数、不是组件：行要作为 children 在调用方这一层就建好，
 * 调用方（手机端抽屉）才能像以前一样直接当函数调用来测，不必真的渲染。
 * rows 已经排好序（置顶的在前）；这一类没有会话就什么都不画。
 */
export function renderSessionGroup<T extends { sessionKey: string }>({ id, group, rows, control, isPinned, statusOf, renderRow, renderPinned, variant }: {
  /** React key：同一类在多个通道下各画一份时要不同 */
  id: string
  group: SessionListGroupId
  rows: readonly T[]
  control: SessionGroupControl
  isPinned: (row: T) => boolean
  statusOf: (row: T) => GroupRowStatus
  renderRow: (row: T) => ReactNode
  /** 置顶的几行怎么一起画（桌面端是一个可拖动换位置的列表）；不给就和别的行一样一行行画 */
  renderPinned?: (pinned: T[]) => ReactNode
  variant: SessionGroupVariant
}): ReactNode {
  if (rows.length === 0) return null
  const view = viewGroup(rows, control.states[group], { isPinned, keep: (row) => control.isRevealed(row.sessionKey) })
  const drawShown = (): ReactNode => {
    if (!renderPinned) return view.shown.map(renderRow)
    const pinned = view.shown.filter(isPinned)
    return (
      <>
        {pinned.length > 0 && renderPinned(pinned)}
        {view.shown.filter((row) => !isPinned(row)).map(renderRow)}
      </>
    )
  }
  return (
    <SessionGroupSection
      key={id}
      group={group}
      count={rows.length}
      collapsed={view.collapsed}
      footer={view.footer}
      hiddenCount={view.hidden.length}
      hiddenStatus={summarizeStatus(view.hidden, statusOf)}
      variant={variant}
      onToggle={() => {
        control.clearReveal()
        control.change(group, { collapsed: !view.collapsed })
      }}
      onFooter={(to) => {
        control.clearReveal()
        control.change(group, { level: to })
      }}
    >
      {drawShown()}
    </SessionGroupSection>
  )
}
