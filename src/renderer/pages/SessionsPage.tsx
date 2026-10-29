import { useEffect, useMemo } from "react"
import { X } from "lucide-react"
import type { BuildDashboardTreeInput, DashboardChannelNode, DashboardSessionNode } from "../../shared/dashboard-tree"
import type { ModelChoice, ModelPickerSource } from "../components/chat/ModelPicker"
import useInlineModal from "../components/useInlineModal"
import SessionList from "../components/sessions/SessionList"
import { buildSessionItems } from "../components/sessions/sessions-view"
import { useManagedSessions } from "../hooks/useManagedSessions"

/**
 * 会话管理页的正文（标题栏由工作台给）：选通道 → 看这个通道的全部会话。
 * 主用户自己的会话 / 项目 / 任务和别人的私聊 / 群在同一张清单里，行首的图标区分是哪一类；
 * 别人的会话能改模型、重置、删除、批量清理，主用户自己的沿用原来消息通道树里的那些操作。
 */
export default function SessionsPage({
  channels,
  channelId,
  onSelectChannel,
  active,
  queue,
  modelPicker,
  modelSwitching,
  error,
  onDismissError,
  onNotice,
  onAddFavorite,
  onSwitchModel,
  onStopSession,
  onDeleteSession,
  onActivateSession,
  onDeleteQueueItem,
}: {
  channels: DashboardChannelNode[]
  channelId: string
  onSelectChannel: (channelId: string) => void
  /** 页面当前可见：不可见时不刷新清单 */
  active: boolean
  /** 全局消息队列：每个会话行上的排队消息从这里按会话键取 */
  queue: BuildDashboardTreeInput["queue"]
  modelPicker: ModelPickerSource
  modelSwitching?: string
  error: string
  onDismissError: () => void
  /** 在提示条里说一句话（空串清掉） */
  onNotice: (message: string) => void
  onAddFavorite: (channelId: string) => void
  onSwitchModel: (sessionKey: string, m: ModelChoice) => void
  onStopSession: (sessionKey: string) => void
  onDeleteSession: (node: DashboardSessionNode) => void
  onActivateSession: (sessionKey: string) => void
  onDeleteQueueItem: (fileId: string) => void
}) {
  const { result, refresh } = useManagedSessions(active)
  const { showConfirm, ModalPortal } = useInlineModal()
  const channel = channels.find((c) => c.channelId === channelId)
  const items = useMemo(
    () => (channel ? buildSessionItems({ channelId, groups: channel.groups, managed: result?.sessions ?? [], queue }) : []),
    [channel, channelId, result, queue],
  )

  // 选中的通道被删 / 停用了：回到第一个还在的
  useEffect(() => {
    if (!channel && channels.length > 0) onSelectChannel(channels[0].channelId)
  }, [channel, channels, onSelectChannel])

  if (!channel) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">没有可管理的消息通道</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {channels.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-6 pb-2 pt-4">
          {channels.map((c) => (
            <button
              key={c.channelId}
              type="button"
              data-channel-tab={c.channelId}
              onClick={() => onSelectChannel(c.channelId)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${c.channelId === channelId ? "border-blue-500/60 bg-blue-600/20 text-accent-soft" : "border-line text-fg-3 hover:text-fg"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${c.connected ? "bg-success" : "bg-stronger"}`} />
              {c.name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className={`mx-6 mb-2 flex shrink-0 ${channels.length > 1 ? "" : "mt-4"} items-start gap-2 rounded-lg border border-danger-line bg-danger-tint/50 px-4 py-2 text-sm text-danger-soft`}>
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={onDismissError} className="shrink-0 rounded px-1 text-danger hover:bg-danger-tint-strong/50 hover:text-danger-bright" title="关闭">
            <X size={14} />
          </button>
        </div>
      )}

      <div className={`min-h-0 flex-1 overflow-y-auto px-6 pb-6 ${channels.length > 1 || error ? "" : "pt-4"}`}>
        <SessionList
          channelId={channel.channelId}
          channelName={channel.name}
          items={items}
          loaded={!!result?.ok}
          daemonRunning={!!result?.daemonRunning}
          loadError={result?.error}
          skipped={result?.skipped ?? 0}
          modelPicker={modelPicker}
          modelSwitching={modelSwitching}
          refresh={refresh}
          onNotice={onNotice}
          confirm={showConfirm}
          onAddFavorite={onAddFavorite}
          onSwitchModel={onSwitchModel}
          onStopSession={onStopSession}
          onDeleteSession={onDeleteSession}
          onActivateSession={onActivateSession}
          onDeleteQueueItem={onDeleteQueueItem}
        />
      </div>
      {ModalPortal}
    </div>
  )
}
