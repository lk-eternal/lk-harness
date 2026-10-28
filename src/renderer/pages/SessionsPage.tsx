import { useEffect, useMemo, useState } from "react"
import { X } from "lucide-react"
import type { DashboardChannelNode, DashboardSessionNode } from "../../shared/dashboard-tree"
import type { ModelChoice, ModelPickerSource } from "../components/chat/ModelPicker"
import useInlineModal from "../components/useInlineModal"
import MySessions from "../components/sessions/MySessions"
import OthersSessions from "../components/sessions/OthersSessions"
import { othersOf } from "../components/sessions/sessions-view"
import { useManagedSessions } from "../hooks/useManagedSessions"

type Tab = "others" | "mine"

/**
 * 会话管理页的正文（标题栏由工作台给）：选通道 → 看这个通道的会话。
 * 「其他人的会话」是别人（同事 / 服务台群）的全部会话，能改模型、重置、删除、批量清理；
 * 「我的会话」是主用户自己的会话 / 项目 / 任务，沿用原来消息通道树里的那些操作。
 */
export default function SessionsPage({
  channels,
  channelId,
  onSelectChannel,
  active,
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
  const [tab, setTab] = useState<Tab>("others")
  const { result, refresh } = useManagedSessions(active)
  const { showConfirm, ModalPortal } = useInlineModal()
  const channel = channels.find((c) => c.channelId === channelId)
  const others = useMemo(() => othersOf(result?.sessions ?? [], channelId), [result, channelId])

  // 选中的通道被删 / 停用了：回到第一个还在的
  useEffect(() => {
    if (!channel && channels.length > 0) onSelectChannel(channels[0].channelId)
  }, [channel, channels, onSelectChannel])

  if (!channel) {
    return <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">没有可管理的消息通道</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-2 pt-4">
        {channels.length > 1 && (
          <div className="flex gap-1">
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
        <div className="ml-auto flex gap-0.5 rounded-full border border-line bg-surface p-[3px]">
          {([
            ["others", `其他人的会话${result?.ok ? ` ${others.length}` : ""}`],
            ["mine", "我的会话"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-session-tab={id}
              onClick={() => setTab(id)}
              className={`rounded-full px-3.5 py-0.5 text-xs transition ${tab === id ? "bg-strong font-medium text-fg" : "text-fg-3 hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-6 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-danger-line bg-danger-tint/50 px-4 py-2 text-sm text-danger-soft">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={onDismissError} className="shrink-0 rounded px-1 text-danger hover:bg-danger-tint-strong/50 hover:text-danger-bright" title="关闭">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {tab === "others" ? (
          <OthersSessions
            channelId={channel.channelId}
            channelName={channel.name}
            sessions={others}
            loaded={!!result?.ok}
            daemonRunning={!!result?.daemonRunning}
            loadError={result?.error}
            skipped={result?.skipped ?? 0}
            modelPicker={modelPicker}
            refresh={refresh}
            onNotice={onNotice}
            confirm={showConfirm}
          />
        ) : (
          <MySessions
            channel={channel}
            modelPicker={modelPicker}
            modelSwitching={modelSwitching}
            onAddFavorite={onAddFavorite}
            onSwitchModel={onSwitchModel}
            onStopSession={onStopSession}
            onDeleteSession={onDeleteSession}
            onActivateSession={onActivateSession}
            onDeleteQueueItem={onDeleteQueueItem}
          />
        )}
      </div>
      {ModalPortal}
    </div>
  )
}
