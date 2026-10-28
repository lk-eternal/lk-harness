import { useMemo, useState } from "react"
import { BrushCleaning, Eraser, RotateCcw, Search, Square, Trash2 } from "lucide-react"
import type { ManagedSession, ManagerOpResult } from "../../../shared/managed-sessions"
import { modelSlug } from "../../model-utils"
import ModelPicker, { type ModelChoice, type ModelPickerSource } from "../chat/ModelPicker"
import CleanupDialog from "./CleanupDialog"
import {
  DAEMON_DOWN_HINT,
  chatTag,
  deleteConfirmText,
  filterOthers,
  lastActiveText,
  overrideBadge,
  resetConfirmText,
  restoreConfirmText,
  type ChatFilter,
} from "./sessions-view"

const FILTERS: { id: ChatFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "p2p", label: "私聊" },
  { id: "group", label: "群" },
  { id: "running", label: "运行中" },
]

const iconBtn = "rounded p-1 transition disabled:opacity-40"

/**
 * 会话管理页的「其他人的会话」：这个通道里所有别人的会话（不只是正在运行的），
 * 可以改模型、恢复默认、重置、停止、删除，以及批量清理久未使用的。
 * 清单由外面的 useManagedSessions 提供；每个操作做完都会刷新清单。
 */
