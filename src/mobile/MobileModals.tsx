import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Archive,
  Check,
  ChevronRight,
  ClipboardPaste,
  Cloud,
  Cpu,
  FolderKanban,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageCircle,
  Monitor,
  Pin,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Server,
  Sparkles,
  Trash2,
  Wifi,
  X,
} from "lucide-react"
import type { AgentResource } from "../shared/channel-types"
import { appChatSessionDir, sameChatDir, type ChatDirOption } from "../shared/app-chat-types"
import { isSessionPinned, pinFirst } from "../shared/app-chat-pins"
import { ARCHIVED_GROUP_TITLE, splitArchived } from "../shared/session-archive"
import { branchGroups, branchNotices, type BranchOption } from "../shared/git-branch"
import { sameChatSession } from "../renderer/components/chat/useAppChatItems"
import { useBranchMenu } from "../renderer/components/chat/useBranchMenu"
import { modelSlug } from "../renderer/model-utils"
import { formatTimeAgo } from "../renderer/time-ago"
import {
  listMobileBranches,
  listMobileProviderModels,
  parsePairInput,
  switchMobileBranch,
  type MobileChannelView,
  type MobileChatTab,
  type MobilePairConfig,
  type MobileProviderModel,
  type MobileQuickModel,
  type RouteStatus,
} from "./api"
import { useBackToClose } from "./back-stack"
import {
  choiceForListed,
  choiceForQuick,
  isCurrentListed,
  isCurrentQuick,
  listedRowKey,
  resolveProviderId,
  type ModelChoice,
} from "./model-choice"
import { useSheetDrag } from "./useSheetDrag"
import { QrScanner } from "./QrScanner"

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function dirName(dir: string | undefined): string | undefined {
  return dir?.split(/[\\/]/).filter(Boolean).pop()
}

const NO_PINS: readonly string[] = []

/**
 * 会话列表最下面的「已归档」折叠分组（调用方保证至少有一个才渲染）。
 * 默认收起；选中的会话在里面（点通知跳过来的、刚把当前项目归档了）就展开，不然打开抽屉找不到自己在哪。
 */
function ArchivedGroup({ tabs, selected, renderRow }: {
  tabs: MobileChatTab[]
  selected: string | null
  renderRow: (t: MobileChatTab) => ReactNode
}) {
  const hasSelected = tabs.some((t) => sameChatSession(t.sessionKey, selected))
  const [open, setOpen] = useState(hasSelected)
  useEffect(() => { if (hasSelected) setOpen(true) }, [selected, hasSelected])
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-left text-[12px] text-fg-muted transition active:bg-raised"
      >
        <ChevronRight size={13} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Archive size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{ARCHIVED_GROUP_TITLE}</span>
        <span className="shrink-0 text-[11px] text-fg-faint">{tabs.length}</span>
      </button>
      {open && <div className="space-y-1">{tabs.map(renderRow)}</div>}
    </div>
  )
}

