import { useEffect, useMemo, useState } from "react"
import {
  Check,
  ClipboardPaste,
  Cloud,
  Cpu,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageCircle,
  Monitor,
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
import { workspaceDirFromSessionKey } from "../shared/channel-types"
import { isTempChatWorkspace } from "../shared/temp-workspace"
import { sameChatSession } from "../renderer/components/chat/useAppChatItems"
import { modelSlug } from "../renderer/model-utils"
import { formatTimeAgo } from "../renderer/time-ago"
import {
  listMobileProviderModels,
  parsePairInput,
  type MobileChannelView,
  type MobileChatTab,
  type MobilePairConfig,
  type MobileQuickModel,
  type RouteStatus,
} from "./api"
import { useBackToClose } from "./back-stack"
import { QrScanner } from "./QrScanner"

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function dirName(dir: string | undefined): string | undefined {
  return dir?.split(/[\\/]/).filter(Boolean).pop()
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
  usageBytes,
  onSelect,
  onNewTemp,
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
  usageBytes: number | null
  onSelect: (sessionKey: string) => void
  onNewTemp: (channelId: string) => void
  onDelete: (t: MobileChatTab) => void
  onClearAll: () => void
  onOpenPair: () => void
}) {
  const now = Date.now()
  useBackToClose(open, onClose)
  if (!open) return null

  const defaultChannelId = views[0]?.channelId

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px] transition-opacity"
      />
      <aside className="relative z-10 flex h-full w-[82%] max-w-[320px] flex-col border-r border-line bg-surface pt-safe pb-safe shadow-2xl">
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
            <button
              type="button"
              onClick={() => {
                onNewTemp(defaultChannelId)
                onClose()
              }}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 py-2 text-xs font-medium text-white shadow-sm transition active:scale-[0.99]"
            >
              <Plus size={15} />新建临时会话
            </button>
          )}
        </div>

        {/* 会话列表 */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
          {views.map((v) => {
            const sortedTabs = [...v.tabs].sort(
              (a, b) => (activeAt(b) ?? 0) - (activeAt(a) ?? 0),
            )
            return (
              <div key={v.channelId}>
                {views.length > 1 && (
                  <p className="px-2 pb-1.5 text-[11px] font-medium text-fg-faint">
                    {v.name}
                  </p>
                )}
                <div className="space-y-1">
                  {sortedTabs.map((t) => {
                    const on = sameChatSession(t.sessionKey, selected)
                    const status = sessionStatus(t.sessionKey, t.running)
                    const at = activeAt(t)
                    const wsDir = workspaceDirFromSessionKey(t.sessionKey)
                    const isTemp = isTempChatWorkspace(wsDir)
                    const subText =
                      status === "working"
                        ? "AI 正在回复..."
                        : !isTemp && wsDir
                          ? dirName(wsDir)
                          : "临时对话"
                    const deletable = !!t.removable && t.kind !== "project"

                    return (
                      <div key={t.sessionKey} className="group relative flex items-center">
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
                              <MessageCircle
                                size={15}
                                className={on ? "text-accent" : "text-fg-faint"}
                              />
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

                        {deletable && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onDelete(t)
                            }}
                            title="删除会话"
                            className="ml-1 shrink-0 rounded-lg p-2 text-fg-faint transition active:bg-raised active:text-danger"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
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

export function ModelSheet({
  open,
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
}: {
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
}) {
  const [selectedResId, setSelectedResId] = useState<string>(
    currentResourceId || resources[0]?.id || "",
  )
  const [search, setSearch] = useState("")
  const [models, setModels] = useState<{ id: string; label?: string; current?: boolean }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    const targetRes = currentResourceId || resources[0]?.id || ""
    setSelectedResId(targetRes)
    setSearch("")
  }, [open, currentResourceId, resources])

  useEffect(() => {
    if (!open || !selectedResId || !baseUrl || !token) return
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
  }, [open, selectedResId, baseUrl, token, currentModel, currentParams])

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.label && m.label.toLowerCase().includes(q)),
    )
  }, [models, search])

  useBackToClose(open, onClose)
  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div className="relative z-10 flex max-h-[82vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {/* 顶部抓手 */}
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-strong" />

        <div className="flex items-center justify-between px-4 pb-2 pt-2.5">
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
                {quickModels.map((qm, idx) => {
                  const isCur =
                    qm.model === currentModel &&
                    (!qm.resourceId || qm.resourceId === currentResourceId)
                  const resName = resources.find((r) => r.id === qm.resourceId)?.name
                  return (
                    <button
                      key={`${qm.resourceId ?? ""}-${qm.model}-${idx}`}
                      type="button"
                      onClick={() => {
                        onSelect({
                          model: qm.model,
                          modelParams: qm.modelParams,
                          resourceId: qm.resourceId,
                        })
                        onClose()
                      }}
                      className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left transition active:scale-[0.98] ${
                        isCur
                          ? "border-blue-500 bg-blue-600/15 text-fg"
                          : "border-line bg-page/70 text-fg-2"
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-1">
                        <span className="truncate text-xs font-medium">
                          {qm.label || modelSlug(qm.model)}
                        </span>
                        {isCur && <Check size={12} className="shrink-0 text-accent" />}
                      </div>
                      <span className="mt-0.5 truncate text-[10px] text-fg-muted">
                        {resName || qm.model}
                      </span>
                    </button>
                  )
                })}
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
                      onClick={() => setSelectedResId(r.id)}
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
                {filteredModels.map((m) => {
                  const isCur =
                    (m.id === currentModel || m.current) &&
                    selectedResId === (currentResourceId || selectedResId)
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onSelect({
                          model: m.id,
                          resourceId: selectedResId,
                        })
                        onClose()
                      }}
                      className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition active:scale-[0.99] ${
                        isCur
                          ? "border-blue-500/50 bg-blue-600/15 text-fg"
                          : "border-line-subtle bg-page/60 text-fg-2"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{m.label || m.id}</p>
                        {m.label && m.label !== m.id && (
                          <p className="truncate font-mono text-[10px] text-fg-muted">{m.id}</p>
                        )}
                      </div>
                      {isCur && <Check size={14} className="shrink-0 text-accent" />}
                    </button>
                  )
                })}
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
  tabs,
  selected,
  sessionName,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  tabs: MobileChatTab[]
  selected: string | null
  sessionName: (t: MobileChatTab) => string
  onSelect: (sessionKey: string) => void
}) {
  useBackToClose(open, onClose)
  if (!open) return null
  const dirTabs = tabs.filter((t) => !isTempChatWorkspace(workspaceDirFromSessionKey(t.sessionKey)))

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative z-10 flex max-h-[70vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-strong" />
        <div className="flex items-center justify-between px-4 pb-2.5 pt-2.5">
          <div className="flex items-center gap-2">
            <FolderOpen size={16} className="text-accent" />
            <span className="text-sm font-semibold text-fg">切换工作区目录会话</span>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-fg-muted">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-4">
          {dirTabs.length === 0 ? (
            <p className="py-6 text-center text-xs text-fg-muted">暂无已打开的目录会话</p>
          ) : (
            dirTabs.map((t) => {
              const on = sameChatSession(t.sessionKey, selected)
              const ws = workspaceDirFromSessionKey(t.sessionKey)
              return (
                <button
                  key={t.sessionKey}
                  type="button"
                  onClick={() => {
                    onSelect(t.sessionKey)
                    onClose()
                  }}
                  className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition ${
                    on
                      ? "border-blue-500/50 bg-blue-600/15 text-fg"
                      : "border-line-subtle bg-page/60 text-fg-2"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{sessionName(t)}</span>
                      {t.branch && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-muted">
                          <GitBranch size={10} />
                          {t.branch}
                        </span>
                      )}
                    </div>
                    {ws && <p className="mt-0.5 truncate font-mono text-[10px] text-fg-muted">{ws}</p>}
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
      <div className="relative z-10 flex max-h-[88vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-strong" />

        <div className="flex items-center justify-between px-4 pb-2 pt-2.5">
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
