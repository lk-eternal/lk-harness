import { Eraser, RotateCcw, Square, Trash2, X } from "lucide-react"
import { modelSlug } from "../../model-utils"
import ModelPicker, { type ModelChoice, type ModelPickerSource } from "../chat/ModelPicker"
import SessionTypeIcon from "./SessionTypeIcon"
import {
  DAEMON_DOWN_HINT,
  lastActiveText,
  overrideBadge,
  queueCounts,
  rowCapabilities,
  TASK_MODEL_HINT,
  type SessionItem,
} from "./sessions-view"

const iconBtn = "rounded p-1 transition disabled:opacity-40"
/** 操作按钮的固定位置：停止 / 恢复默认 / 重置 / 删除各占一格，这一行没有的操作留空，别的行的按钮和模型下拉才对得齐 */
const ACTION_SLOT = "inline-flex w-6 shrink-0 justify-center"

export interface SessionListRowProps {
  item: SessionItem
  now: number
  /** 会话清单（最近活动时间在里面）已经加载过；没加载过时不显示「无记录」 */
  activityKnown: boolean
  /** 清单混着多个通道的会话（「全部」/ 活跃会话）时，行上标出所属通道；单个通道的清单不标 */
  showChannel?: boolean
  modelPicker: ModelPickerSource
  /** 这一行正在被操作（重置 / 删除 / 换模型 …）：变淡 */
  busy: boolean
  /** 换模型的请求还在路上 */
  switching: boolean
  /** 别的行正在被操作：这一行的操作暂时点不了（同一时刻只做一个，避免连点） */
  blocked: boolean
  daemonRunning: boolean
  queueOpen: boolean
  onToggleQueue: () => void
  onSwitchModel: (m: ModelChoice) => void
  onStop: () => void
  onActivate: () => void
  onRestore: () => void
  onReset: () => void
  onDelete: () => void
  onDeleteQueueItem: (fileId: string) => void
}

/**
 * 会话管理页的一行。主用户自己的和别人的会话画成同一个样子：
 * 运行点 · 类型图标 · 名字 · (最后一句话) · 排队 · 标记 · 最近对话 · 模型 · 操作，
 * 区别只在有哪些操作（见 rowCapabilities）和主用户当前会话的高亮。
 * 纯函数组件（没有 hook），测试里可以直接调用后遍历元素树。
 */