export default function OthersSessions({
  channelId,
  channelName,
  sessions,
  loaded,
  daemonRunning,
  loadError,
  skipped,
  modelPicker,
  refresh,
  onNotice,
  confirm,
}: {
  channelId: string
  channelName: string
  /** 已经按通道、人群筛好的（othersOf） */
  sessions: ManagedSession[]
  /** 清单至少成功拉过一次 */
  loaded: boolean
  daemonRunning: boolean
  loadError?: string
  /** 磁盘上有、但找不到所属通道的会话个数 */
  skipped: number
  modelPicker: ModelPickerSource
  refresh: () => Promise<void>
  /** 在页面顶部的提示条里显示一句话（空串清掉） */
  onNotice: (message: string) => void
  confirm: (title: string, message: string, ok?: string, cancel?: string) => Promise<boolean>
}) {
  const [query, setQuery] = useState("")
  const [chat, setChat] = useState<ChatFilter>("all")
  /** 正在操作的会话 key；同一时刻只做一个，避免连点 */
  const [busyKey, setBusyKey] = useState("")
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const shown = useMemo(() => filterOthers(sessions, { query, chat }), [sessions, query, chat])
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

  const switchModel = (s: ManagedSession, m: ModelChoice) =>
    run(s.sessionKey, async () => {
      const r = await window.electronAPI.setSessionModel(s.sessionKey, m.model, m.modelParams, m.resourceId)
      return { ok: r.ok, error: r.error }
    })

  const stop = (s: ManagedSession) =>
    run(s.sessionKey, async () => {
      const r = await window.electronAPI.stopSessionAgent(s.sessionKey)
      return { ok: r.ok, error: r.ok ? undefined : "停止失败" }
    })

  const restore = async (s: ManagedSession) => {
    if (!(await confirm("恢复默认模型", restoreConfirmText(s), "恢复", "取消"))) return
    await run(s.sessionKey, () => window.electronAPI.restoreSessionDefault(s.sessionKey))
  }

  const reset = async (s: ManagedSession) => {
    if (!(await confirm("重置会话", resetConfirmText(s), "重置", "取消"))) return
    await run(s.sessionKey, () => window.electronAPI.resetManagedSession(s.sessionKey))
  }

  const remove = async (s: ManagedSession) => {
    if (!(await confirm("删除会话", deleteConfirmText(s), "删除", "取消"))) return
    await run(s.sessionKey, () => window.electronAPI.deleteManagedSession(s.sessionKey))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setChat(f.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${chat === f.id ? "border-blue-500/60 bg-blue-600/20 text-accent-soft" : "border-line text-fg-3 hover:text-fg"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setCleanupOpen(true)}
          disabled={!loaded || sessions.length === 0}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft disabled:opacity-40"
          title="按天数批量清理久未使用的会话"
        >
          <BrushCleaning size={12} />清理久未使用…
        </button>
      </div>

      {loadError && <p className="text-xs text-danger-soft">{loadError}</p>}

      <div className="overflow-hidden rounded-xl border border-line-subtle bg-surface/60">
        <div className="flex items-center justify-between border-b border-line-subtle px-3 py-1.5 text-[11px] text-fg-muted">
          <span>其他人的会话</span>
          <span>{shown.length === sessions.length ? `${sessions.length} 个` : `${shown.length} / ${sessions.length} 个`}</span>
        </div>
        {!loaded ? (
          <p className="px-3 py-8 text-center text-xs text-fg-faint">{loadError ? "会话清单加载失败" : "正在加载…"}</p>
        ) : sessions.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-fg-faint">这个通道还没有其他人的会话，别人给机器人发过消息后会出现在这里</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-fg-faint">没有符合条件的会话</p>
        ) : (
          shown.map((s) => {
            const badge = overrideBadge(s)
            const busy = busyKey === s.sessionKey
            const blocked = !!busyKey
            const modelLabel = s.model
              ? modelPicker.quickModels.find((m) => m.model === s.model && (m.modelParams ?? "") === (s.modelParams ?? ""))?.label
                || modelSlug(s.model, s.modelParams)
              : undefined
            return (
              <div
                key={s.sessionKey}
                data-session-row={s.sessionKey}
                className={`flex flex-wrap items-center gap-1.5 border-b border-line-subtle/80 px-3 py-2 text-xs last:border-b-0 ${busy ? "opacity-60" : ""}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.running ? "bg-success" : "bg-stronger"}`} title={s.running ? "运行中" : "空闲"} />
                <span className="shrink-0 rounded bg-raised px-1 text-[10px] text-fg-3">{chatTag(s)}</span>
                <span className="min-w-0 max-w-[16rem] truncate text-fg-2" title={s.sessionKey}>{s.name}</span>
                {s.preview && <span className="min-w-0 max-w-[22rem] flex-1 truncate text-[11px] text-fg-faint" title={s.preview}>{s.preview}</span>}
                {s.queued > 0 && (
                  <span className="shrink-0 rounded bg-yellow-600/20 px-1 text-[10px] text-warning-soft" title="排队中的消息">排队 {s.queued}</span>
                )}
                {badge && (
                  <span className="shrink-0 rounded bg-blue-600/20 px-1 text-[10px] text-accent-soft" title={badge.title}>{badge.text}</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-fg-muted" title="最近一次对话">{lastActiveText(s, now)}</span>
                <ModelPicker
                  variant="compact"
                  placement="down"
                  portal
                  resources={modelPicker.resources}
                  currentResourceId={s.resourceId}
                  currentModel={s.model}
                  currentParams={s.modelParams}
                  currentLabel={modelLabel}
                  placeholder="选择模型"
                  quickModels={modelPicker.quickModels}
                  favorites={modelPicker.favorites}
                  onToggleFavorite={modelPicker.onToggleFavorite}
                  onOpen={modelPicker.onOpen}
                  switching={busy}
                  disabled={blocked && !busy}
                  onSelect={(m) => void switchModel(s, m)}
                />
                {s.running && (
                  <button type="button" disabled={blocked} onClick={() => void stop(s)} className={`${iconBtn} text-danger hover:bg-red-600/20`} title="停止会话">
                    <Square size={12} />
                  </button>
                )}
                {s.canRestoreDefault && (
                  <button type="button" disabled={blocked} onClick={() => void restore(s)} className={`${iconBtn} text-fg-3 hover:bg-raised hover:text-accent-soft`} title="恢复为通道默认模型">
                    <RotateCcw size={12} />
                  </button>
                )}
                <button
                  type="button"
                  disabled={blocked || !s.manageable}
                  onClick={() => void reset(s)}
                  className={`${iconBtn} text-fg-3 hover:bg-raised hover:text-warning-soft`}
                  title={s.manageable ? "重置：清空上下文，会话和设置保留" : s.blockedReason}
                >
                  <Eraser size={12} />
                </button>
                <button
                  type="button"
                  disabled={blocked || !s.manageable || !daemonRunning}
                  onClick={() => void remove(s)}
                  className={`${iconBtn} text-fg-faint hover:text-danger`}
                  title={!s.manageable ? s.blockedReason : !daemonRunning ? DAEMON_DOWN_HINT : "删除会话"}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )
          })
        )}
      </div>

      {skipped > 0 && (
        <p className="text-[11px] text-fg-faint">另有 {skipped} 个会话找不到所属通道（通道已删除或旧格式），这里不显示。</p>
      )}

      {cleanupOpen && (
        <CleanupDialog
          channelId={channelId}
          channelName={channelName}
          daemonRunning={daemonRunning}
          confirm={confirm}
          onClose={() => setCleanupOpen(false)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  )
}
