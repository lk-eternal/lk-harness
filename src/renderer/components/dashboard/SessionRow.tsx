import { ChevronDown, ChevronRight, Square, Trash2, X } from "lucide-react"
import { modelSlug } from "../../model-utils"
import type { DashboardSessionNode } from "../../../shared/dashboard-tree"
import ModelPicker, { type ModelChoice, type ModelPickerSource } from "../chat/ModelPicker"

export default function SessionRow({
  node,
  modelPicker,
  modelSwitching,
  expanded,
  channelName,
  onToggle,
  onSwitchModel,
  onStop,
  onDelete,
  onActivate,
  onDeleteQueueItem,
}: {
  node: DashboardSessionNode
  /** 模型选择器用的数据（供应商 / 常用 / 收藏），整页共用一份 */
  modelPicker: ModelPickerSource
  /** 这一行的模型正在切换 */
  modelSwitching?: boolean
  expanded: boolean
  /** 扁平列表（活跃会话）里用来标记会话属于哪个通道 */
  channelName?: string
  onToggle: () => void
  onSwitchModel: (m: ModelChoice) => void
  onStop?: () => void
  onDelete?: () => void
  onActivate?: () => void
  onDeleteQueueItem?: (fileId: string) => void
}) {
  const isProject = node.group === "project" || node.kind === "project"
  const queueProcessing = node.queue.filter((q) => q.status === "processing").length
  const queuePending = node.queue.length - queueProcessing
  /** 常用里给这个模型起过名就用它，否则按模型名 + 参数现算 */
  const modelLabel = node.model
    ? modelPicker.quickModels.find((m) => m.model === node.model && (m.modelParams ?? "") === (node.modelParams ?? ""))?.label
      || modelSlug(node.model, node.modelParams)
    : undefined

  return (
    <div className={`border-b border-line-subtle/80 last:border-b-0 ${node.current ? "bg-accent-tint/20" : ""}`}>
      {/* 整行可点展开：右侧操作区各自 stopPropagation，避免误触 */}
      <div
        onClick={onToggle}
        className="flex cursor-pointer flex-wrap items-center gap-1.5 px-2 py-2 text-xs hover:bg-raised/40"
      >
        <span className="text-fg-muted" title={expanded ? "收起" : "展开"}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${node.running ? "bg-success" : "bg-stronger"}`} />
        {channelName && (
          <span className="shrink-0 rounded bg-raised px-1 text-[10px] text-fg-3" title="所属通道">
            {channelName}
          </span>
        )}
        <span
          className={`min-w-0 truncate ${node.current ? "text-accent-bright" : "text-fg-2"}`}
          title={node.sessionKey}
        >
          {node.label}
        </span>
        {!node.running && onActivate && !node.current && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onActivate() }}
            className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-3 hover:border-blue-500 hover:text-accent-soft"
            title="切到此会话（只改路由，不拉起）"
          >
            激活
          </button>
        )}
        {queueProcessing > 0 && (
          <span className="shrink-0 rounded bg-blue-600/25 px-1 text-[10px] text-accent-soft" title="处理中的消息">
            处理中 {queueProcessing}
          </span>
        )}
        {queuePending > 0 && (
          <span className="shrink-0 rounded bg-yellow-600/20 px-1 text-[10px] text-warning-soft" title="排队中的消息">
            排队 {queuePending}
          </span>
        )}
        {/* 选择器的面板挂在 body 上，React 事件仍会冒泡到这里，所以这层要拦住，免得点面板也触发整行展开 */}
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <ModelPicker
            variant="compact"
            placement="down"
            portal
            resources={modelPicker.resources}
            currentResourceId={node.resourceId}
            currentModel={node.model ?? ""}
            currentParams={node.modelParams}
            currentLabel={modelLabel}
            placeholder="选择模型"
            quickModels={modelPicker.quickModels}
            favorites={modelPicker.favorites}
            onToggleFavorite={modelPicker.onToggleFavorite}
            onOpen={modelPicker.onOpen}
            switching={modelSwitching}
            onSelect={onSwitchModel}
          />
        </div>
        {node.running && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop() }}
            className="rounded p-0.5 text-danger hover:bg-red-600/20"
            title="停止会话"
          >
            <Square size={11} />
          </button>
        )}
        {node.removable && onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="rounded p-0.5 text-fg-faint hover:text-danger"
            title={isProject ? "删除项目（连带移除 AI 工作目录）" : "删除会话"}
          >
            {isProject ? <Trash2 size={11} /> : <X size={11} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="space-y-1 border-t border-line-subtle/50 bg-page/40 px-3 py-2 text-[11px] text-fg-3">
          {node.workspaceDir && <div className="truncate" title={node.workspaceDir}>目录 {node.workspaceDir}</div>}
          <div>
            队列 处理中 {node.queue.filter((q) => q.status === "processing").length}
            {" · "}排队 {node.queue.filter((q) => q.status !== "processing").length}
          </div>
          {node.queue.length === 0 ? (
            <div className="text-fg-faint">无排队消息</div>
          ) : (
            node.queue.map((q) => (
              <div key={q.fileId} className="flex items-start gap-2 rounded bg-surface/80 px-2 py-1">
                <span className={q.status === "processing" ? "text-accent" : "text-yellow-500"}>
                  {q.status === "processing" ? "处理中" : "排队"}
                </span>
                <span className="min-w-0 flex-1 break-all text-fg-2">{q.preview}</span>
                {onDeleteQueueItem && (
                  <button onClick={() => onDeleteQueueItem(q.fileId)} className="text-fg-faint hover:text-danger" title="删除">
                    <X size={11} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
