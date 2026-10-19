import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Plus } from "lucide-react"
import {
  GROUP_IDS,
  groupLabel,
  type DashboardChannelNode,
  type DashboardSessionNode,
} from "../../../shared/dashboard-tree"
import SessionRow from "./SessionRow"

export default function ChannelTree({
  channels,
  quickModels,
  modelSwitching,
  onAddFavorite,
  onSwitchModel,
  onAddFavoriteModel,
  onRemoveFavoriteModel,
  onStopSession,
  onDeleteSession,
  onActivateSession,
  onDeleteQueueItem,
}: {
  channels: DashboardChannelNode[]
  quickModels: { model: string; modelParams?: string; label?: string }[]
  modelSwitching?: string
  onAddFavorite?: (channelId: string) => void
  onSwitchModel: (sessionKey: string, m: { model: string; modelParams?: string }) => void
  onAddFavoriteModel?: () => void
  onRemoveFavoriteModel?: (m: { model: string; modelParams?: string }) => void
  onStopSession: (sessionKey: string) => void
  onDeleteSession: (node: DashboardSessionNode) => void
  onActivateSession: (sessionKey: string) => void
  onDeleteQueueItem: (fileId: string) => void
}) {
  const [collapsedCh, setCollapsedCh] = useState<Record<string, boolean>>({})
  const [expandedSession, setExpandedSession] = useState<string | null>(null)

  const defaultCollapsed = useMemo(() => {
    const ch: Record<string, boolean> = {}
    for (const c of channels) {
      if (!c.connected) ch[c.channelId] = true
    }
    return ch
  }, [channels])

  const isChCollapsed = (id: string) => collapsedCh[id] ?? defaultCollapsed[id] ?? false

  if (channels.length === 0) {
    return <div className="px-3 py-6 text-center text-xs text-fg-faint">未配置消息通道</div>
  }

  return (
    <div>
      {channels.map((c) => {
        const chCollapsed = isChCollapsed(c.channelId)
        // 主用户组常驻（承载「+ 常用目录」入口），其余组有会话才出现
        const groups = GROUP_IDS.filter((gid) => gid === "main" || c.groups[gid].sessions.length > 0)
        return (
          <div key={c.channelId} className="border-b border-line-subtle last:border-b-0">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface/50"
              onClick={() => setCollapsedCh((s) => ({ ...s, [c.channelId]: !chCollapsed }))}
            >
              {chCollapsed ? <ChevronRight size={14} className="text-fg-muted" /> : <ChevronDown size={14} className="text-fg-muted" />}
              <span className={`h-1.5 w-1.5 rounded-full ${c.connected ? "bg-success" : "bg-stronger"}`} />
              <span className="font-medium text-fg-soft">{c.name}</span>
              <span className="text-[11px] text-fg-muted">{c.connected ? "在线" : "离线"}</span>
            </button>
            {!chCollapsed && (
              <div className="space-y-1.5 px-3 pb-2">
                {groups.map((gid) => {
                  const sessions = c.groups[gid].sessions
                  return (
                    <div key={gid} className="rounded border border-line-subtle/70">
                      <div className="flex items-center gap-1.5 border-b border-line-subtle/70 bg-surface/40 px-2 py-1 text-[11px] text-fg-muted">
                        <span>{groupLabel(gid)}</span>
                        <span className="text-fg-faint">{sessions.length}</span>
                      </div>
                      {sessions.map((node) => (
                        <SessionRow
                          key={node.sessionKey}
                          node={node}
                          quickModels={quickModels}
                          modelSwitching={modelSwitching}
                          expanded={expandedSession === node.sessionKey}
                          onToggle={() => setExpandedSession((k) => k === node.sessionKey ? null : node.sessionKey)}
                          onSwitchModel={(m) => onSwitchModel(node.sessionKey, m)}
                          onAddFavoriteModel={onAddFavoriteModel}
                          onRemoveFavoriteModel={onRemoveFavoriteModel}
                          onStop={node.running ? () => onStopSession(node.sessionKey) : undefined}
                          onDelete={node.removable ? () => onDeleteSession(node) : undefined}
                          onActivate={!node.running ? () => onActivateSession(node.sessionKey) : undefined}
                          onDeleteQueueItem={onDeleteQueueItem}
                        />
                      ))}
                      {gid === "main" && onAddFavorite && (
                        <button
                          type="button"
                          onClick={() => onAddFavorite(c.channelId)}
                          className="m-1.5 inline-flex items-center gap-0.5 rounded border border-dashed border-line px-2 py-1 text-[11px] text-fg-muted hover:border-blue-500 hover:text-accent-soft"
                        >
                          <Plus size={11} />常用目录
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