export default function SessionListRow({
  item,
  now,
  activityKnown,
  showChannel = false,
  modelPicker,
  busy,
  switching,
  blocked,
  daemonRunning,
  queueOpen,
  onToggleQueue,
  onSwitchModel,
  onStop,
  onActivate,
  onRestore,
  onReset,
  onDelete,
  onDeleteQueueItem,
}: SessionListRowProps) {
  const caps = rowCapabilities(item)
  const current = item.owner === "mine" && item.current
  const badge = item.owner === "others" ? overrideBadge(item.managed) : undefined
  const { processing, pending } = queueCounts(item.queue)
  /** 常用里给这个模型起过名就用它，否则按模型名 + 参数现算 */
  const modelLabel = item.model
    ? modelPicker.quickModels.find((m) => m.model === item.model && (m.modelParams ?? "") === (item.modelParams ?? ""))?.label
      || modelSlug(item.model, item.modelParams)
    : undefined
  const managed = item.owner === "others" ? item.managed : undefined
  const deleteTitle = item.owner === "mine"
    ? (item.type === "project" ? "删除项目（连带移除 AI 工作目录）" : "删除会话")
    : !managed?.manageable ? managed?.blockedReason : !daemonRunning ? DAEMON_DOWN_HINT : "删除会话"

  return (
    <div
      data-session-row={item.sessionKey}
      data-session-owner={item.owner}
      data-session-type={item.type}
      className={`border-b border-line-subtle/80 last:border-b-0 ${current ? "bg-accent-tint/20" : ""} ${busy ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.running ? "bg-success" : "bg-stronger"}`} title={item.running ? "运行中" : "空闲"} />
        <SessionTypeIcon type={item.type} />
        {showChannel && item.channelName && (
          <span data-session-channel className="shrink-0 rounded bg-raised px-1 text-[10px] text-fg-3" title="所属通道">
            {item.channelName}
          </span>
        )}
        <span className={`min-w-0 max-w-[16rem] truncate ${current ? "text-accent-bright" : "text-fg-2"}`} title={item.sessionKey}>{item.name}</span>
        {caps.activate && (
          <button
            type="button"
            disabled={blocked}
            onClick={onActivate}
            className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-3 hover:border-blue-500 hover:text-accent-soft disabled:opacity-40"
            title="切到此会话（只改路由，不拉起）"
          >
            激活
          </button>
        )}
        {item.preview && <span className="min-w-0 max-w-[22rem] flex-1 truncate text-[11px] text-fg-faint" title={item.preview}>{item.preview}</span>}
        {item.queue.length > 0 && (
          <button
            type="button"
            onClick={onToggleQueue}
            aria-expanded={queueOpen}
            title={queueOpen ? "收起排队的消息" : "展开看排队的消息，可以删除"}
            className="inline-flex shrink-0 items-center gap-1"
          >
            {processing > 0 && (
              <span className="rounded bg-blue-600/25 px-1 text-[10px] text-accent-soft">处理中 {processing}</span>
            )}
            {pending > 0 && (
              <span className="rounded bg-yellow-600/20 px-1 text-[10px] text-warning-soft">排队 {pending}</span>
            )}
          </button>
        )}
        {badge && (
          <span className="shrink-0 rounded bg-blue-600/20 px-1 text-[10px] text-accent-soft" title={badge.title}>{badge.text}</span>
        )}
        {/* 右边三栏（时间 / 模型 / 操作）都是固定宽度、靠右对齐：每行操作按钮个数不同，不固定的话各行的模型下拉会参差不齐 */}
        <span className="ml-auto w-16 shrink-0 text-right text-[11px] text-fg-muted" title="最近一次对话">
          {activityKnown ? lastActiveText(item, now) : ""}
        </span>
        <div data-session-col="model" className="flex w-40 shrink-0 justify-end">
          <ModelPicker
            variant="compact"
            placement="down"
            portal
            resources={modelPicker.resources}
            currentResourceId={item.resourceId}
            currentModel={item.model}
            currentParams={item.modelParams}
            currentLabel={modelLabel}
            placeholder="选择模型"
            quickModels={modelPicker.quickModels}
            favorites={modelPicker.favorites}
            onToggleFavorite={modelPicker.onToggleFavorite}
            onOpen={modelPicker.onOpen}
            switching={switching}
            disabled={!caps.model || (blocked && !busy)}
            disabledReason={caps.model ? undefined : TASK_MODEL_HINT}
            onSelect={onSwitchModel}
          />
        </div>
        <div data-session-col="actions" className="flex shrink-0">
          <span className={ACTION_SLOT}>
            {caps.stop && (
              <button type="button" disabled={blocked} onClick={onStop} className={`${iconBtn} text-danger hover:bg-red-600/20`} title="停止会话">
                <Square size={12} />
              </button>
            )}
          </span>
          <span className={ACTION_SLOT}>
            {caps.restore && (
              <button type="button" disabled={blocked} onClick={onRestore} className={`${iconBtn} text-fg-3 hover:bg-raised hover:text-accent-soft`} title="恢复为通道默认模型">
                <RotateCcw size={12} />
              </button>
            )}
          </span>
          <span className={ACTION_SLOT}>
            {caps.reset && (
              <button
                type="button"
                disabled={blocked || !managed?.manageable}
                onClick={onReset}
                className={`${iconBtn} text-fg-3 hover:bg-raised hover:text-warning-soft`}
                title={managed?.manageable ? "重置：清空上下文，会话和设置保留" : managed?.blockedReason}
              >
                <Eraser size={12} />
              </button>
            )}
          </span>
          <span className={ACTION_SLOT}>
            {caps.remove && (
              <button
                type="button"
                disabled={blocked || (item.owner === "others" && (!managed?.manageable || !daemonRunning))}
                onClick={onDelete}
                className={`${iconBtn} text-fg-faint hover:text-danger`}
                title={deleteTitle}
              >
                <Trash2 size={12} />
              </button>
            )}
          </span>
        </div>
      </div>
      {queueOpen && item.queue.length > 0 && (
        <div data-queue-panel className="space-y-1 border-t border-line-subtle/50 bg-page/40 px-3 py-2 text-[11px] text-fg-3">
          {item.queue.map((q) => (
            <div key={q.fileId} className="flex items-start gap-2 rounded bg-surface/80 px-2 py-1">
              <span className={q.status === "processing" ? "text-accent" : "text-yellow-500"}>
                {q.status === "processing" ? "处理中" : "排队"}
              </span>
              <span className="min-w-0 flex-1 break-all text-fg-2">{q.preview}</span>
              <button type="button" onClick={() => onDeleteQueueItem(q.fileId)} className="text-fg-faint hover:text-danger" title="删除这条排队的消息">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
