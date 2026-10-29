import { CircleHelp, Clock, Crown, Package, User, Users, type LucideIcon } from "lucide-react"
import { SESSION_TYPE_LABEL, type SessionType } from "./sessions-view"

export const SESSION_TYPE_ICON: Record<SessionType, LucideIcon> = {
  main: Crown,
  p2p: User,
  group: Users,
  project: Package,
  task: Clock,
  other: CircleHelp,
}

/** 行首的类型图标：主用户 / 私聊 / 群 / 项目 / 任务；悬停和读屏都说类型名 */
export default function SessionTypeIcon({ type, size = 12 }: { type: SessionType; size?: number }) {
  const Icon = SESSION_TYPE_ICON[type]
  const label = SESSION_TYPE_LABEL[type]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-session-type-icon={type}
      className={`inline-flex shrink-0 items-center justify-center rounded bg-raised p-1 ${type === "main" ? "text-accent-soft" : "text-fg-3"}`}
    >
      <Icon size={size} aria-hidden="true" />
    </span>
  )
}
