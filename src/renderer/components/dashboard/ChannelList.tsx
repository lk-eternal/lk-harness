import { ChevronRight } from "lucide-react"
import type { DashboardChannelNode } from "../../../shared/dashboard-tree"
import { channelRunningCount } from "../sessions/sessions-view"

/** 工作台「消息通道」卡片展开后的一级列表：每个通道一行（名称 / 在线状态 / 运行中个数），会话本身到会话管理页里看 */
export default function ChannelList({
  channels,
  onManage,
}: {
  channels: DashboardChannelNode[]
  onManage: (channelId: string) => void
}) {
  if (channels.length === 0) {
    return <div className="px-3 py-6 text-center text-xs text-fg-faint">未配置消息通道</div>
  }
  return (
    <div>
      {channels.map((c) => {
        const running = channelRunningCount(c)
        return (
          <button
            key={c.channelId}
            type="button"
            data-channel-row={c.channelId}
            onClick={() => onManage(c.channelId)}
            className="flex w-full items-center gap-2 border-b border-line-subtle px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface/50"
            title="打开这个通道的会话管理"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.connected ? "bg-success" : "bg-stronger"}`} />
            <span className="font-medium text-fg-soft">{c.name}</span>
            <span className="text-[11px] text-fg-muted">{c.connected ? "在线" : "离线"}</span>
            {running > 0 && <span className="rounded bg-green-600/20 px-1 text-[10px] text-success">运行 {running}</span>}
            <span className="ml-auto inline-flex items-center gap-0.5 text-xs text-accent-soft">
              管理会话<ChevronRight size={12} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
