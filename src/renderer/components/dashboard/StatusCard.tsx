import type { KeyboardEvent, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import type { DashboardTab } from "./dashboard-view"

export type StatusColor = "green" | "red" | "blue" | "yellow" | "gray"

const TEXT: Record<StatusColor, string> = {
  green: "text-success",
  red: "text-danger",
  blue: "text-accent",
  yellow: "text-warning",
  gray: "text-fg-muted",
}

const DOT: Record<StatusColor, string> = {
  green: "bg-success",
  red: "bg-danger",
  blue: "bg-accent",
  yellow: "bg-warning",
  gray: "bg-stronger",
}

/** 页签和它的功能区互相指：页签 id / 功能区 id */
export const tabDomId = (tab: DashboardTab) => `dash-tab-${tab}`
export const paneDomId = (tab: DashboardTab) => `dash-pane-${tab}`

/**
 * 卡片下面的功能区：同一时刻只有选中的页签可见。
 * keepMounted 的功能区（日志）切走时不卸载，只用 visibility 藏起来——不能用 display:none，
 * 那会让滚动容器失去布局、滚动位置回到顶部；藏着的时候内容照常累积，切回来位置还在。
 * 其余功能区只在选中时才渲染（没人看的时候不读磁盘、不轮询）。
 */
export function TabPane({ tab, selected, children }: { tab: DashboardTab; selected: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={paneDomId(tab)}
      aria-labelledby={tabDomId(tab)}
      aria-hidden={!selected}
      data-dash-pane={tab}
      data-selected={selected}
      className={`absolute inset-0 flex flex-col px-6 pb-4 ${selected ? "" : "pointer-events-none invisible"}`}
    >
      {children}
    </div>
  )
}

/**
 * 工作台顶部的状态卡片，同时是页签：点击选中，选中的卡片高亮，下面的功能区显示它的内容。
 * 卡片里的操作按钮（启动 / 停止 / 清空 …）点了只做自己的事，不会顺带切换页签。
 */
export default function StatusCard({
  tab,
  icon: Icon,
  label,
  value,
  color,
  sub,
  action,
  selected,
  onSelect,
}: {
  tab: DashboardTab
  icon: LucideIcon
  label: string
  value: ReactNode
  color: StatusColor
  sub?: string
  action?: ReactNode
  selected: boolean
  onSelect: () => void
}) {
  // 只响应卡片自己获得焦点时的回车 / 空格；焦点在里面的按钮上时，按键归按钮
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onSelect()
    }
  }
  return (
    <div
      role="tab"
      id={tabDomId(tab)}
      aria-selected={selected}
      aria-controls={paneDomId(tab)}
      tabIndex={0}
      data-dash-tab={tab}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`flex h-[88px] cursor-pointer flex-col rounded-lg border p-3 transition ${
        selected ? "border-blue-500/60 bg-blue-600/10" : "border-line-subtle hover:border-line hover:bg-surface/40"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={TEXT[color]} />
          <span className={`text-xs ${selected ? "text-fg-2" : "text-fg-muted"}`}>{label}</span>
        </div>
        <div className="min-w-0" onClick={(e) => e.stopPropagation()}>{action}</div>
      </div>
      <div className="mt-auto">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 shrink-0 rounded-full ${DOT[color]}`} />
          <span className={`text-sm font-medium ${TEXT[color]}`}>{value}</span>
        </div>
        <div className="mt-1 h-4 truncate text-xs text-fg-faint">{sub ?? "\u00A0"}</div>
      </div>
    </div>
  )
}
