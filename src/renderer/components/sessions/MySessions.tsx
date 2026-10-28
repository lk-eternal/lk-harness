import { useState } from "react"
import { Plus } from "lucide-react"
import { groupLabel, type DashboardChannelNode, type DashboardSessionNode } from "../../../shared/dashboard-tree"
import SessionRow from "../dashboard/SessionRow"
import type { ModelChoice, ModelPickerSource } from "../chat/ModelPicker"
import { visibleMyGroups } from "./sessions-view"

/**
 * 会话管理页的「我的会话」：主用户自己的会话 / 项目 / 任务，
 * 就是原来工作台消息通道树里的那些行（激活、停止、删除、改模型、排队消息、+ 常用目录），换了个地方。
 */
export default function MySessions({
  channel,
  modelPicker,
  modelSwitching,
  onAddFavorite,
  onSwitchModel,
  onStopSession,
  onDeleteSession,
  onActivateSession,
  onDeleteQueueItem,
}: {
  channel: DashboardChannelNode
  modelPicker: ModelPickerSource
  /** 正在切换模型的会话 */
  modelSwitching?: string
  onAddFavorite: (channelId: string) => void
  onSwitchModel: (sessionKey: string, m: ModelChoice) => void
  onStopSession: (sessionKey: string) => void
  onDeleteSession: (node: DashboardSessionNode) => void
  onActivateSession: (sessionKey: string) => void
  onDeleteQueueItem: (fileId: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const groups = visibleMyGroups(channel)

  return (
    <div className="space-y-3">
      {groups.map((gid) => {
        const sessions = channel.groups[gid].sessions
        return (
          <div key={gid} data-group={gid} className="overflow-hidden rounded-xl border border-line-subtle bg-surface/60">
            <div className="flex items-center gap-1.5 border-b border-line-subtle px-3 py-1.5 text-[11px] text-fg-muted">
              <span>{groupLabel(gid)}</span>
              <span className="text-fg-faint">{sessions.length}</span>
            </div>
            {sessions.map((node) => (
              <SessionRow
                key={node.sessionKey}
                node={node}
                modelPicker={modelPicker}
                modelSwitching={modelSwitching === node.sessionKey}
                expanded={expanded === node.sessionKey}
                onToggle={() => setExpanded((k) => (k === node.sessionKey ? null : node.sessionKey))}
                onSwitchModel={(m) => onSwitchModel(node.sessionKey, m)}
                onStop={node.running ? () => onStopSession(node.sessionKey) : undefined}
                onDelete={node.removable ? () => onDeleteSession(node) : undefined}
                onActivate={!node.running ? () => onActivateSession(node.sessionKey) : undefined}
                onDeleteQueueItem={onDeleteQueueItem}
              />
            ))}
            {sessions.length === 0 && gid === "main" && (
              <p className="px-3 py-4 text-center text-xs text-fg-faint">主用户还没有会话</p>
            )}
            {gid === "main" && (
              <button
                type="button"
                onClick={() => onAddFavorite(channel.channelId)}
                className="m-2 inline-flex items-center gap-0.5 rounded border border-dashed border-line px-2 py-1 text-[11px] text-fg-muted hover:border-blue-500 hover:text-accent-soft"
              >
                <Plus size={11} />常用目录
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