export function SessionDrawer({
  open,
  onClose,
  hostname,
  route,
  views,
  selected,
  sessionName,
  sessionStatus,
  activeAt,
  pins = NO_PINS,
  usageBytes,
  onSelect,
  onNewTemp,
  onNewProject,
  onTogglePin,
  onDelete,
  onClearAll,
  onOpenPair,
}: {
  open: boolean
  onClose: () => void
  hostname: string
  route: RouteStatus
  views: MobileChannelView[]
  selected: string | null
  sessionName: (t: MobileChatTab) => string
  sessionStatus: (key: string, running: boolean) => "idle" | "working" | "unread"
  activeAt: (t: MobileChatTab) => number | undefined
  /** 置顶的会话（appChatSessionId），置顶的排在最前；不传就是没有置顶 */
  pins?: readonly string[]
  usageBytes: number | null
  onSelect: (sessionKey: string) => void
  onNewTemp: (channelId: string) => void
  /** 新建项目（项目归这个通道） */
  onNewProject: (channelId: string) => void
  /** 置顶 / 取消置顶（和电脑端同一份） */
  onTogglePin?: (t: MobileChatTab) => void
  onDelete: (t: MobileChatTab) => void
  onClearAll: () => void
  onOpenPair: () => void
}) {
  const now = Date.now()
  useBackToClose(open, onClose)

  const defaultChannelId = views[0]?.channelId

  // 置顶的在前，其余按最近对话排；两组内部都是最近的在前
  const sortTabs = (tabs: MobileChatTab[]) =>
    pinFirst([...tabs].sort((a, b) => (activeAt(b) ?? 0) - (activeAt(a) ?? 0)), pins)
  /** 已归档的项目会话：不跟着各通道排，收在整个列表最下面 */
  const archivedTabs = views.flatMap((v) => splitArchived(v.tabs).archived)

  const renderRow = (t: MobileChatTab) => {
    const on = sameChatSession(t.sessionKey, selected)
    const status = sessionStatus(t.sessionKey, t.running)
    const at = activeAt(t)
    const wsDir = appChatSessionDir(t.sessionKey, t.boundDir)
    const subText =
      status === "working"
        ? "AI 正在回复..."
        : t.kind === "project"
          ? "项目"
          : wsDir
            ? dirName(wsDir)
            : "临时对话"
    const deletable = !!t.removable && t.kind !== "project"
    const pinned = isSessionPinned(pins, t.sessionKey)

    return (
      <div key={t.sessionKey} className={`group relative flex items-center ${t.archived ? "opacity-70" : ""}`}>
        <button
          type="button"
          onClick={() => {
            onSelect(t.sessionKey)
            onClose()
          }}
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition ${
            on
              ? "border border-blue-500/35 bg-blue-600/15 text-fg"
              : "text-fg-2 active:bg-raised"
          }`}
        >
          {/* 状态图标：转圈 / 未读绿点 / 普通图标 */}
          {status === "working" ? (
            <Loader2
              size={15}
              className="shrink-0 animate-spin text-accent"
            />
          ) : (
            <span className="relative shrink-0">
              {t.kind === "project" ? (
                <FolderKanban
                  size={15}
                  className={on ? "text-accent" : "text-fg-faint"}
                />
              ) : (
                <MessageCircle
                  size={15}
                  className={on ? "text-accent" : "text-fg-faint"}
                />
              )}
              {status === "unread" && (
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-surface" />
              )}
            </span>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium">
                {sessionName(t)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
              <span
                className={
                  status === "working"
                    ? "font-medium text-accent"
                    : "truncate"
                }
              >
                {subText}
              </span>
              {t.branch && status !== "working" && (
                <span className="inline-flex items-center gap-0.5 text-fg-faint">
                  · <GitBranch size={10} />
                  {t.branch}
                </span>
              )}
            </div>
          </div>

          {/* 右侧状态角标或活跃时间 */}
          <div className="shrink-0 text-right">
            {status === "unread" ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                已完成
              </span>
            ) : status === "working" ? (
              <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-accent">
                回复中
              </span>
            ) : at !== undefined ? (
              <span className="text-[11px] text-fg-faint">
                {formatTimeAgo(at, now)}
              </span>
            ) : null}
          </div>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin?.(t)
          }}
          title={pinned ? "取消置顶" : "置顶会话"}
          aria-label={pinned ? "取消置顶" : "置顶会话"}
          aria-pressed={pinned}
          className={`ml-0.5 flex h-11 w-9 shrink-0 items-center justify-center rounded-xl transition active:bg-raised ${
            pinned ? "text-accent" : "text-fg-faint"
          }`}
        >
          <Pin size={15} className={pinned ? "fill-current" : ""} />
        </button>

        {deletable && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(t)
            }}
            title="删除会话"
            aria-label="删除会话"
            className="ml-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-fg-faint transition active:bg-raised active:text-danger"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    )
  }

  // 常驻挂载、靠 CSS 滑入滑出（关着时 visibility:hidden，见 mobile.css 的 .drawer）：
  // 这样手指才能拖着它走（drawer-swipe.ts），按钮、遮罩、返回键也都有同样的动画
  return (
    <div data-drawer data-open={open ? "true" : "false"} className="drawer fixed inset-0 z-40 flex">
      <div
        data-drawer-scrim
        onClick={onClose}
        className="drawer-scrim fixed inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <aside
        data-drawer-panel
        className="drawer-panel relative z-10 flex h-full w-[82%] max-w-[320px] flex-col border-r border-line bg-surface pt-safe pb-safe shadow-2xl"
      >
        {/* 头部主机卡片 */}
        <div className="border-b border-line-subtle px-4 pb-3 pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-xs font-bold text-white shadow-sm">
                LK
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-fg">
                    {hostname || route.hostname || "未连接电脑"}
                  </span>
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      route.connected ? "bg-emerald-500" : "bg-amber-500"
                    }`}
                  />
                </div>
                <p className="truncate text-[11px] text-fg-muted">
                  {route.connected
                    ? `${route.routeType === "lan" ? "局域网" : "公网"}${
                        route.latencyMs ? ` · ${route.latencyMs}ms` : ""
                      }`
                    : route.error || "点击右上角配对电脑"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-fg-muted transition active:bg-raised"
            >
              <X size={16} />
            </button>
          </div>

          {defaultChannelId && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  onNewTemp(defaultChannelId)
                  onClose()
                }}
                className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2 text-xs font-medium text-white shadow-sm transition active:scale-[0.99]"
              >
                <Plus size={15} />新建临时会话
              </button>
              <button
                type="button"
                onClick={() => {
                  onNewProject(defaultChannelId)
                  onClose()
                }}
                className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-medium text-fg-2 transition active:bg-raised"
              >
                <FolderKanban size={14} className="text-accent" />新项目
              </button>
            </div>
          )}
        </div>

        {/* 会话列表 */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
          {views.map((v) => (
            <div key={v.channelId}>
              {views.length > 1 && (
                <p className="px-2 pb-1.5 text-[11px] font-medium text-fg-faint">
                  {v.name}
                </p>
              )}
              <div className="space-y-1">
                {sortTabs(splitArchived(v.tabs).live).map(renderRow)}
              </div>
            </div>
          ))}

          {/* 已归档的项目会话收在最下面一个折叠分组里；一个都没有就不出现 */}
          {archivedTabs.length > 0 && (
            <ArchivedGroup tabs={sortTabs(archivedTabs)} selected={selected} renderRow={renderRow} />
          )}
        </div>

        {/* 底部信息与配对入口 */}
        <div className="border-t border-line-subtle px-4 py-2.5">
          <div className="flex items-center justify-between text-[11px] text-fg-muted">
            <span>{usageBytes != null ? `记录 ${fmtBytes(usageBytes)}` : "实时同步"}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  onOpenPair()
                  onClose()
                }}
                className="text-accent transition active:opacity-75"
              >
                线路配置
              </button>
              <button
                type="button"
                onClick={onClearAll}
                className="text-fg-faint transition active:text-danger"
              >
                清空全部
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

