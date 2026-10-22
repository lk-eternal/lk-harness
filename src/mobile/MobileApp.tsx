import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  Cpu,
  Edit3,
  FolderOpen,
  GitBranch,
  ImagePlus,
  Loader2,
  Menu,
  Moon,
  MoreVertical,
  Send,
  Square,
  Sun,
  Trash2,
  X,
} from "lucide-react"
import { appChatSessionId, type AppChatItem } from "../shared/app-chat-types"
import { activityFromItems, applyActivityItem, isActivityBusy, type SessionActivity } from "./session-activity"
import {
  APP_CHANNEL_CHAT_ID,
  channelIdFromSessionKey,
  makeChatKey,
  workspaceDirFromSessionKey,
  type AgentResource,
} from "../shared/channel-types"
import { isTempChatWorkspace, tempWorkspaceCreatedAt } from "../shared/temp-workspace"
import { sameChatSession } from "../renderer/components/chat/useAppChatItems"
import { modelSlug } from "../renderer/model-utils"
import {
  applyMobileTheme,
  clearMobileSession,
  connectMobileEvents,
  createMobileTempSession,
  deleteMobileSession,
  fetchBootstrap,
  fetchHistory,
  loadMobileTheme,
  loadPairConfig,
  renameMobileSession,
  resolveBestRoute,
  savePairConfig,
  sendMobileMessage,
  setMobileSessionModel,
  stopMobileSession,
  uploadMobileImage,
  type MobileChannelView,
  type MobileChatTab,
  type MobilePairConfig,
  type MobileQuickModel,
  type MobileStreamMessage,
  type MobileTheme,
  type RouteStatus,
} from "./api"
import MobileItemList from "./MobileItems"
import { DirSheet, ModelSheet, PairSheet, SessionDrawer } from "./MobileModals"

interface DraftSession {
  channelId: string
  sessionKey: string
}

function upsertItems(prev: AppChatItem[], incoming: AppChatItem[]): AppChatItem[] {
  if (incoming.length === 0) return prev
  const next = prev.slice()
  const index = new Map(next.map((it, i) => [it.id, i]))
  for (const it of incoming) {
    const at = index.get(it.id)
    if (at === undefined) {
      index.set(it.id, next.length)
      next.push(it)
    } else {
      next[at] = it
    }
  }
  return next
}

function withDrafts(views: MobileChannelView[], drafts: DraftSession[]): MobileChannelView[] {
  if (drafts.length === 0) return views
  return views.map((v) => {
    const extra = drafts
      .filter(
        (d) =>
          d.channelId === v.channelId &&
          !v.tabs.some((t) => sameChatSession(t.sessionKey, d.sessionKey)),
      )
      .map(
        (d): MobileChatTab => ({
          sessionKey: d.sessionKey,
          label: "新会话",
          kind: "dir",
          running: false,
          current: false,
          removable: true,
        }),
      )
    return extra.length > 0 ? { ...v, tabs: [...extra, ...v.tabs] } : v
  })
}

function dirName(dir: string | undefined): string | undefined {
  return dir?.split(/[\\/]/).filter(Boolean).pop()
}

