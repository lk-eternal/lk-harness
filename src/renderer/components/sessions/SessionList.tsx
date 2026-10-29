import { useMemo, useState } from "react"
import { BrushCleaning, Plus, Search } from "lucide-react"
import type { DashboardSessionNode } from "../../../shared/dashboard-tree"
import type { ManagedSession, ManagerOpResult } from "../../../shared/managed-sessions"
import type { ModelChoice, ModelPickerSource } from "../chat/ModelPicker"
import CleanupDialog from "./CleanupDialog"
import SessionListRow from "./SessionListRow"
import { SESSION_TYPE_ICON } from "./SessionTypeIcon"
import {
  deleteConfirmText,
  filterChips,
  filterSessionItems,
  resetConfirmText,
  restoreConfirmText,
  resolveFilter,
  type ListFilter,
  type SessionItem,
} from "./sessions-view"

/**
 * 工作台会话功能区的会话清单：所有会话画成一张清单——主用户自己的、项目、任务，以及别人的私聊和群
 * （不只是正在运行的）。靠行首图标区分是谁的，不分页签。
 *
 * 别人的会话：改模型、恢复默认、重置、停止、删除，以及批量清理久未使用的；
 * 主用户自己的：激活、停止、删除、改模型，沿用工作台的那一套（由外面传回调进来）。
 * 别人的会话清单由外面的 useManagedSessions 提供；别人会话的每个操作做完都会刷新清单。
 *
 * 两种用法共用这一个组件（工作台的两个功能区）：
 * - manage（消息通道）：一个通道、或「全部」通道的会话；有「+ 常用目录」和批量清理，这两个按通道做，没选定通道时置灰。
 * - active（活跃会话）：外面已经只留了运行中的会话、跨通道；没有「运行中」标签，也没有按通道做的那两个按钮。
 * 清单高度撑满外面给的空间：搜索栏固定，清单自己滚动。
 */