/**
 * 「常用模型」里的一张卡片。名字要显示完整：同一个模型的几档推理参数只差名字末尾的档位，
 * 用省略号截断的话几张卡片看起来一模一样，所以允许换行（break-words：模型名里没有空格，在连字符处断，放不下才硬断）。
 */
export function QuickModelCard({
  qm,
  current,
  resourceName,
  onPick,
}: {
  qm: MobileQuickModel
  current: boolean
  resourceName?: string
  onPick: (choice: ModelChoice) => void
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={() => onPick(choiceForQuick(qm))}
      className={`flex min-w-0 flex-col items-start rounded-xl border px-3 py-2 text-left transition active:scale-[0.98] ${
        current
          ? "border-blue-500 bg-blue-600/15 text-fg"
          : "border-line bg-page/70 text-fg-2"
      }`}
    >
      <div className="flex w-full items-start justify-between gap-1">
        <span data-model-name className="min-w-0 break-words text-xs font-medium leading-snug">
          {qm.label || modelSlug(qm.model, qm.modelParams)}
        </span>
        {current && <Check size={12} className="mt-0.5 shrink-0 text-accent" />}
      </div>
      <span className="mt-0.5 max-w-full truncate text-[10px] text-fg-muted">
        {resourceName || qm.model}
      </span>
    </button>
  )
}