export default function MobileApp() {
  const [pairCfg, setPairCfg] = useState<MobilePairConfig>(() => loadPairConfig())
  const [route, setRoute] = useState<RouteStatus>({
    connected: false,
    activeUrl: "",
    routeType: "none",
  })
  const [reconnecting, setReconnecting] = useState(false)
  const [sseOnline, setSseOnline] = useState(false)

  // 主题状态
  const [theme, setTheme] = useState<MobileTheme>(() => loadMobileTheme())
  useEffect(() => {
    applyMobileTheme(theme)
  }, [theme])

  // 服务端数据
  const [hostname, setHostname] = useState("")
  const [serverViews, setServerViews] = useState<MobileChannelView[]>([])
  const [drafts, setDrafts] = useState<DraftSession[]>([])
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  const [quickModels, setQuickModels] = useState<MobileQuickModel[]>([])
  const [resources, setResources] = useState<AgentResource[]>([])
  const [usageBytes, setUsageBytes] = useState<number | null>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected

  // 会话运行与未读状态
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [activity, setActivity] = useState<Record<string, SessionActivity>>({})

  // 当前会话消息与输入状态
  const [items, setItems] = useState<AppChatItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [actionError, setActionError] = useState("")
  const [text, setText] = useState("")
  const [pendingImages, setPendingImages] = useState<{ path: string; previewUrl: string }[]>([])
  const [uploadingImage, setUploadingImage] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)

  // 抽屉与弹窗状态
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [dirSheetOpen, setDirSheetOpen] = useState(false)
  const [pairSheetOpen, setPairSheetOpen] = useState(() => !loadPairConfig().token)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState("")

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const views = useMemo(() => withDrafts(serverViews, drafts), [serverViews, drafts])
  const allTabs = useMemo(() => views.flatMap((v) => v.tabs), [views])
  const currentTab = useMemo(
    () => allTabs.find((t) => sameChatSession(t.sessionKey, selected)) ?? null,
    [allTabs, selected],
  )
  const ownerView = useMemo(
    () =>
      views.find((v) => v.tabs.some((t) => sameChatSession(t.sessionKey, selected))) ??
      views[0] ??
      null,
    [views, selected],
  )

  const refreshBootstrap = useCallback(
    async (baseUrl: string, token: string) => {
      if (!baseUrl || !token) return
      try {
        const data = await fetchBootstrap(baseUrl, token)
        if (!data.ok) return
        setHostname(data.hostname || "")
        setServerViews(data.channels ?? [])
        setTitles(data.titles ?? {})
        setLastActive((prev) => ({ ...prev, ...(data.lastActive ?? {}) }))
        setQuickModels(data.quickModels ?? [])
        setResources(data.resources ?? [])
        setUsageBytes(data.usageBytes ?? null)
        setDrafts((prev) =>
          prev.filter(
            (d) =>
              !(data.channels ?? []).some((c) =>
                c.tabs.some((t) => sameChatSession(t.sessionKey, d.sessionKey)),
              ),
          ),
        )
        setSelected((cur) => {
          const flat = (data.channels ?? []).flatMap((c) => c.tabs)
          if (cur && flat.some((t) => sameChatSession(t.sessionKey, cur))) return cur
          return data.channels?.[0]?.activeKey ?? flat[0]?.sessionKey ?? null
        })
      } catch {
        // ignore network hiccup
      }
    },
    [],
  )

  // 连接与线路择优
  const connectWithConfig = useCallback(
    async (cfg: MobilePairConfig) => {
      setReconnecting(true)
      setActionError("")
      const best = await resolveBestRoute(cfg)
      setRoute(best)
      setReconnecting(false)
      if (!best.connected) {
        setPairSheetOpen(true)
        return
      }
      setPairSheetOpen(false)
      await refreshBootstrap(best.activeUrl, cfg.token)
    },
    [refreshBootstrap],
  )

  useEffect(() => {
    void connectWithConfig(pairCfg)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 建立 SSE 实时流
  useEffect(() => {
    if (!route.connected || !route.activeUrl || !pairCfg.token) {
      setSseOnline(false)
      return
    }
    let refreshTimer = 0
    const handleStream = (msg: MobileStreamMessage) => {
      if (msg.type === "titles") {
        setTitles(msg.titles ?? {})
        return
      }
      if (msg.type === "sessions") {
        // 电脑端会话进程有启停：稍等片刻合并连续事件，再拉一次会话树刷新「回复中」状态
        window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => {
          void refreshBootstrap(route.activeUrl, pairCfg.token)
        }, 400)
        return
      }
      if (msg.type === "chat") {
        const ev = msg.event
        if (ev.type === "item") {
          const activityId = appChatSessionId(ev.sessionKey)
          setActivity((prev) => {
            const cur = prev[activityId]
            const next = applyActivityItem(cur, ev.item)
            return next === cur ? prev : { ...prev, [activityId]: next }
          })
          if (sameChatSession(ev.sessionKey, selectedRef.current)) {
            setItems((prev) => upsertItems(prev, [ev.item]))
          } else if (ev.item.kind === "assistant" && ev.item.finished) {
            setUnreadIds((prev) => new Set(prev).add(appChatSessionId(ev.sessionKey)))
          }
          setLastActive((prev) => ({
            ...prev,
            [appChatSessionId(ev.sessionKey)]: Date.now(),
          }))
          return
        }
        // cleared 事件
        setActivity((prev) => {
          if (!ev.sessionKey) return {}
          const clearedId = appChatSessionId(ev.sessionKey)
          if (!(clearedId in prev)) return prev
          const { [clearedId]: _dropped, ...rest } = prev
          return rest
        })
        const cur = selectedRef.current
        const hit = ev.sessionKey
          ? sameChatSession(ev.sessionKey, cur)
          : !!ev.channelId && !!cur && ev.channelId === channelIdFromSessionKey(cur)
        if (hit) setItems([])
      }
    }

    const disconnect = connectMobileEvents(
      route.activeUrl,
      pairCfg.token,
      handleStream,
      (online) => {
        setSseOnline(online)
        if (online) {
          void refreshBootstrap(route.activeUrl, pairCfg.token)
        }
      },
    )

    // 定期同步会话树（兜底新建目录/分支变化）
    const timer = window.setInterval(() => {
      void refreshBootstrap(route.activeUrl, pairCfg.token)
    }, 10000)

    return () => {
      disconnect()
      window.clearInterval(timer)
      window.clearTimeout(refreshTimer)
    }
  }, [route.connected, route.activeUrl, pairCfg.token, refreshBootstrap])

  // 选中会话变化：清除未读绿点并拉取历史消息
  useEffect(() => {
    setActionError("")
    setRenaming(false)
    if (!selected) {
      setItems([])
      return
    }
    const id = appChatSessionId(selected)
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (!route.connected || !route.activeUrl || !pairCfg.token) return
    let cancelled = false
    setHistoryLoading(true)
    setItems([])
    void fetchHistory(route.activeUrl, pairCfg.token, selected).then((r) => {
      if (cancelled) return
      setHistoryLoading(false)
      if (!r.ok) {
        setActionError(r.error ?? "读取历史消息失败")
        return
      }
      setItems((prev) => upsertItems(r.items ?? [], prev))
      setActivity((prev) => ({ ...prev, [id]: activityFromItems(r.items ?? []) }))
    })
    return () => {
      cancelled = true
    }
  }, [selected, route.connected, route.activeUrl, pairCfg.token])

  const sessionStatus = useCallback(
    (key: string, running: boolean): "idle" | "working" | "unread" => {
      const id = appChatSessionId(key)
      // 进程在线只是前提，还要有未收口的回合或待回应的用户消息才算「回复中」
      if (running && isActivityBusy(activity[id])) return "working"
      if (unreadIds.has(id) && !sameChatSession(key, selected)) return "unread"
      return "idle"
    },
    [activity, unreadIds, selected],
  )

  const sessionName = useCallback(
    (t: MobileChatTab): string => {
      const custom = titles[appChatSessionId(t.sessionKey)]
      if (custom) return custom
      return isTempChatWorkspace(workspaceDirFromSessionKey(t.sessionKey)) ? "新会话" : t.label
    },
    [titles],
  )

  const activeAt = useCallback(
    (t: MobileChatTab): number | undefined => {
      return (
        lastActive[appChatSessionId(t.sessionKey)] ??
        tempWorkspaceCreatedAt(workspaceDirFromSessionKey(t.sessionKey))
      )
    },
    [lastActive],
  )

  // 统计后台会话是否有未读或正在回复（用于顶部汉堡按钮角标）
  const hasBackgroundUnread = useMemo(
    () =>
      allTabs.some(
        (t) =>
          !sameChatSession(t.sessionKey, selected) &&
          sessionStatus(t.sessionKey, t.running) === "unread",
      ),
    [allTabs, selected, sessionStatus],
  )
  const hasBackgroundWorking = useMemo(
    () =>
      allTabs.some(
        (t) =>
          !sameChatSession(t.sessionKey, selected) &&
          sessionStatus(t.sessionKey, t.running) === "working",
      ),
    [allTabs, selected, sessionStatus],
  )

  const busy =
    (!!selected && sessionStatus(selected, !!currentTab?.running) === "working") ||
    items.some((it) => it.kind === "assistant" && !it.finished)

  const workspaceDir = selected ? workspaceDirFromSessionKey(selected) : undefined
  const isTemp = isTempChatWorkspace(workspaceDir)
  const workspaceLabel = isTemp ? "临时会话" : dirName(workspaceDir)

  const modelLabel = useMemo(() => {
    const m = currentTab?.model
    if (!m || m === "auto") return "默认模型"
    const hit = quickModels.find((q) => q.model === m && q.label)
    return hit?.label || modelSlug(m)
  }, [currentTab?.model, quickModels])

  // 发送消息
  const handleSend = async (overrideText?: string) => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    const msgText = (overrideText ?? text).trim()
    const imgs = pendingImages.map((i) => i.path)
    if (!msgText && imgs.length === 0) return

    if (overrideText === undefined) {
      setText("")
      setPendingImages([])
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto"
      }
    }
    setActionError("")
    const r = await sendMobileMessage(route.activeUrl, pairCfg.token, {
      sessionKey: selected,
      ...(msgText ? { text: msgText } : {}),
      ...(imgs.length > 0 ? { images: imgs } : {}),
    })
    if (!r.ok) {
      setActionError(r.error ?? "发送失败")
    }
  }

  // 回答问题卡片
  const handleAnswer = async (questionId: string, option: string) => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    setActionError("")
    const r = await sendMobileMessage(route.activeUrl, pairCfg.token, {
      sessionKey: selected,
      questionId,
      option,
    })
    if (!r.ok) {
      setActionError(r.error ?? "提交回答失败")
    }
  }

  // 停止当前回合
  const handleStop = async () => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    await stopMobileSession(route.activeUrl, pairCfg.token, selected)
  }

  // 新建临时会话
  const handleNewTempSession = async (channelId: string) => {
    if (!route.activeUrl || !pairCfg.token) return
    const r = await createMobileTempSession(route.activeUrl, pairCfg.token, channelId)
    if (!r.ok || !r.sessionKey) {
      setActionError(r.error ?? "创建会话失败")
      return
    }
    const key = r.sessionKey
    setDrafts((prev) => [...prev, { channelId, sessionKey: key }])
    setLastActive((prev) => ({ ...prev, [appChatSessionId(key)]: Date.now() }))
    setSelected(key)
  }

  // 删除会话
  const handleDeleteSession = async (t: MobileChatTab) => {
    if (!route.activeUrl || !pairCfg.token) return
    const key = t.sessionKey
    const id = appChatSessionId(key)
    setDrafts((prev) => prev.filter((d) => !sameChatSession(d.sessionKey, key)))
    const r = await deleteMobileSession(route.activeUrl, pairCfg.token, key)
    if (!r.ok) {
      setActionError(r.error ?? "删除会话失败")
      return
    }
    setTitles((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    await refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  // 重命名当前会话
  const submitRename = async () => {
    if (!selected || !route.activeUrl || !pairCfg.token) {
      setRenaming(false)
      return
    }
    const r = await renameMobileSession(route.activeUrl, pairCfg.token, selected, renameDraft)
    setRenaming(false)
    if (r.ok && r.titles) {
      setTitles(r.titles)
    }
  }

  // 清空当前会话
  const handleClearCurrent = async () => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    setMoreMenuOpen(false)
    await clearMobileSession(route.activeUrl, pairCfg.token, { sessionKey: selected })
    setItems([])
  }

  // 清空全部会话记录
  const handleClearAll = async () => {
    if (!route.activeUrl || !pairCfg.token) return
    for (const v of views) {
      await clearMobileSession(route.activeUrl, pairCfg.token, { channelId: v.channelId })
    }
    setItems([])
    await refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  // 切换模型
  const handleSelectModel = async (choice: {
    model: string
    modelParams?: string
    resourceId?: string
  }) => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    setModelBusy(true)
    setActionError("")
    const r = await setMobileSessionModel(route.activeUrl, pairCfg.token, {
      sessionKey: selected,
      model: choice.model,
      modelParams: choice.modelParams,
      resourceId: choice.resourceId,
    })
    setModelBusy(false)
    if (!r.ok) {
      setActionError(r.error ?? "切换模型失败")
      return
    }
    await refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  // 选择并上传图片
  const handlePickImages = async (files: FileList | null) => {
    if (!files || files.length === 0 || !route.activeUrl || !pairCfg.token) return
    setUploadingImage(true)
    setActionError("")
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result ?? ""))
          reader.onerror = () => reject(new Error("读取图片失败"))
          reader.readAsDataURL(file)
        })
        const ext = file.name.split(".").pop()?.toLowerCase() || "png"
        const r = await uploadMobileImage(route.activeUrl, pairCfg.token, dataUrl, ext)
        if (r.ok && r.path) {
          setPendingImages((prev) => [...prev, { path: r.path!, previewUrl: dataUrl }])
        } else {
          setActionError(r.error ?? "图片上传失败")
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "图片处理失败")
      }
    }
    setUploadingImage(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  return (
    <div className="flex h-full w-full flex-col bg-page text-fg">
      {/* ═══ 顶部导航栏 ═══ */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line-subtle bg-surface/90 px-3 pb-2.5 pt-safe backdrop-blur">
        {/* 汉堡菜单按钮（带后台未读绿点 / 后台运行蓝点） */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-fg-2 transition active:bg-raised"
        >
          <Menu size={19} />
          {hasBackgroundUnread ? (
            <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-surface" />
          ) : hasBackgroundWorking ? (
            <span className="absolute right-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-blue-500 ring-2 ring-surface" />
          ) : null}
        </button>

        {/* 中间会话标题 + 工作区与分支 */}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitRename()
                  if (e.key === "Escape") setRenaming(false)
                }}
                autoFocus
                className="w-full rounded-lg border border-blue-500 bg-page px-2 py-0.5 text-xs text-fg focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void submitRename()}
                className="rounded p-1 text-emerald-400"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!currentTab) return
                setRenameDraft(sessionName(currentTab))
                setRenaming(true)
              }}
              className="flex max-w-full flex-col items-start text-left"
            >
              <div className="flex max-w-full items-center gap-1">
                <span className="truncate text-[14px] font-semibold text-fg">
                  {currentTab ? sessionName(currentTab) : "LK Harness"}
                </span>
                {busy && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
              </div>
              <div className="flex max-w-full items-center gap-1 text-[11px] text-fg-muted">
                <span className="truncate">{workspaceLabel || hostname || "手机端对话"}</span>
                {currentTab?.branch && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-fg-faint">
                    · <GitBranch size={10} />
                    {currentTab.branch}
                  </span>
                )}
              </div>
            </button>
          )}
        </div>

        {/* 右侧线路状态胶囊 */}
        <button
          type="button"
          onClick={() => setPairSheetOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-page/80 px-2.5 py-1 text-[11px] text-fg-2 transition active:scale-95"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              route.connected && sseOnline
                ? "bg-emerald-500"
                : route.connected
                  ? "bg-blue-500"
                  : "bg-amber-500"
            }`}
          />
          <span>
            {route.connected
              ? `${route.routeType === "lan" ? "局域网" : "公网"}${
                  route.latencyMs ? ` · ${route.latencyMs}ms` : ""
                }`
              : "未连接"}
          </span>
        </button>

        {/* 更多操作菜单 */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMoreMenuOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-muted active:bg-raised"
          >
            <MoreVertical size={17} />
          </button>
          {moreMenuOpen && (
            <>
              <div
                onClick={() => setMoreMenuOpen(false)}
                className="fixed inset-0 z-30"
              />
              <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-2xl border border-line bg-surface p-1.5 shadow-xl">
                {currentTab && (
                  <button
                    type="button"
                    onClick={() => {
                      setMoreMenuOpen(false)
                      setRenameDraft(sessionName(currentTab))
                      setRenaming(true)
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-fg-2 active:bg-raised"
                  >
                    <Edit3 size={13} />重命名会话
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const next: MobileTheme =
                      theme === "dark" ? "light" : theme === "light" ? "system" : "dark"
                    setTheme(next)
                    setMoreMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-fg-2 active:bg-raised"
                >
                  {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
                  主题：{theme === "system" ? "跟随系统" : theme === "dark" ? "深色" : "浅色"}
                </button>
                {selected && (
                  <button
                    type="button"
                    onClick={() => void handleClearCurrent()}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-danger active:bg-raised"
                  >
                    <Trash2 size={13} />清空当前会话
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      {/* ═══ 中间对话消息区 ═══ */}
      {selected && route.connected ? (
        <MobileItemList
          key={selected}
          items={items}
          loading={historyLoading}
          busy={busy}
          workspaceName={workspaceLabel}
          sessionKey={selected}
          baseUrl={route.activeUrl}
          token={pairCfg.token}
          onAnswer={(q, o) => void handleAnswer(q, o)}
          onCommand={(cmd) => void handleSend(cmd)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-sm font-medium text-fg-2">
            {route.connected ? "选择或新建一个会话" : "尚未连接到电脑端"}
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {route.connected
              ? "点击左上角菜单切换会话或新建临时对话"
              : "请确保电脑端已开启「设置 → 手机端」，然后点击下方按钮配对"}
          </p>
          {!route.connected && (
            <button
              type="button"
              onClick={() => setPairSheetOpen(true)}
              className="mt-4 rounded-xl bg-blue-600 px-4 py-2 text-xs font-medium text-white shadow-sm"
            >
              配置电脑配对与线路
            </button>
          )}
        </div>
      )}

      {/* 错误提示条 */}
      {actionError && (
        <div className="shrink-0 bg-danger-tint/30 px-4 py-1.5 text-center text-xs text-danger">
          {actionError}
        </div>
      )}

      {/* ═══ 底部输入栏（避让手势横条） ═══ */}
      <footer className="shrink-0 border-t border-line-subtle bg-surface/95 px-3 pt-2 pb-safe backdrop-blur">
        {/* 待发送图片缩略图列表 */}
        {pendingImages.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
            {pendingImages.map((img, idx) => (
              <div key={img.path} className="relative shrink-0">
                <img
                  src={img.previewUrl}
                  alt=""
                  className="h-14 w-14 rounded-xl border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    setPendingImages((prev) => prev.filter((_, i) => i !== idx))
                  }
                  className="absolute -right-1 -top-1 rounded-full bg-black/80 p-0.5 text-white"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 上方快捷胶囊栏：目录 · 模型 · 发图 */}
        <div className="mb-2 flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setDirSheetOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-page px-2.5 py-1 text-[11px] text-fg-2 transition active:scale-95"
          >
            <FolderOpen size={12} className="text-accent" />
            <span className="max-w-[110px] truncate">{workspaceLabel || "切换目录"}</span>
            <ChevronDown size={11} className="text-fg-muted" />
          </button>

          <button
            type="button"
            onClick={() => setModelSheetOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-page px-2.5 py-1 text-[11px] text-fg-2 transition active:scale-95"
          >
            <Cpu size={12} className="text-accent" />
            <span className="max-w-[130px] truncate">{modelLabel}</span>
            {modelBusy ? (
              <Loader2 size={11} className="animate-spin text-accent" />
            ) : (
              <ChevronDown size={11} className="text-fg-muted" />
            )}
          </button>

          <button
            type="button"
            disabled={uploadingImage}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-page px-2.5 py-1 text-[11px] text-fg-2 transition active:scale-95 disabled:opacity-50"
          >
            {uploadingImage ? (
              <Loader2 size={12} className="animate-spin text-accent" />
            ) : (
              <ImagePlus size={12} className="text-accent" />
            )}
            <span>发图</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handlePickImages(e.target.files)}
          />
        </div>

        {/* 输入框 + 发送/停止按钮 */}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            disabled={!selected || !route.connected}
            onChange={(e) => {
              setText(e.target.value)
              const el = e.target
              el.style.height = "auto"
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!busy) void handleSend()
              }
            }}
            placeholder={
              route.connected
                ? "发消息给电脑端 Agent…"
                : "请先配对连接电脑端…"
            }
            className="max-h-[120px] min-h-[38px] flex-1 resize-none rounded-2xl border border-line bg-page px-3.5 py-2 text-[14px] leading-snug text-fg focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />

          {busy ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              title="停止当前回合"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-rose-600 text-white shadow-sm transition active:scale-90"
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              disabled={
                !selected ||
                !route.connected ||
                (!text.trim() && pendingImages.length === 0)
              }
              onClick={() => void handleSend()}
              title="发送"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm transition active:scale-90 disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </footer>

      {/* ═══ 抽屉与底部弹窗 ═══ */}
      <SessionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        hostname={hostname}
        route={route}
        views={views}
        selected={selected}
        sessionName={sessionName}
        sessionStatus={sessionStatus}
        activeAt={activeAt}
        usageBytes={usageBytes}
        onSelect={setSelected}
        onNewTemp={(chId) => void handleNewTempSession(chId)}
        onDelete={(t) => void handleDeleteSession(t)}
        onClearAll={() => void handleClearAll()}
        onOpenPair={() => setPairSheetOpen(true)}
      />

      <ModelSheet
        open={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        baseUrl={route.activeUrl}
        token={pairCfg.token}
        resources={resources}
        quickModels={quickModels}
        currentResourceId={currentTab?.resourceId ?? ownerView?.agentResourceId}
        currentModel={currentTab?.model}
        currentParams={currentTab?.modelParams}
        switching={modelBusy}
        onSelect={(choice) => void handleSelectModel(choice)}
      />

      <DirSheet
        open={dirSheetOpen}
        onClose={() => setDirSheetOpen(false)}
        tabs={allTabs}
        selected={selected}
        sessionName={sessionName}
        onSelect={setSelected}
      />

      <PairSheet
        open={pairSheetOpen}
        onClose={() => setPairSheetOpen(false)}
        config={pairCfg}
        route={route}
        reconnecting={reconnecting}
        onSaveAndConnect={(next) => {
          savePairConfig(next)
          setPairCfg(next)
          void connectWithConfig(next)
        }}
      />
    </div>
  )
}
