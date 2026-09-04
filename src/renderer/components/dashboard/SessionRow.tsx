import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, ChevronRight, Loader2, Plus, Square, Trash2, X } from "lucide-react"
import { modelSlug } from "../../model-utils"
import type { DashboardSessionNode } from "../../../shared/dashboard-tree"

const MENU_W = 224
const MENU_MAX_H = 192

export default function SessionRow({
  node,
  quickModels,
  modelSwitching,
  expanded,
  channelName,
  onToggle,
  onSwitchModel,
  onAddFavoriteModel,
  onRemoveFavoriteModel,
  onStop,
  onDelete,
  onActivate,
  onDeleteQueueItem,
}: {
  node: DashboardSessionNode
  quickModels: { model: string; modelParams?: string; label?: string; resourceId?: string }[]
  modelSwitching?: string
  expanded: boolean
  /** 扁平列表（活跃会话）里用来标记会话属于哪个通道 */
  channelName?: string
  onToggle: () => void
  onSwitchModel: (m: { model: string; modelParams?: string; resourceId?: string }) => void
  onAddFavoriteModel?: () => void
  onRemoveFavoriteModel?: (m: { model: string; modelParams?: string; resourceId?: string }) => void
  onStop?: () => void
  onDelete?: () => void
  onActivate?: () => void
  onDeleteQueueItem?: (fileId: string) => void
}) {
  // 会话行在滚动容器内，菜单用 fixed 挂到 body，否则靠底部的行会被容器裁掉
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuPos) return
    const close = () => setMenuPos(null)
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close()
    }
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      close()
    }
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", close)
    document.addEventListener("mousedown", onDoc)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", close)
      document.removeEventListener("mousedown", onDoc)
    }
  }, [menuPos])

  const toggleMenu = () => {
    if (menuPos) { setMenuPos(null); return }
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const spaceBelow = window.innerHeight - r.bottom
    setMenuPos({
      top: spaceBelow >= MENU_MAX_H + 8 ? r.bottom + 4 : Math.max(8, r.top - MENU_MAX_H - 4),
      left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
    })
  }

  const isProject = node.group === "project" || node.kind === "project"
  const queueProcessing = node.queue.filter((q) => q.status === "processing").length
  const queuePending = node.queue.length - queueProcessing
  const modelLabel = node.model
    ? (quickModels.find((m) => m.model === node.model && (m.modelParams ?? "") === (node.modelParams ?? ""))?.label
      || modelSlug(node.model, node.modelParams))
    : "选择模型"
  const switchKey = node.model ? `${node.model}\0${node.modelParams ?? ""}` : ""

  return (
    <div className={`border-b border-gray-800/80 last:border-b-0 ${node.current ? "bg-blue-950/20" : ""}`}>
      {/* 整行可点展开：右侧操作区各自 stopPropagation，避免误触 */}
      <div
        onClick={onToggle}
        className="flex cursor-pointer flex-wrap items-center gap-1.5 px-2 py-2 text-xs hover:bg-gray-800/40"
      >
        <span className="text-gray-500" title={expanded ? "收起" : "展开"}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${node.running ? "bg-emerald-400" : "bg-gray-600"}`} />
        {channelName && (
          <span className="shrink-0 rounded bg-gray-800 px-1 text-[10px] text-gray-400" title="所属通道">
            {channelName}
          </span>
        )}
        <span
          className={`min-w-0 truncate ${node.current ? "text-blue-200" : "text-gray-300"}`}
          title={node.sessionKey}
        >
          {node.label}
        </span>
        {!node.running && onActivate && !node.current && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onActivate() }}
            className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 hover:border-blue-500 hover:text-blue-300"
            title="切到此会话（只改路由，不拉起）"
          >
            激活
          </button>
        )}
        {queueProcessing > 0 && (
          <span className="shrink-0 rounded bg-blue-600/25 px-1 text-[10px] text-blue-300" title="处理中的消息">
            处理中 {queueProcessing}
          </span>
        )}
        {queuePending > 0 && (
          <span className="shrink-0 rounded bg-yellow-600/20 px-1 text-[10px] text-yellow-300" title="排队中的消息">
            排队 {queuePending}
          </span>
        )}
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <button
            ref={btnRef}
            type="button"
            onClick={toggleMenu}
            className="inline-flex max-w-[10rem] items-center gap-1 rounded border border-gray-700 px-1.5 py-0.5 text-[11px] text-violet-200 hover:border-violet-500"
            title="切换本会话模型"
          >
            {!!switchKey && modelSwitching === switchKey && <Loader2 size={10} className="animate-spin" />}
            <span className="truncate">{modelLabel}</span>
            <ChevronDown size={10} />
          </button>
          {menuPos && createPortal(
            <div
              ref={menuRef}
              style={{ position: "fixed", top: menuPos.top, left: menuPos.left, width: MENU_W, maxHeight: MENU_MAX_H }}
              className="z-50 overflow-auto overscroll-contain rounded border border-gray-700 bg-gray-950 py-1 shadow-lg"
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              {quickModels.length === 0 && (
                <div className="px-2 py-1 text-[11px] text-gray-600">暂无常用模型</div>
              )}
              {quickModels.map((m) => {
                const k = `${m.model}\0${m.modelParams ?? ""}\0${m.resourceId ?? ""}`
                const cur = node.model === m.model && (node.modelParams ?? "") === (m.modelParams ?? "")
                return (
                  <div key={k} className="group flex items-center hover:bg-violet-950/50">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate px-2 py-1 text-left text-[11px] ${cur ? "text-violet-200" : "text-gray-300"}`}
                      onClick={() => { setMenuPos(null); onSwitchModel(m) }}
                    >
                      {m.label || modelSlug(m.model, m.modelParams)}
                    </button>
                    {onRemoveFavoriteModel && (
                      <button
                        type="button"
                        className="hidden shrink-0 px-1.5 text-gray-600 hover:text-red-400 group-hover:block"
                        onClick={(e) => { e.stopPropagation(); onRemoveFavoriteModel(m) }}
                        title="从常用模型中移除"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                )
              })}
              {onAddFavoriteModel && (
                <button
                  type="button"
                  className="mt-1 flex w-full items-center gap-1 border-t border-gray-800 px-2 py-1.5 text-[11px] text-gray-400 hover:bg-gray-900 hover:text-violet-300"
                  onClick={() => { setMenuPos(null); onAddFavoriteModel() }}
                >
                  <Plus size={11} />添加常用模型
                </button>
              )}
            </div>,
            document.body,
          )}
        </div>
        {node.running && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop() }}
            className="rounded p-0.5 text-red-400 hover:bg-red-600/20"
            title="停止会话"
          >
            <Square size={11} />
          </button>
        )}
        {node.removable && onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="rounded p-0.5 text-gray-600 hover:text-red-400"
            title={isProject ? "删除项目（连带移除 AI 工作目录）" : "删除会话"}
          >
            {isProject ? <Trash2 size={11} /> : <X size={11} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="space-y-1 border-t border-gray-800/50 bg-gray-950/40 px-3 py-2 text-[11px] text-gray-400">
          {node.workspaceDir && <div className="truncate" title={node.workspaceDir}>目录 {node.workspaceDir}</div>}
          <div>
            队列 处理中 {node.queue.filter((q) => q.status === "processing").length}
            {" · "}排队 {node.queue.filter((q) => q.status !== "processing").length}
          </div>
          {node.queue.length === 0 ? (
            <div className="text-gray-600">无排队消息</div>
          ) : (
            node.queue.map((q) => (
              <div key={q.fileId} className="flex items-start gap-2 rounded bg-gray-900/80 px-2 py-1">
                <span className={q.status === "processing" ? "text-blue-400" : "text-yellow-500"}>
                  {q.status === "processing" ? "处理中" : "排队"}
                </span>
                <span className="min-w-0 flex-1 break-all text-gray-300">{q.preview}</span>
                {onDeleteQueueItem && (
                  <button onClick={() => onDeleteQueueItem(q.fileId)} className="text-gray-600 hover:text-red-400" title="删除">
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