/** 供应商模型列表里的一行；名字同样允许换行，带参数的名字（如 xxx (effort=high, fast=true)）很长 */
export function ModelRow({
  row,
  resourceId,
  current,
  onPick,
}: {
  row: MobileProviderModel
  /** 这一列属于哪家供应商 */
  resourceId: string
  current: boolean
  onPick: (choice: ModelChoice) => void
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={() => onPick(choiceForListed(row, resourceId))}
      className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left transition active:scale-[0.99] ${
        current
          ? "border-blue-500/50 bg-blue-600/15 text-fg"
          : "border-line-subtle bg-page/60 text-fg-2"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p data-model-name className="break-words text-xs font-medium leading-snug">{row.label || row.id}</p>
        {row.label && row.label !== row.id && (
          <p className="break-words font-mono text-[10px] text-fg-muted">{row.id}</p>
        )}
      </div>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  )
}

interface ModelSheetProps {
  open: boolean
  onClose: () => void
  baseUrl: string
  token: string
  resources: AgentResource[]
  quickModels: MobileQuickModel[]
  currentResourceId?: string
  currentModel?: string
  currentParams?: string
  switching: boolean
  onSelect: (choice: { model: string; modelParams?: string; resourceId?: string }) => void
}

/**
 * 「切换对话模型」抽屉。只在打开时才挂载内容：搜索词、选中的供应商都是内容里的状态，
 * 每次打开都是全新的，不用靠 effect 去重置。
 * 原来是靠一个依赖 resources 的 effect 在打开时重置——手机端每 10 秒刷新一次，每次都给一个新的 resources 数组，
 * 于是正在输入的搜索词、正在看的供应商会被周期性地清掉、拉回当前供应商。
 */
export function ModelSheet(props: ModelSheetProps) {
  if (!props.open) return null
  return <ModelSheetBody {...props} />
}

function ModelSheetBody({
  onClose,
  baseUrl,
  token,
  resources,
  quickModels,
  currentResourceId,
  currentModel,
  currentParams,
  switching,
  onSelect,
}: ModelSheetProps) {
  // 用户在这次打开里点过的供应商（没点过是空串）；真正生效的那家由 resolveProviderId 决定
  const [pickedResId, setPickedResId] = useState("")
  const selectedResId = resolveProviderId(pickedResId, resources, currentResourceId)
  const [search, setSearch] = useState("")
  const [models, setModels] = useState<MobileProviderModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!selectedResId || !baseUrl || !token) return
    let cancelled = false
    setLoading(true)
    setError("")
    void listMobileProviderModels(baseUrl, token, {
      resourceId: selectedResId,
      currentModel,
      currentParams,
    }).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? "获取模型列表失败")
        setModels([])
        return
      }
      setModels(r.models ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [selectedResId, baseUrl, token, currentModel, currentParams])

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.label && m.label.toLowerCase().includes(q)),
    )
  }, [models, search])

  useBackToClose(true, onClose)
  const { panelRef, grip } = useSheetDrag(onClose)

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div ref={panelRef} className="relative z-10 flex max-h-[82vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {/* 顶部抓手：按住往下拖可关闭 */}
        {grip}

        <div className="flex items-center justify-between px-4 pb-2 pt-1">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-accent" />
            <span className="text-sm font-semibold text-fg">切换对话模型</span>
            {switching && <Loader2 size={13} className="animate-spin text-accent" />}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-fg-muted active:bg-raised"
          >
            <X size={16} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="px-4 pb-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-page px-3 py-2">
            <Search size={14} className="shrink-0 text-fg-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型名称或 ID (如 claude, opus, gpt-5)..."
              className="w-full bg-transparent text-xs text-fg focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-fg-muted"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 pb-4">
          {/* 常用模型快捷网格 */}
          {!search.trim() && quickModels.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-fg-muted">
                <Sparkles size={11} className="text-accent" />常用模型
              </p>
              <div className="grid grid-cols-2 gap-2">
                {quickModels.map((qm, idx) => (
                  <QuickModelCard
                    key={`${qm.resourceId ?? ""}-${qm.model}-${qm.modelParams ?? ""}-${idx}`}
                    qm={qm}
                    current={isCurrentQuick(qm, { model: currentModel, params: currentParams, resourceId: currentResourceId })}
                    resourceName={resources.find((r) => r.id === qm.resourceId)?.name}
                    onPick={(choice) => {
                      onSelect(choice)
                      onClose()
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 供应商切换胶囊 */}
          {resources.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-fg-muted">模型供应商</p>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {resources.map((r) => {
                  const active = r.id === selectedResId
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setPickedResId(r.id)}
                      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
                        active
                          ? "border-blue-500 bg-blue-600 text-white"
                          : "border-line bg-page text-fg-3"
                      }`}
                    >
                      {r.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* 供应商模型列表 */}
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-fg-muted">
              可用模型 ({filteredModels.length})
            </p>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-fg-muted">
                <Loader2 size={14} className="animate-spin text-accent" />正在拉取模型列表…
              </div>
            ) : error ? (
              <p className="rounded-xl border border-danger-line/40 bg-danger-tint/20 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : (
              <div className="space-y-1.5">
                {filteredModels.length === 0 && models.length > 0 && (
                  <p data-no-match className="px-1 py-6 text-center text-xs text-fg-muted">
                    当前供应商里没有匹配「{search.trim()}」的模型
                  </p>
                )}
                {filteredModels.map((m) => (
                  <ModelRow
                    key={listedRowKey(m)}
                    row={m}
                    resourceId={selectedResId}
                    // 同一个模型有好几档推理参数：模型和参数都对上才算当前；展示的还得是当前供应商那一列
                    current={
                      selectedResId === (currentResourceId || selectedResId) &&
                      isCurrentListed(m, { model: currentModel, params: currentParams })
                    }
                    onPick={(choice) => {
                      onSelect(choice)
                      onClose()
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function DirSheet({
  open,
  onClose,
  options,
  currentDir,
  canRebind,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  options: ChatDirOption[]
  currentDir: string | undefined
  /** 当前会话还能不能直接改目录（还没开始的临时会话可以；否则选目录会用它新开一个会话） */
  canRebind: boolean
  onSelect: (dir: string) => void
}) {
  useBackToClose(open, onClose)
  const { panelRef, grip } = useSheetDrag(onClose)
  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div ref={panelRef} className="relative z-10 flex max-h-[70vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {grip}
        <div className="flex items-center justify-between px-4 pb-1 pt-1">
          <div className="flex items-center gap-2">
            <FolderOpen size={16} className="text-accent" />
            <span className="text-sm font-semibold text-fg">选择工作目录</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-fg-muted">
            <X size={16} />
          </button>
        </div>
        <p className="px-4 pb-2.5 text-[11px] leading-relaxed text-fg-muted">
          {canRebind
            ? "为这个会话选择工作目录，多个会话可以共用同一个目录"
            : "会话开始后目录不再更换，选择目录会用它新开一个会话"}
        </p>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-4">
          {options.length === 0 ? (
            <p className="py-6 text-center text-xs text-fg-muted">
              电脑上还没有用过的工作目录，请先在电脑端选一个
            </p>
          ) : (
            options.map((o) => {
              const on = sameChatDir(o.dir, currentDir)
              return (
                <button
                  key={o.dir}
                  type="button"
                  aria-current={on ? "true" : undefined}
                  onClick={() => {
                    onSelect(o.dir)
                    onClose()
                  }}
                  className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition ${
                    on
                      ? "border-blue-500/50 bg-blue-600/15 text-fg"
                      : "border-line-subtle bg-page/60 text-fg-2"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{o.name}</span>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-fg-muted">{o.dir}</p>
                  </div>
                  {on && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

interface BranchSheetProps {
  open: boolean
  onClose: () => void
  baseUrl: string
  token: string
  sessionKey: string
  /** 用这个目录的会话个数（含当前这个）：切换对它们都生效 */
  shared: number
  /** 切换成功，参数是切过去之后的分支 */
  onSwitched: (current: string) => void
  /** 切换失败而抽屉已经关掉了（切的过程中被拖下去）：原因没有地方显示，交给外面提示 */
  onError: (message: string) => void
}

/** 「切换分支」抽屉：分支是工作目录的，手机端的入口在顶栏会话名下面的分支小胶囊。只在打开时才挂载内容，每次打开都是全新的 */
export function BranchSheet(props: BranchSheetProps) {
  if (!props.open) return null
  return <BranchSheetBody {...props} />
}

function BranchSheetBody({ onClose, baseUrl, token, sessionKey, shared, onSwitched, onError }: BranchSheetProps) {
  const [query, setQuery] = useState("")
  const closedRef = useRef(false)
  useEffect(() => () => { closedRef.current = true }, [])
  const menu = useBranchMenu(true, {
    load: () => listMobileBranches(baseUrl, token, sessionKey),
    switchTo: (target) => switchMobileBranch(baseUrl, token, sessionKey, target),
  })
  useBackToClose(true, onClose)
  const { panelRef, grip } = useSheetDrag(onClose)

  const data = menu.data
  const groups = data ? branchGroups(data, query) : []
  const notices = data ? branchNotices({ blocked: data.blocked, dirty: data.dirty, shared, truncated: data.truncated }) : []

  const pick = async (option: BranchOption) => {
    if (option.current) { onClose(); return }
    const r = await menu.choose(option)
    if (!r) return
    if (r.ok) {
      onSwitched(r.current)
      onClose()
    } else if (closedRef.current) {
      onError(r.error)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div ref={panelRef} className="relative z-10 flex max-h-[78vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {grip}
        <div className="flex items-center justify-between px-4 pb-2 pt-1">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-accent" />
            <span className="text-sm font-semibold text-fg">切换分支</span>
            {menu.switching && <Loader2 size={13} className="animate-spin text-accent" />}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-fg-muted active:bg-raised">
            <X size={16} />
          </button>
        </div>

        {notices.length > 0 && (
          <div className="space-y-1 px-4 pb-2">
            {notices.map((n) => (
              <p key={n.text} className={`text-[11px] leading-relaxed ${n.tone === "warn" ? "text-amber-500" : "text-fg-muted"}`}>{n.text}</p>
            ))}
          </div>
        )}

        <div className="px-4 pb-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-page px-3 py-2">
            <Search size={14} className="shrink-0 text-fg-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索分支…"
              className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 pb-4">
          {(menu.loading || (!data && !menu.error)) && (
            <p className="flex items-center justify-center gap-1.5 py-6 text-xs text-fg-muted"><Loader2 size={13} className="animate-spin" />读取分支…</p>
          )}
          {data && groups.length === 0 && <p className="py-6 text-center text-xs text-fg-muted">没有匹配的分支</p>}
          {groups.map((g) => (
            <div key={g.kind} className="space-y-1">
              <p className="px-1 pb-0.5 pt-2 text-[11px] text-fg-faint">{g.label}</p>
              {g.rows.map((row) => {
                const cur = !!row.option.current
                const busy = menu.switching === row.key
                return (
                  <button
                    key={row.key}
                    type="button"
                    disabled={row.disabled || (menu.switching !== null && !busy)}
                    aria-current={cur ? "true" : undefined}
                    onClick={() => void pick(row.option)}
                    className={`flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition disabled:opacity-45 ${
                      cur ? "border-blue-500/50 bg-blue-600/15 text-fg" : "border-line-subtle bg-page/60 text-fg-2"
                    }`}
                  >
                    {g.kind === "remote" ? <Cloud size={14} className="shrink-0 text-fg-muted" /> : <GitBranch size={14} className={`shrink-0 ${cur ? "text-accent" : "text-fg-muted"}`} />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{row.option.name}</span>
                      {row.note && <span className="mt-0.5 block truncate text-[10px] text-fg-muted">{row.note}</span>}
                    </span>
                    {busy ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : cur && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                )
              })}
              {g.hidden > 0 && <p className="px-1 py-1 text-[10.5px] text-fg-faint">还有 {g.hidden} 个，输入关键字缩小范围</p>}
            </div>
          ))}
          {menu.error && (
            <p className="rounded-xl border border-danger-line/40 bg-danger-tint/20 px-3 py-2 text-xs leading-relaxed text-danger">{menu.error}</p>
          )}
        </div>
      </div>
    </div>
  )
}

export function PairSheet({
  open,
  onClose,
  config,
  route,
  reconnecting,
  onSaveAndConnect,
}: {
  open: boolean
  onClose: () => void
  config: MobilePairConfig
  route: RouteStatus
  reconnecting: boolean
  onSaveAndConnect: (next: MobilePairConfig) => void
}) {
  const [pubUrl, setPubUrl] = useState(config.pubUrl)
  const [lanUrl, setLanUrl] = useState(config.lanUrl)
  const [token, setToken] = useState(config.token)
  const [preferRoute, setPreferRoute] = useState<"auto" | "pub" | "lan">(
    config.preferRoute ?? "auto",
  )
  const [pasteHint, setPasteHint] = useState("")
  const [scanOpen, setScanOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setScanOpen(false)
    setPubUrl(config.pubUrl)
    setLanUrl(config.lanUrl)
    setToken(config.token)
    setPreferRoute(config.preferRoute ?? "auto")
    setPasteHint("")
  }, [open, config])

  useBackToClose(open, onClose)
  const { panelRef, grip } = useSheetDrag(onClose)
  if (!open) return null

  const applyParsed = (parsed: MobilePairConfig) => {
    setPubUrl(parsed.pubUrl)
    setLanUrl(parsed.lanUrl)
    setToken(parsed.token)
    setPasteHint("已识别配对信息，正在连接…")
    onSaveAndConnect({
      pubUrl: parsed.pubUrl,
      lanUrl: parsed.lanUrl,
      token: parsed.token,
      hostName: parsed.hostName,
      preferRoute,
    })
  }

  const applyPastedText = (raw: string) => {
    const parsed = parsePairInput(raw)
    if (!parsed) {
      setPasteHint("未识别出配对信息，请复制电脑端配对链接或 JSON")
      return
    }
    applyParsed(parsed)
  }

  const handleScanDetect = (text: string): boolean => {
    const parsed = parsePairInput(text)
    if (!parsed) return false
    setScanOpen(false)
    applyParsed(parsed)
    return true
  }

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        setPasteHint("剪贴板为空")
        return
      }
      applyPastedText(text)
    } catch {
      setPasteHint("无法读取剪贴板，请直接粘贴到下方输入框")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div ref={panelRef} className="relative z-10 flex max-h-[88vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {grip}

        <div className="flex items-center justify-between px-4 pb-2 pt-1">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-accent" />
            <span className="text-sm font-semibold text-fg">电脑配对与线路切换</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-fg-muted">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 pb-4">
          {/* 当前连接状态卡片 */}
          <div className="rounded-2xl border border-line bg-page p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    route.connected ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                />
                <span className="text-xs font-semibold text-fg">
                  {route.connected
                    ? `已连接 · ${route.hostname || "电脑端"}`
                    : "尚未连接电脑端"}
                </span>
              </div>
              {route.connected && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                  {route.routeType === "lan" ? "局域网直连" : "公网连接"}
                  {route.latencyMs ? ` · ${route.latencyMs}ms` : ""}
                </span>
              )}
            </div>
            {!route.connected && route.error && (
              <p className="mt-1.5 text-[11px] text-amber-400">{route.error}</p>
            )}
          </div>

          {/* 扫码 / 从剪贴板导入配对信息 */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-sm transition active:scale-[0.99]"
            >
              <ScanLine size={16} />扫描电脑端二维码
            </button>
            <button
              type="button"
              onClick={() => void handlePasteFromClipboard()}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-blue-500/40 bg-blue-600/15 py-2.5 text-xs font-medium text-accent transition active:scale-[0.99]"
            >
              <ClipboardPaste size={14} />粘贴电脑端配对链接一键填入
            </button>
          </div>
          {pasteHint && (
            <p className="text-center text-[11px] text-accent">{pasteHint}</p>
          )}

          {/* 双线路地址与 Token */}
          <div className="space-y-2.5">
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-fg-2">
                <Cloud size={12} className="text-accent" />公网地址（离开局域网时使用）
              </label>
              <input
                type="url"
                value={pubUrl}
                onChange={(e) => {
                  const v = e.target.value
                  if (v.includes("pair=")) {
                    applyPastedText(v)
                    return
                  }
                  setPubUrl(v)
                }}
                placeholder="例如 https://ai.your-domain.com 或 http://1.2.3.4:19529"
                className="w-full rounded-xl border border-line bg-page px-3 py-2 font-mono text-xs text-fg focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-fg-2">
                <Wifi size={12} className="text-emerald-400" />局域网地址（同一 Wi-Fi 下自动直连）
              </label>
              <input
                type="url"
                value={lanUrl}
                onChange={(e) => setLanUrl(e.target.value)}
                placeholder="例如 http://192.168.1.100:19529"
                className="w-full rounded-xl border border-line bg-page px-3 py-2 font-mono text-xs text-fg focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-fg-2">
                <Server size={12} className="text-fg-muted" />访问令牌 (Bearer Token)
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="在电脑端「设置 → 手机端」复制或粘贴配对链接"
                className="w-full rounded-xl border border-line bg-page px-3 py-2 font-mono text-xs text-fg focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          {/* 线路选择策略 */}
          <div>
            <label className="mb-1.5 block text-xs text-fg-2">双线路切换策略</label>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: "auto", label: "智能择优(推荐)" },
                { id: "lan", label: "优先局域网" },
                { id: "pub", label: "优先公网" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPreferRoute(opt.id as "auto" | "pub" | "lan")}
                  className={`rounded-xl border py-2 text-xs font-medium transition ${
                    preferRoute === opt.id
                      ? "border-blue-500 bg-blue-600/20 text-accent"
                      : "border-line bg-page text-fg-3"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={reconnecting}
            onClick={() => {
              onSaveAndConnect({
                pubUrl,
                lanUrl,
                token,
                preferRoute,
              })
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2.5 text-xs font-semibold text-white shadow-sm transition active:scale-[0.99] disabled:opacity-50"
          >
            {reconnecting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            保存并测速连接
          </button>
        </div>
      </div>
      <QrScanner open={scanOpen} onClose={() => setScanOpen(false)} onDetect={handleScanDetect} />
    </div>
  )
}