export default function SessionList({
  mode = "manage",
  showChannel = false,
  channelId,
  channelName,
  items,
  loaded,
  daemonRunning,
  loadError,
  skipped,
  modelPicker,
  modelSwitching,
  refresh,
  onNotice,
  confirm,
  onAddFavorite,
  onSwitchModel,
  onStopSession,
  onDeleteSession,
  onActivateSession,
  onDeleteQueueItem,
}: {
  mode?: "manage" | "active"
  /** 行上标出所属通道（清单里混着多个通道时） */
  showChannel?: boolean
  /** 正在看哪个通道；不传 = 跨通道（「全部」/ 活跃会话） */
  channelId?: string
  channelName?: string
  /** 已经合好的清单（buildSessionItems / buildAllSessionItems） */
  items: SessionItem[]
  /** 别人的会话清单至少成功拉过一次 */
  loaded: boolean
  daemonRunning: boolean
  loadError?: string
  /** 磁盘上有、但找不到所属通道的会话个数 */
  skipped: number
  modelPicker: ModelPickerSource
  /** 工作台那边正在切换模型的会话（主用户自己的会话走工作台的切换） */
  modelSwitching?: string
  refresh: () => Promise<void>
  /** 在页面顶部的提示条里显示一句话（空串清掉） */
  onNotice: (message: string) => void
  confirm: (title: string, message: string, ok?: string, cancel?: string) => Promise<boolean>
  onAddFavorite: (channelId: string) => void
  onSwitchModel: (sessionKey: string, m: ModelChoice) => void
  onStopSession: (sessionKey: string) => void
  onDeleteSession: (node: DashboardSessionNode) => void
  onActivateSession: (sessionKey: string) => void
  onDeleteQueueItem: (fileId: string) => void
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<ListFilter>("all")
  /** 正在操作的别人的会话 key；同一时刻只做一个，避免连点 */
  const [busyKey, setBusyKey] = useState("")
  const [cleanupOpen, setCleanupOpen] = useState(false)
  /** 展开着排队消息的那一行 */
  const [queueOpenKey, setQueueOpenKey] = useState("")
  const isActive = mode === "active"
  const chips = useMemo(() => filterChips(items, { running: !isActive }), [items, isActive])
  const activeFilter = resolveFilter(filter, chips)
  const shown = useMemo(() => filterSessionItems(items, { query, filter: activeFilter }), [items, query, activeFilter])
  const othersCount = items.filter((i) => i.owner === "others").length
  const now = Date.now()

  const run = async (key: string, fn: () => Promise<ManagerOpResult>) => {
    if (busyKey) return
    setBusyKey(key)
    try {
      const r = await fn()
      if (!r.ok) onNotice(r.error ?? "操作失败")
      else onNotice(r.warning ? `已完成，但：${r.warning}` : "")
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyKey("")
      await refresh()
    }
  }

  const switchModel = (item: SessionItem, m: ModelChoice) => {
    if (item.owner === "mine") return onSwitchModel(item.sessionKey, m)
    return run(item.sessionKey, async () => {
      const r = await window.electronAPI.setSessionModel(item.sessionKey, m.model, m.modelParams, m.resourceId)
      return { ok: r.ok, error: r.error }
    })
  }

  const stop = (item: SessionItem) => {
    if (item.owner === "mine") return onStopSession(item.sessionKey)
    return run(item.sessionKey, async () => {
      const r = await window.electronAPI.stopSessionAgent(item.sessionKey)
      return { ok: r.ok, error: r.ok ? undefined : "停止失败" }
    })
  }

  // 恢复默认 / 重置只有别人的会话有（rowCapabilities），主用户的会话不会走到这两个
  const restore = async (s: ManagedSession) => {
    if (!(await confirm("恢复默认模型", restoreConfirmText(s), "恢复", "取消"))) return
    await run(s.sessionKey, () => window.electronAPI.restoreSessionDefault(s.sessionKey))
  }

  const reset = async (s: ManagedSession) => {
    if (!(await confirm("重置会话", resetConfirmText(s), "重置", "取消"))) return
    await run(s.sessionKey, () => window.electronAPI.resetManagedSession(s.sessionKey))
  }

  const remove = async (item: SessionItem) => {
    if (item.owner === "mine") return onDeleteSession(item.node)
    if (!(await confirm("删除会话", deleteConfirmText(item.managed), "删除", "取消"))) return
    await run(item.sessionKey, () => window.electronAPI.deleteManagedSession(item.sessionKey))
  }

  /** 常用目录和批量清理都是按一个通道做的：没选定通道（「全部」）时点不了，说明原因 */
  const needChannelHint = "这个操作按通道做，先在上方选一个通道"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative flex min-w-[180px] max-w-xs flex-1 items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-fg-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜名字 / 最后一句话 / 目录"
            aria-label="搜索会话"
            className="w-full rounded-lg border border-line bg-surface py-1 pl-7 pr-2 text-xs text-fg placeholder:text-fg-faint"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {chips.map((c) => {
            const Icon = c.id === "all" || c.id === "running" ? undefined : SESSION_TYPE_ICON[c.id]
            return (
              <button
                key={c.id}
                type="button"
                data-session-filter={c.id}
                onClick={() => setFilter(c.id)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition ${activeFilter === c.id ? "border-blue-500/60 bg-blue-600/20 text-accent-soft" : "border-line text-fg-3 hover:text-fg"}`}
              >
                {Icon && <Icon size={11} aria-hidden="true" />}
                {c.label}
                <span className="text-fg-faint">{c.count}</span>
              </button>
            )
          })}
        </div>
        {!isActive && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => { if (channelId) onAddFavorite(channelId) }}
              disabled={!channelId}
              className="inline-flex items-center gap-1 rounded-lg border border-dashed border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft disabled:opacity-40"
              title={channelId ? "给主用户加一个常用工作目录" : needChannelHint}
            >
              <Plus size={12} />常用目录
            </button>
            <button
              type="button"
              onClick={() => setCleanupOpen(true)}
              disabled={!channelId || !loaded || othersCount === 0}
              className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft disabled:opacity-40"
              title={channelId ? "按天数批量清理久未使用的会话（只清别人的，主用户、项目、任务不会动）" : needChannelHint}
            >
              <BrushCleaning size={12} />清理久未使用…
            </button>
          </div>
        )}
      </div>

      {loadError && <p className="shrink-0 text-xs text-danger-soft">{loadError}</p>}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface/60">
        <div className="flex shrink-0 items-center justify-between border-b border-line-subtle px-3 py-1.5 text-[11px] text-fg-muted">
          <span>{isActive ? "运行中的会话" : "会话"}</span>
          <span>{shown.length === items.length ? `${items.length} 个` : `${shown.length} / ${items.length} 个`}</span>
        </div>
        <div data-session-scroll className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-fg-faint">
              {!loaded
                ? (loadError ? "会话清单加载失败" : "正在加载…")
                : isActive
                  ? "当前没有运行中的会话"
                  : `${channelId ? "这个通道还" : "还"}没有会话，主用户或别人给机器人发过消息后会出现在这里`}
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-fg-faint">没有符合条件的会话</p>
          ) : (
            shown.map((item) => (
              <SessionListRow
                key={item.sessionKey}
                item={item}
                now={now}
                activityKnown={loaded}
                showChannel={showChannel}
                modelPicker={modelPicker}
                busy={busyKey === item.sessionKey}
                switching={busyKey === item.sessionKey || modelSwitching === item.sessionKey}
                blocked={!!busyKey}
                daemonRunning={daemonRunning}
                queueOpen={queueOpenKey === item.sessionKey}
                onToggleQueue={() => setQueueOpenKey((k) => (k === item.sessionKey ? "" : item.sessionKey))}
                onSwitchModel={(m) => void switchModel(item, m)}
                onStop={() => void stop(item)}
                onActivate={() => onActivateSession(item.sessionKey)}
                onRestore={() => { if (item.owner === "others") void restore(item.managed) }}
                onReset={() => { if (item.owner === "others") void reset(item.managed) }}
                onDelete={() => void remove(item)}
                onDeleteQueueItem={onDeleteQueueItem}
              />
            ))
          )}
          {!loaded && items.length > 0 && (
            <p className="border-t border-line-subtle/80 px-3 py-2 text-center text-[11px] text-fg-faint">
              {loadError ? "别人的会话加载失败" : "别人的会话正在加载…"}
            </p>
          )}
        </div>
      </div>

      {skipped > 0 && !isActive && (
        <p className="shrink-0 text-[11px] text-fg-faint">另有 {skipped} 个会话找不到所属通道（通道已删除或旧格式），这里不显示。</p>
      )}

      {cleanupOpen && channelId && (
        <CleanupDialog
          channelId={channelId}
          channelName={channelName ?? ""}
          daemonRunning={daemonRunning}
          confirm={confirm}
          onClose={() => setCleanupOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  )
}
