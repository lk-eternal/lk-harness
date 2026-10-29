import { useEffect, useMemo } from "react"
import type { BuildDashboardTreeInput, DashboardChannelNode, DashboardSessionNode } from "../../../shared/dashboard-tree"
import type { ManagerListResult } from "../../../shared/managed-sessions"
import type { ModelChoice, ModelPickerSource } from "../chat/ModelPicker"
import SessionList from "./SessionList"
import { ALL_CHANNELS, buildAllSessionItems, resolveChannelSelection } from "./sessions-view"

export type SessionsScope = "channels" | "active"

/**
 * 工作台的两个会话功能区，共用同一套清单：
 * - channels（点「消息通道」卡）：所有通道的会话管理。上面一排通道切换：「全部」或某一个通道。
 * - active（点「活跃会话」卡）：跨通道、只看运行中的会话，行上标所属通道，没有通道切换。
 * 区别只在预设（看哪些通道、是不是只看运行中的）和工具栏上有哪些按钮，行和操作是同一套。
 */
export default function SessionsArea({
  scope,
  channels,
  channelId,
  onSelectChannel,
  managed,
  queue,
  modelPicker,
  modelSwitching,
  confirm,
  onNotice,
  onOpenChannelSettings,
  onAddFavorite,
  onSwitchModel,
  onStopSession,
  onDeleteSession,
  onActivateSession,
  onDeleteQueueItem,
}: {
  scope: SessionsScope
  channels: DashboardChannelNode[]
  /** channels 区选中的通道：ALL_CHANNELS 或通道 id（选中的通道没了会自动回到「全部」） */
  channelId: string
  onSelectChannel: (channelId: string) => void
  /** 别人的会话清单（磁盘上存着的，含空闲的）；由工作台持有，切换功能区时不丢 */
  managed: { result: ManagerListResult | null; refresh: () => Promise<void> }
  /** 全局消息队列：每个会话行上的排队消息从这里按会话键取 */
  queue: BuildDashboardTreeInput["queue"]
  modelPicker: ModelPickerSource
  modelSwitching?: string
  confirm: (title: string, message: string, ok?: string, cancel?: string) => Promise<boolean>
  /** 在提示条里说一句话（空串清掉） */
  onNotice: (message: string) => void
  onOpenChannelSettings: () => void
  onAddFavorite: (channelId: string) => void
  onSwitchModel: (sessionKey: string, m: ModelChoice) => void
  onStopSession: (sessionKey: string) => void
  onDeleteSession: (node: DashboardSessionNode) => void
  onActivateSession: (sessionKey: string) => void
  onDeleteQueueItem: (fileId: string) => void
}) {
  const { result, refresh } = managed
  const selected = scope === "channels" ? resolveChannelSelection(channels, channelId) : ALL_CHANNELS
  const channel = selected === ALL_CHANNELS ? undefined : channels.find((c) => c.channelId === selected)

  // 选中的通道被删 / 停用了：回到「全部」（工作台持有的选择也跟着改，下次进来不是空的）
  useEffect(() => {
    if (scope === "channels" && selected !== channelId) onSelectChannel(selected)
  }, [scope, selected, channelId, onSelectChannel])

  const items = useMemo(() => {
    const all = buildAllSessionItems({ channels: channel ? [channel] : channels, managed: result?.sessions ?? [], queue })
    return scope === "active" ? all.filter((i) => i.running) : all
  }, [scope, channel, channels, result, queue])

  if (scope === "channels" && channels.length === 0) return <NoChannels onOpenSettings={onOpenChannelSettings} />

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-sessions-scope={scope}>
      {scope === "channels" && channels.length > 1 && (
        <ChannelBar channels={channels} selected={selected} onSelect={onSelectChannel} />
      )}
      <SessionList
        mode={scope === "active" ? "active" : "manage"}
        showChannel={!channel && channels.length > 1}
        channelId={channel?.channelId}
        channelName={channel?.name}
        items={items}
        loaded={!!result?.ok}
        daemonRunning={!!result?.daemonRunning}
        loadError={result?.error}
        skipped={result?.skipped ?? 0}
        modelPicker={modelPicker}
        modelSwitching={modelSwitching}
        refresh={refresh}
        onNotice={onNotice}
        confirm={confirm}
        onAddFavorite={onAddFavorite}
        onSwitchModel={onSwitchModel}
        onStopSession={onStopSession}
        onDeleteSession={onDeleteSession}
        onActivateSession={onActivateSession}
        onDeleteQueueItem={onDeleteQueueItem}
      />
    </div>
  )
}

/** 没配任何通道：「消息通道」功能区的空状态，给一个去设置里添加的入口 */
export function NoChannels({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-fg-faint">
      <p>未配置消息通道</p>
      <button
        type="button"
        data-open-channel-settings
        onClick={onOpenSettings}
        className="rounded-lg bg-blue-600 px-4 py-2 text-xs text-white transition hover:bg-blue-500"
      >
        去设置里添加
      </button>
    </div>
  )
}

/** 通道切换条：「全部」+ 每个通道（带在线点）。选中的那个高亮 */
export function ChannelBar({
  channels,
  selected,
  onSelect,
}: {
  channels: readonly Pick<DashboardChannelNode, "channelId" | "name" | "connected">[]
  /** ALL_CHANNELS 或通道 id */
  selected: string
  onSelect: (channelId: string) => void
}) {
  const chip = (id: string, content: React.ReactNode) => (
    <button
      key={id}
      type="button"
      data-channel-tab={id}
      aria-pressed={id === selected}
      onClick={() => onSelect(id)}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${id === selected ? "border-blue-500/60 bg-blue-600/20 text-accent-soft" : "border-line text-fg-3 hover:text-fg"}`}
    >
      {content}
    </button>
  )
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label="选择通道">
      {chip(ALL_CHANNELS, "全部")}
      {channels.map((c) =>
        chip(
          c.channelId,
          <>
            <span className={`h-1.5 w-1.5 rounded-full ${c.connected ? "bg-success" : "bg-stronger"}`} />
            {c.name}
          </>,
        ),
      )}
    </div>
  )
}
