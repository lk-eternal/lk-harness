import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import {
  Check,
  ChevronDown,
  Cpu,
  Download,
  Edit3,
  FolderKanban,
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
import { appChatSessionDir, appChatSessionId, appChatSessionName, canRebindSessionDir, chatDirOptions, chatStreamItems, isQueuedUserItem, planDirChoice, sameChatDir, upsertChatItems as upsertItems, type AppChatItem } from "../shared/app-chat-types"
import { HISTORY_PAGE_LIMIT, historyCursorOf, isBeyondLoadedWindow, keepsLoadedHistory, replaceHistoryTail, type HistoryCursor } from "../shared/app-chat-history-page"
import { slashMenuItems } from "../shared/command-catalog"
import { createDraftStore } from "../shared/composer-drafts"
import { hideDeletedTabs, markSessionDeleted, type DeletedSessions } from "../shared/deleted-sessions"
import { pickDefaultTab } from "../shared/session-archive"
import { isSessionPinned, parsePinnedIds, setSessionPinned } from "../shared/app-chat-pins"
import { canSwitchBranch, isDetachedLabel, makeBranchOverride, sharedSessionCount, shownBranch, type BranchOverride } from "../shared/git-branch"
import { activityFromItems, applyActivityItem, isActivityBusy, type SessionActivity } from "./session-activity"
import {
  APP_CHANNEL_CHAT_ID,
  channelIdFromSessionKey,
  makeChatKey,
  workspaceDirFromSessionKey,
  type AgentResource,
} from "../shared/channel-types"
import { projectIdOfSessionKey, type ProjectCreateResult } from "../shared/project-app-types"
import { isTempChatWorkspace, tempWorkspaceCreatedAt } from "../shared/temp-workspace"
import { ImageLightbox } from "../renderer/components/chat/ImageLightbox"
import QueuedStrip from "../renderer/components/chat/QueuedStrip"
import { sendNowOutcome, type SendNowOutcome } from "../renderer/components/chat/queued-strip-text"
import { sameChatSession } from "../renderer/components/chat/useAppChatItems"
import useInlineModal from "../renderer/components/useInlineModal"
import { currentModelLabel } from "./model-choice"
import {
  applyMobileTheme,
  clearMobileSession,
  connectMobileEvents,
  createMobileTempSession,
  deleteMobileSession,
  editMobileQueued,
  fetchBootstrap,
  fetchHistory,
  fetchSessionModels,
  imageExtOf,
  loadMobileTheme,
  loadPairConfig,
  removeMobileQueued,
  renameMobileSession,
  resolveBestRoute,
  savePairConfig,
  sendMobileMessage,
  sendMobileQueuedNow,
  setMobileSessionDir,
  setMobileSessionModel,
  setMobileSessionPinned,
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
import { useBackToClose } from "./back-stack"
import { composerAction } from "./composer-action"
import { isTouchPrimary, shouldSendOnEnter } from "./enter-key"
import MobileItemList from "./MobileItems"
import { BranchSheet, DirSheet, ModelSheet, PairSheet, SessionDrawer } from "./MobileModals"
import MobileProjectBar, { NewProjectSheet } from "./MobileProject"
import { installExternalLinkHandler } from "./external-links"
import { installNativeBackHandler } from "./native-back"
import { withDrafts, type DraftSession, type TabModel } from "./session-drafts"
import SlashMenu from "./SlashMenu"
import UpdateBanner from "./UpdateBanner"
import { describeUpdateStatus } from "./update-controller"
import { useAppUpdate } from "./useAppUpdate"
import { useDrawerSwipe } from "./useDrawerSwipe"

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
  const [resyncTick, setResyncTick] = useState(0)

  // 主题状态
  const [theme, setTheme] = useState<MobileTheme>(() => loadMobileTheme())
  useEffect(() => {
    applyMobileTheme(theme)
  }, [theme])

  // 服务端数据
  const [hostname, setHostname] = useState("")
  const [serverViews, setServerViews] = useState<MobileChannelView[]>([])
  const [drafts, setDrafts] = useState<DraftSession[]>([])
  const [draftModels, setDraftModels] = useState<Record<string, TabModel>>({})
  /** 刚给会话选的工作目录：草稿会话不在服务端的会话树里，选完到服务端带回来之前先用本地的 */
  const [pickedDirs, setPickedDirs] = useState<Record<string, string>>({})
  const [titles, setTitles] = useState<Record<string, string>>({})
  /** 置顶的会话：存在电脑端，和桌面端对话页同一份 */
  const [pins, setPins] = useState<readonly string[]>([])
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  const [quickModels, setQuickModels] = useState<MobileQuickModel[]>([])
  const [resources, setResources] = useState<AgentResource[]>([])
  const [usageBytes, setUsageBytes] = useState<number | null>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected
  // 拉历史期间收到的实时消息：快照可能早于这些消息，整体替换列表时要补回去
  const liveBufferRef = useRef<Map<string, AppChatItem> | null>(null)
  // 上一次拉历史对应的「会话+地址+令牌」；没变说明只是实时流重连，不需要清空列表
  const historyKeyRef = useRef("")
  // 实时流是否连上过；之后的每次（重）连都要重拉历史补漏
  const sseEverOnlineRef = useRef(false)

  // 会话运行与未读状态
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [activity, setActivity] = useState<Record<string, SessionActivity>>({})

  // 当前会话消息与输入状态
  const [items, setItems] = useState<AppChatItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // 历史按页加载：items 只是最近的一段，hasMore 表示更早的还在电脑端；cursorRef 是已加载部分的最早一条
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const cursorRef = useRef<HistoryCursor | undefined>(undefined)
  const loadingEarlierRef = useRef(false)
  // 加载窗口每重置一次（换会话、被清空、补漏接不上）加一：往前翻页在途时窗口变了，返回的旧页要丢掉
  const historyGenRef = useRef(0)
  const itemsRef = useRef<AppChatItem[]>([])
  itemsRef.current = items
  const resetLoadWindow = useCallback((cursor: HistoryCursor | undefined, more: boolean) => {
    historyGenRef.current += 1
    loadingEarlierRef.current = false
    setLoadingEarlier(false)
    cursorRef.current = cursor
    setHasMore(more)
  }, [])
  const [actionError, setActionError] = useState("")
  // 输入框草稿按会话分开存：A 会话没发出去的字和图，切到/新建 B 会话时不会带过去，切回来还在
  const [draftStore] = useState(() => createDraftStore<{ path: string; previewUrl: string }>())
  const draftKey = selected ? appChatSessionId(selected) : null
  const getDraft = () => draftStore.get(draftKey)
  const { text, images: pendingImages } = useSyncExternalStore(draftStore.subscribe, getDraft, getDraft)
  const setText = (value: string) => draftStore.update(draftKey, (d) => ({ ...d, text: value }))
  /** 正在放大查看的待发送图片 */
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)

  // 抽屉与弹窗状态
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [dirSheetOpen, setDirSheetOpen] = useState(false)
  const [branchSheetOpen, setBranchSheetOpen] = useState(false)
  /** 刚切完分支、会话树还没刷新到：顶栏先显示新分支（见 shownBranch） */
  const [branchOverride, setBranchOverride] = useState<BranchOverride | null>(null)
  /** 正在为哪个通道新建项目（项目归这个通道） */
  const [newProjectFor, setNewProjectFor] = useState<string | null>(null)
  /** 刚建好的项目会话：等它出现在会话列表里再切过去（直接选一个列表里还没有的会话，会被「选中项失效」回落掉） */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [pairSheetOpen, setPairSheetOpen] = useState(() => !loadPairConfig().token)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState("")
  const { showConfirm, dismiss: dismissConfirm, ModalPortal } = useInlineModal()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // `/` 指令菜单：敲 `/` 给候选，点选填入「/指令 」。输入框失焦（点到别处）先收起，再输入或重新聚焦又出来
  const [slashDismissed, setSlashDismissed] = useState(false)
  // 失焦后稍等再收起：点菜单项时部分浏览器仍会先让输入框失焦，立刻收起会让这次点击落空
  const slashBlurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const slashItems = !selected || !route.connected || slashDismissed ? [] : slashMenuItems(text)
  const pickSlash = (cmd: string) => {
    clearTimeout(slashBlurTimer.current)
    setSlashDismissed(false)
    setText(`${cmd} `)
    textareaRef.current?.focus()
  }
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  /** 刚删除的会话：删除前发出的那次刷新可能晚返回，带着已删会话盖掉列表，命中这里的先不显示 */
  const deletedRef = useRef<DeletedSessions>(new Map())

  const views = useMemo(() => withDrafts(serverViews, drafts, draftModels), [serverViews, drafts, draftModels])
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

  // 选中项失效（首次进入、会话被删）时回落到通道当前会话或第一个；草稿会话在 views 里，不会被误判失效
  useEffect(() => {
    const withTabs = views.filter((v) => v.tabs.length > 0)
    if (withTabs.length === 0) {
      if (selected) setSelected(null)
      return
    }
    if (withTabs.flatMap((v) => v.tabs).some((t) => sameChatSession(t.sessionKey, selected))) return
    const first = withTabs[0]
    // 默认进没归档的会话，别一进来就落在收起来的归档分组里
    const pick = pickDefaultTab(first.tabs, first.activeKey, sameChatSession) ?? first.tabs[0]
    setSelected(pick.sessionKey)
  }, [views, selected])

  // 刚建好的项目会话一出现在列表里就切过去；等太久（列表读失败等）就放弃，不霸占用户之后的选择
  useEffect(() => {
    if (!pendingSelect) return
    if (allTabs.some((t) => sameChatSession(t.sessionKey, pendingSelect))) {
      setSelected(pendingSelect)
      setPendingSelect(null)
    }
  }, [allTabs, pendingSelect])
  useEffect(() => {
    if (!pendingSelect) return
    const timer = window.setTimeout(() => setPendingSelect(null), 20000)
    return () => window.clearTimeout(timer)
  }, [pendingSelect])

  /** 当前会话是项目会话时的项目 id */
  const projectId = currentTab?.kind === "project" ? projectIdOfSessionKey(currentTab.sessionKey) : undefined

  const refreshBootstrap = useCallback(
    async (baseUrl: string, token: string) => {
      if (!baseUrl || !token) return
      try {
        const data = await fetchBootstrap(baseUrl, token)
        if (!data.ok) return
        setHostname(data.hostname || "")
        setServerViews(hideDeletedTabs(data.channels ?? [], deletedRef.current))
        setTitles(data.titles ?? {})
        setPins(parsePinnedIds(data.pins))
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
      } catch {
        // ignore network hiccup
      }
    },
    [],
  )

  // 草稿会话不在服务端会话树里，它的模型单独向服务端读（与桌面端 ChatPage 同口径）；草稿增减时重读。
  // 用拼接后的字符串当依赖：refreshBootstrap 每次都会产出新的 drafts 数组，按数组引用会反复请求
  const draftKeysSig = useMemo(() => drafts.map((d) => d.sessionKey).join("\n"), [drafts])
  const refreshDraftModels = useCallback(async () => {
    if (!draftKeysSig) {
      setDraftModels((prev) => (Object.keys(prev).length > 0 ? {} : prev))
      return
    }
    if (!route.activeUrl || !pairCfg.token) return
    const r = await fetchSessionModels(route.activeUrl, pairCfg.token, draftKeysSig.split("\n"))
    if (r.ok && r.models) setDraftModels(r.models)
  }, [draftKeysSig, route.activeUrl, pairCfg.token])
  useEffect(() => {
    void refreshDraftModels()
  }, [refreshDraftModels])

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

  // App 里的更新检查（只在 APK 里生效）：连上电脑端后查，之后每次回到前台再查，失败会自己重试；菜单里可手动检查。
  // 自动检查失败一律静默，不打扰对话（见 update-controller.ts）
  const appUpdate = useAppUpdate({
    baseUrl: route.activeUrl,
    token: pairCfg.token,
    connected: route.connected,
    onError: setActionError,
  })

  // APK 里点聊天中的链接：交给系统浏览器，不让 WebView 自己跳走。
  // 跳走后聊天界面被目标页替换，而 APK 里没人处理返回键，按返回会直接退出应用、回不到会话
  useEffect(() => installExternalLinkHandler(setActionError), [])

  // APK 里的返回键：有浮层先关浮层，没有就退到后台。原生壳自己不会替页面做这件事（见 native-back.ts）
  useEffect(() => installNativeBackHandler(), [])

  // 线路重选：Wi-Fi ↔ 移动网络切换后原地址可能已不通，而实时流只会对着它一直重试
  const pairCfgRef = useRef(pairCfg)
  pairCfgRef.current = pairCfg
  const reselectingRef = useRef(false)
  const reselectRoute = useCallback(async () => {
    const cfg = pairCfgRef.current
    if (!cfg.token || reselectingRef.current) return
    reselectingRef.current = true
    try {
      const best = await resolveBestRoute(cfg)
      // 两条线路都不通就不动：实时流自己会重试，也不该在后台把配对弹窗弹出来；
      // 探测期间配置被改过（重新配对）则丢弃本次结果
      if (best.connected && pairCfgRef.current === cfg) setRoute(best)
    } finally {
      reselectingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!route.connected) return
    const onOnline = () => void reselectRoute()
    const onVisible = () => {
      if (document.visibilityState === "visible") void reselectRoute()
    }
    window.addEventListener("online", onOnline)
    document.addEventListener("visibilitychange", onVisible)
    // 实时流断着时网络事件可能漏掉，周期性兜底
    const timer = sseOnline ? 0 : window.setInterval(() => void reselectRoute(), 15000)
    return () => {
      window.removeEventListener("online", onOnline)
      document.removeEventListener("visibilitychange", onVisible)
      window.clearInterval(timer)
    }
  }, [route.connected, sseOnline, reselectRoute])

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
      if (msg.type === "pins") {
        setPins(parsePinnedIds(msg.pins))
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
            liveBufferRef.current?.set(ev.item.id, ev.item)
            // 落在还没加载的更早区域的旧项（如旧问题卡收口）不并入，否则列表顶部凭空多出一条、和窗口之间缺一段
            setItems((prev) => (isBeyondLoadedWindow(ev.item, cursorRef.current, prev) ? prev : upsertItems(prev, [ev.item])))
          } else if (ev.item.kind === "assistant" && ev.item.finished) {
            setUnreadIds((prev) => new Set(prev).add(appChatSessionId(ev.sessionKey)))
          }
          setLastActive((prev) => ({
            ...prev,
            [appChatSessionId(ev.sessionKey)]: Date.now(),
          }))
          return
        }
        if (ev.type === "remove") {
          // 电脑端暂存区里撤回了一条排队消息
          if (sameChatSession(ev.sessionKey, selectedRef.current)) {
            liveBufferRef.current?.delete(ev.itemId)
            setItems((prev) => (prev.some((it) => it.id === ev.itemId) ? prev.filter((it) => it.id !== ev.itemId) : prev))
          }
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
        if (hit) {
          resetLoadWindow(undefined, false)
          setItems([])
        }
      }
    }

    const disconnect = connectMobileEvents(
      route.activeUrl,
      pairCfg.token,
      handleStream,
      (online) => {
        setSseOnline(online)
        if (!online) return
        void refreshBootstrap(route.activeUrl, pairCfg.token)
        // 断线期间错过的消息只能靠重拉当前会话历史补回；第一次连上时历史由下面的 effect 负责。
        // 标记放在组件级：换线路后的新连接同样要补漏
        if (sseEverOnlineRef.current) setResyncTick((n) => n + 1)
        sseEverOnlineRef.current = true
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
  }, [route.connected, route.activeUrl, pairCfg.token, refreshBootstrap, resetLoadWindow])

  // 选中会话变化：清除未读绿点，收起重命名
  useEffect(() => {
    setRenaming(false)
    if (!selected) return
    const id = appChatSessionId(selected)
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [selected])

  // 拉取当前会话历史（只要最近一页，更早的点「加载更早的消息」再取）；
  // 实时流重连（resyncTick）后再拉一次，补回断线期间错过的消息
  useEffect(() => {
    setActionError("")
    if (!selected) {
      historyKeyRef.current = ""
      resetLoadWindow(undefined, false)
      setItems([])
      return
    }
    if (!route.connected || !route.activeUrl || !pairCfg.token) return
    const id = appChatSessionId(selected)
    // 换会话/令牌才清空重载；实时流重连（resyncTick）、线路切换（同一台电脑换条路）时保留旧列表，
    // 拉回来后一次性替换，避免网络刚恢复就闪空白、拉取失败时列表被清掉
    const key = `${selected}\n${pairCfg.token}`
    const fresh = historyKeyRef.current !== key
    historyKeyRef.current = key
    const live = new Map<string, AppChatItem>()
    liveBufferRef.current = live
    let cancelled = false
    if (fresh) {
      resetLoadWindow(undefined, false)
      setHistoryLoading(true)
      setItems([])
    }
    void fetchHistory(route.activeUrl, pairCfg.token, selected, { limit: HISTORY_PAGE_LIMIT }).then((r) => {
      if (cancelled) return
      liveBufferRef.current = null
      setHistoryLoading(false)
      if (!r.ok) {
        setActionError(r.error ?? "读取历史消息失败")
        return
      }
      const page = r.items ?? []
      const pageCursor = historyCursorOf(page)
      // 回复进度也要用并入实时流之后的列表算：拉取期间先到的收口事件，不能被更早生成的旧快照盖回「还在回复」；
      // 比这一页起点还早的实时旧项不并入
      const tail = upsertItems(page, [...live.values()].filter((it) => !isBeyondLoadedWindow(it, pageCursor, page)))
      if (!fresh && keepsLoadedHistory(cursorRef.current, itemsRef.current, tail)) {
        // 补漏：用户已经往前翻出来的更早记录保留，只换最近这一段
        setItems((prev) => replaceHistoryTail(prev, tail))
      } else {
        resetLoadWindow(pageCursor, !!r.hasMore)
        setItems(tail)
      }
      setActivity((prev) => ({ ...prev, [id]: activityFromItems(tail) }))
    })
    return () => {
      cancelled = true
      if (liveBufferRef.current === live) liveBufferRef.current = null
    }
  }, [selected, route.connected, route.activeUrl, pairCfg.token, resyncTick, resetLoadWindow])

  // 往前翻一页：以已加载的最早一条为游标，把更早的一页接到列表顶部
  const loadEarlier = useCallback(async () => {
    const cursor = cursorRef.current
    const key = selectedRef.current
    if (!key || !cursor || loadingEarlierRef.current || !route.activeUrl || !pairCfg.token) return
    const gen = historyGenRef.current
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    const r = await fetchHistory(route.activeUrl, pairCfg.token, key, {
      limit: HISTORY_PAGE_LIMIT,
      beforeId: cursor.id,
      beforeTs: cursor.ts,
    })
    // 期间换了会话或窗口被重置：这一页不属于当前列表（重置时加载状态已经清掉）
    if (gen !== historyGenRef.current) return
    loadingEarlierRef.current = false
    setLoadingEarlier(false)
    if (!r.ok) {
      setActionError(r.error ?? "读取历史消息失败")
      return
    }
    const page = r.items ?? []
    cursorRef.current = historyCursorOf(page) ?? cursor
    setHasMore(!!r.hasMore)
    setItems((prev) => upsertItems(prev, page))
  }, [route.activeUrl, pairCfg.token])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [text])

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

  /** 用户给会话选的工作目录：服务端带回来的优先，刚选还没刷新到的用本地的 */
  const boundDirOf = useCallback((t: MobileChatTab): string | undefined => t.boundDir ?? pickedDirs[t.sessionKey], [pickedDirs])

  const sessionName = useCallback(
    // 和桌面端对话页、工作台共用同一条命名规则：标题 > 选了目录的显示目录名 > 临时会话叫「新会话」 > 目录名（不带「（主）」和分支）
    (t: MobileChatTab): string => appChatSessionName(t.sessionKey, titles, t.label, boundDirOf(t)) ?? t.label,
    [titles, boundDirOf],
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
  // 电脑端暂存区里排队中的消息（Agent 还没收到）不进聊天流，投递后才出现
  const streamItems = useMemo(() => chatStreamItems(items), [items])
  const queuedItems = useMemo(() => items.filter(isQueuedUserItem), [items])
  const hasContent = text.trim() !== "" || pendingImages.length > 0

  // 会话的工作目录：用户选的优先；没选过目录的临时会话没有（它自己的临时文件夹对用户不可见）
  const workspaceDir = selected ? appChatSessionDir(selected, currentTab ? boundDirOf(currentTab) : undefined) : undefined
  const isTemp = !workspaceDir && isTempChatWorkspace(selected ? workspaceDirFromSessionKey(selected) : undefined)
  const workspaceLabel = isTemp ? "临时会话" : dirName(workspaceDir)
  // 目录菜单：这个通道里各会话在用的目录（电脑上的真实目录，手机选不了电脑上没用过的目录）
  const dirOptions = useMemo(() => chatDirOptions(ownerView?.tabs ?? [], boundDirOf), [ownerView, boundDirOf])
  // 草稿会话还没发过消息，可以直接改目录；其它（服务端已有的、或这里已经有记录的）目录定了不能换，
  // 选目录会用它新开一个会话。注意不能用 lastActive 判断：新建草稿时会把它写成当前时间
  const sessionStarted = !!selected && (!drafts.some((d) => sameChatSession(d.sessionKey, selected)) || items.length > 0)
  const canRebindDir = !!selected && canRebindSessionDir(selected, sessionStarted)

  // 分支是工作目录的：用这个目录的会话（含自己）都受切换影响；其中有在回复的，现在就不能切（电脑端会再核对）。项目会话的分支由项目管，只显示
  const branchLabel = shownBranch(currentTab?.branch, branchOverride, Date.now())
  const branchTabs = (ownerView?.tabs ?? []).filter((t) => t.kind !== "project")
  const branchDirOf = (t: MobileChatTab) => appChatSessionDir(t.sessionKey, boundDirOf(t))
  const branchShared = sharedSessionCount(branchTabs, branchDirOf, workspaceDir)
  const branchWorking = branchTabs.some((t) => sameChatDir(branchDirOf(t), workspaceDir) && sessionStatus(t.sessionKey, t.running) === "working")
  const canPickBranch = !!branchLabel && !!workspaceDir && !!currentTab && canSwitchBranch(currentTab.kind)

  // 同模型有好几档推理参数：名字要按模型 + 参数找，否则几档都显示成同一个名字
  const modelLabel = useMemo(
    () => currentModelLabel(currentTab?.model, currentTab?.modelParams, quickModels),
    [currentTab?.model, currentTab?.modelParams, quickModels],
  )

  // 发送消息
  const handleSend = async (overrideText?: string) => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    const msgText = (overrideText ?? text).trim()
    const imgs = pendingImages.map((i) => i.path)
    if (!msgText && imgs.length === 0) return

    const draftText = text
    const draftImages = pendingImages
    // 发送是异步的，期间用户可能已经切到别的会话：失败要放回发出消息的那个会话，不是当前会话
    const sendKey = draftKey
    if (overrideText === undefined) draftStore.discard(sendKey)
    setActionError("")
    const r = await sendMobileMessage(route.activeUrl, pairCfg.token, {
      sessionKey: selected,
      ...(msgText ? { text: msgText } : {}),
      ...(imgs.length > 0 ? { images: imgs } : {}),
    })
    if (r.ok) return
    setActionError(r.error ?? "发送失败")
    if (overrideText === undefined) {
      // 没发出去的内容放回输入框；期间用户已重新输入的内容优先
      draftStore.update(sendKey, (d) => ({
        text: d.text || draftText,
        images: d.images.length > 0 ? d.images : draftImages,
      }))
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

  // 暂存区：Agent 干活时发出的消息先排在输入框上方，这里可以改、撤回、让它立刻发出
  const handleEditQueued = async (id: string, newText: string): Promise<boolean> => {
    if (!selected || !route.activeUrl || !pairCfg.token) return false
    const r = await editMobileQueued(route.activeUrl, pairCfg.token, selected, id, newText)
    if (!r.ok) setActionError(r.error ?? "修改失败")
    return r.ok
  }

  const handleRemoveQueued = async (id: string) => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    const r = await removeMobileQueued(route.activeUrl, pairCfg.token, selected, id)
    if (!r.ok) setActionError(r.error ?? "撤回失败")
  }

  const handleSendQueuedNow = async (): Promise<SendNowOutcome> => {
    if (!selected || !route.activeUrl || !pairCfg.token) return "none"
    const r = await sendMobileQueuedNow(route.activeUrl, pairCfg.token, selected)
    if (!r.ok) setActionError(r.error ?? "发送失败")
    return sendNowOutcome(r)
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

  // 新建项目建好了：收起弹层，刷新列表，项目会话一出现就切过去
  const handleProjectCreated = (r: ProjectCreateResult) => {
    setNewProjectFor(null)
    if (r.warning) setActionError(r.warning)
    if (r.sessionKey) setPendingSelect(r.sessionKey)
    const { activeUrl } = route
    const { token } = pairCfg
    void refreshBootstrap(activeUrl, token)
    // 刚进入的会话要等电脑端登记路由才进列表，补刷几次，不用等下一次推送
    for (const ms of [600, 1800]) window.setTimeout(() => { void refreshBootstrap(activeUrl, token) }, ms)
  }

  // 项目已在项目栏里删除：和删普通会话一样，先把它从列表拿掉，再刷新
  const handleProjectDeleted = async (t: MobileChatTab) => {
    const key = t.sessionKey
    const id = appChatSessionId(key)
    setDrafts((prev) => prev.filter((d) => !sameChatSession(d.sessionKey, key)))
    draftStore.discard(id)
    setTitles((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    markSessionDeleted(deletedRef.current, key)
    setServerViews((prev) => hideDeletedTabs(prev, deletedRef.current))
    await refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  /** 项目归档 / 取消归档成功：先在本地列表里改掉，马上归到对的分组；再读一次，在途的刷新晚到会把它盖回去，所以稍后补读 */
  const handleProjectArchiveChanged = (key: string, archived: boolean) => {
    setServerViews((prev) => prev.map((v) => ({
      ...v,
      tabs: v.tabs.map((t) => (sameChatSession(t.sessionKey, key) ? { ...t, archived: archived || undefined } : t)),
    })))
    const { activeUrl } = route
    const { token } = pairCfg
    void refreshBootstrap(activeUrl, token)
    window.setTimeout(() => { void refreshBootstrap(activeUrl, token) }, 1500)
  }

  // 给当前会话选工作目录：还没开始的草稿会话直接改它的目录；其它用这个目录新开一个会话（目录不是会话的身份，多个会话可以共用）
  const handleChooseDir = async (dir: string) => {
    if (!selected || !ownerView || !route.activeUrl || !pairCfg.token) return
    const plan = planDirChoice({ sessionKey: selected, started: sessionStarted, currentDir: workspaceDir, chosen: dir })
    if (plan === "same") return
    setActionError("")
    if (plan === "rebind") {
      const r = await setMobileSessionDir(route.activeUrl, pairCfg.token, selected, dir)
      if (!r.ok) {
        setActionError(r.error ?? "设置目录失败")
        return
      }
      const tabKey = currentTab?.sessionKey ?? selected
      setPickedDirs((prev) => ({ ...prev, [tabKey]: dir }))
      void refreshBootstrap(route.activeUrl, pairCfg.token)
      return
    }
    const channelId = ownerView.channelId
    const r = await createMobileTempSession(route.activeUrl, pairCfg.token, channelId, dir)
    const key = r.sessionKey
    if (!r.ok || !key) {
      setActionError(r.error ?? "创建会话失败")
      return
    }
    setDrafts((prev) => [...prev, { channelId, sessionKey: key }])
    setPickedDirs((prev) => ({ ...prev, [key]: dir }))
    setLastActive((prev) => ({ ...prev, [appChatSessionId(key)]: Date.now() }))
    setSelected(key)
  }

  // 删除会话
  const handleDeleteSession = async (t: MobileChatTab) => {
    if (!route.activeUrl || !pairCfg.token) return
    const key = t.sessionKey
    const id = appChatSessionId(key)
    // 还没发过消息的草稿会话没有什么可丢的，不再确认
    if (!drafts.some((d) => sameChatSession(d.sessionKey, key))) {
      const boundDir = boundDirOf(t)
      const effect = isTempChatWorkspace(workspaceDirFromSessionKey(key))
        ? boundDir
          ? `会停止 Agent、清除上下文和聊天记录。「${dirName(boundDir) ?? boundDir}」里的文件不会被删除。`
          : "会停止 Agent、清除上下文和聊天记录，并删除这个会话的临时文件夹（其中生成的文件也会一并删除）。"
        : t.kind === "main"
          ? "会停止 Agent、清除上下文和聊天记录，并清除该通道的主目录设置（不删磁盘文件）。"
          : "会停止 Agent、清除上下文和聊天记录，并从常用目录中移除。"
      if (!await showConfirm("删除会话", `确定删除「${sessionName(t)}」吗？\n${effect}`, "删除")) return
    }
    setDrafts((prev) => prev.filter((d) => !sameChatSession(d.sessionKey, key)))
    const r = await deleteMobileSession(route.activeUrl, pairCfg.token, key)
    if (!r.ok) {
      setActionError(r.error ?? "删除会话失败")
      return
    }
    draftStore.discard(id)
    setTitles((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    // 先从列表里拿掉，再刷新：正在进行中的刷新可能是删除前发出的，晚到时不能让它把会话带回来
    markSessionDeleted(deletedRef.current, key)
    setServerViews((prev) => hideDeletedTabs(prev, deletedRef.current))
    await refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  // 置顶 / 取消置顶：点了先在界面上生效，电脑端没改成就报错并按电脑端的真实状态刷回来
  const handleTogglePin = async (t: MobileChatTab) => {
    if (!route.activeUrl || !pairCfg.token) return
    const pinned = !isSessionPinned(pins, t.sessionKey)
    setPins(setSessionPinned(pins, t.sessionKey, pinned))
    const r = await setMobileSessionPinned(route.activeUrl, pairCfg.token, t.sessionKey, pinned)
    if (r.ok) {
      if (r.pins) setPins(parsePinnedIds(r.pins))
      return
    }
    setActionError(r.error ?? (pinned ? "置顶失败" : "取消置顶失败"))
    void refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  // 重命名当前会话
  const startRename = () => {
    if (!currentTab) return
    setRenameDraft(sessionName(currentTab))
    setRenaming(true)
  }
  const submitRename = async () => {
    if (!selected || !route.activeUrl || !pairCfg.token) {
      setRenaming(false)
      return
    }
    const r = await renameMobileSession(route.activeUrl, pairCfg.token, selected, renameDraft)
    setRenaming(false)
    if (!r.ok) {
      setActionError(r.error ?? "重命名失败")
      return
    }
    if (r.titles) setTitles(r.titles)
    // 项目会话的名字就是项目名：改的是项目，没有标题推送，重新读一次会话列表才看得到新名字
    if (projectId) void refreshBootstrap(route.activeUrl, pairCfg.token)
  }

  // 清空当前会话
  const handleClearCurrent = async () => {
    if (!selected || !route.activeUrl || !pairCfg.token) return
    setMoreMenuOpen(false)
    const name = currentTab ? sessionName(currentTab) : "当前会话"
    if (!await showConfirm("清空本会话记录", `确定清空「${name}」在应用内的对话记录吗？\n只删除本页记录（会话名随之重置），Agent 的会话上下文不受影响。`, "清空")) return
    await clearMobileSession(route.activeUrl, pairCfg.token, { sessionKey: selected })
    resetLoadWindow(undefined, false)
    setItems([])
  }

  // 清空全部会话记录
  const handleClearAll = async () => {
    if (!route.activeUrl || !pairCfg.token) return
    if (!await showConfirm("清空全部对话记录", "确定清空所有应用内会话的对话记录吗？\n只删除本页记录，Agent 的会话上下文不受影响。", "全部清空")) return
    for (const v of views) {
      await clearMobileSession(route.activeUrl, pairCfg.token, { channelId: v.channelId })
    }
    resetLoadWindow(undefined, false)
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
    // 当前若是草稿会话，它不在上面刷新的会话树里，要单独重读才能看到新模型
    await refreshDraftModels()
  }

  // 选择并上传图片
  const handlePickImages = async (files: FileList | null) => {
    if (!files || files.length === 0 || !route.activeUrl || !pairCfg.token) return
    // 上传是异步的：期间切了会话，图片也要落到选图时的那个会话的草稿里
    const key = draftKey
    setUploadingImage(true)
    setActionError("")
    for (const file of Array.from(files)) {
      const ext = imageExtOf(file)
      if (!ext) {
        setActionError(`不支持的图片格式（${file.type || file.name}），请选 PNG、JPG、GIF、WebP 或 BMP`)
        continue
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result ?? ""))
          reader.onerror = () => reject(new Error("读取图片失败"))
          reader.readAsDataURL(file)
        })
        const r = await uploadMobileImage(route.activeUrl, pairCfg.token, dataUrl, ext)
        if (r.ok && r.path) {
          const image = { path: r.path, previewUrl: dataUrl }
          draftStore.update(key, (d) => ({ ...d, images: [...d.images, image] }))
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

  useBackToClose(moreMenuOpen, () => setMoreMenuOpen(false))
  useBackToClose(ModalPortal !== null, dismissConfirm)
  useBackToClose(previewImage !== null, () => setPreviewImage(null))
  const moreAnchor = moreMenuOpen ? moreButtonRef.current?.getBoundingClientRect() : undefined

  // 左右滑动展开/收起会话列表
  const rootRef = useRef<HTMLDivElement>(null)
  useDrawerSwipe(rootRef, drawerOpen, setDrawerOpen)

  return (
    // touch-pan-y：只把竖向滚动留给浏览器，横向手势才会稳定地交给上面的抽屉滑动，不会被浏览器抢去当作滚动
    <div ref={rootRef} className="flex h-full w-full touch-pan-y flex-col bg-page text-fg">
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
            <div className="flex max-w-full flex-col items-start">
              <button
                type="button"
                onClick={startRename}
                className="flex max-w-full items-center gap-1 text-left"
              >
                <span className="truncate text-[14px] font-semibold text-fg">
                  {currentTab ? sessionName(currentTab) : "LK Harness"}
                </span>
                {busy && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
              </button>
              <div className="flex max-w-full items-center gap-1.5 text-[11px] text-fg-muted">
                <button type="button" onClick={startRename} className="min-w-0 max-w-[55%] truncate text-left">
                  {projectId ? "项目" : workspaceLabel || hostname || "手机端对话"}
                </button>
                {canPickBranch ? (
                  // 分支是工作目录的，可以在这里切；点开是底部抽屉，和目录、模型的抽屉一致
                  <button
                    type="button"
                    onClick={() => setBranchSheetOpen(true)}
                    title={branchWorking ? "有会话正在这个目录里回复，暂时不能切换分支" : "切换分支"}
                    className={`relative inline-flex min-w-0 items-center gap-0.5 rounded-full border border-line bg-page/70 px-1.5 py-0.5 transition before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] active:bg-raised ${
                      branchWorking ? "text-fg-faint" : isDetachedLabel(branchLabel ?? "") ? "text-amber-500" : "text-fg-2"
                    }`}
                  >
                    <GitBranch size={10} className="shrink-0" />
                    <span className="truncate">{branchLabel}</span>
                    <ChevronDown size={10} className="shrink-0 text-fg-faint" />
                  </button>
                ) : (
                  currentTab?.branch && (
                    <span className="inline-flex min-w-0 items-center gap-0.5 text-fg-faint">
                      · <GitBranch size={10} className="shrink-0" />
                      <span className="truncate">{currentTab.branch}</span>
                    </span>
                  )
                )}
              </div>
            </div>
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
        <div className="shrink-0">
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setMoreMenuOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-fg-muted active:bg-raised"
          >
            <MoreVertical size={17} />
          </button>
          {/* 挂到 body：顶栏的 backdrop-filter 会把内部 fixed 元素的参照系缩成顶栏大小，遮罩盖不住整屏 */}
          {moreAnchor && createPortal(
            <>
              <div
                onClick={() => setMoreMenuOpen(false)}
                className="fixed inset-0 z-30"
              />
              <div
                style={{ top: moreAnchor.bottom + 4, right: window.innerWidth - moreAnchor.right }}
                className="fixed z-40 w-44 rounded-2xl border border-line bg-surface p-1.5 shadow-xl"
              >
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
                {appUpdate.isApp && (
                  <button
                    type="button"
                    disabled={appUpdate.status.phase === "checking"}
                    onClick={() => {
                      void appUpdate.checkNow().then((r) => {
                        // 查到新版本就收起菜单，顶部的提示条才看得见
                        if (r === "update") setMoreMenuOpen(false)
                      })
                    }}
                    className="flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-xs text-fg-2 active:bg-raised disabled:opacity-60"
                  >
                    <Download size={13} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      检查更新
                      <span className="mt-0.5 block break-words text-[10px] leading-snug text-fg-muted">
                        {describeUpdateStatus(appUpdate.status, appUpdate.currentVersion)}
                      </span>
                    </span>
                  </button>
                )}
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
            </>,
            document.body,
          )}
        </div>
      </header>

      {/* 新版本提示条（仅 App 内出现） */}
      {appUpdate.update && (
        <UpdateBanner
          update={appUpdate.update}
          currentVersion={appUpdate.currentVersion}
          onUpdate={appUpdate.startUpdate}
          onDismiss={appUpdate.dismiss}
        />
      )}

      {/* ═══ 中间对话消息区 ═══ */}
      {selected && route.connected ? (
        <MobileItemList
          key={selected}
          items={streamItems}
          loading={historyLoading}
          hasMore={hasMore}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={() => void loadEarlier()}
          busy={busy}
          workspaceName={workspaceLabel}
          projectName={projectId && currentTab ? sessionName(currentTab) : undefined}
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
      <footer className="relative shrink-0 border-t border-line-subtle bg-surface/95 px-3 pt-2 pb-safe backdrop-blur">
        {/* `/` 指令菜单：贴着输入栏上沿向上展开 */}
        <SlashMenu items={slashItems} onPick={pickSlash} />

        {/* 暂存区：排队中、还没交给 Agent 的消息（和电脑端同一个组件） */}
        <QueuedStrip
          key={selected ?? ""}
          items={queuedItems}
          onEdit={handleEditQueued}
          onRemove={handleRemoveQueued}
          onSendNow={handleSendQueuedNow}
          touch
        />

        {/* 待发送图片缩略图列表 */}
        {pendingImages.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
            {pendingImages.map((img, idx) => (
              <div key={img.path} className="relative shrink-0">
                <img
                  src={img.previewUrl}
                  alt=""
                  onClick={() => setPreviewImage(img.previewUrl)}
                  className="h-14 w-14 rounded-xl border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    draftStore.update(draftKey, (d) => ({ ...d, images: d.images.filter((_, i) => i !== idx) }))
                  }
                  className="absolute -right-1 -top-1 rounded-full bg-black/80 p-0.5 text-white"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 项目会话：步骤条（点一下 AI 开始做这一步）和项目信息 */}
        {projectId && currentTab && ownerView && route.connected && (
          <MobileProjectBar
            key={projectId}
            baseUrl={route.activeUrl}
            token={pairCfg.token}
            channelId={ownerView.channelId}
            projectId={projectId}
            sessionKey={currentTab.sessionKey}
            running={currentTab.running}
            confirm={showConfirm}
            onStarted={() => {
              const { activeUrl } = route
              const { token } = pairCfg
              void refreshBootstrap(activeUrl, token)
              // 进程要等一下才登记成「在跑」，补刷一次
              window.setTimeout(() => { void refreshBootstrap(activeUrl, token) }, 1500)
            }}
            onDeleted={() => void handleProjectDeleted(currentTab)}
            onArchiveChanged={(archived) => handleProjectArchiveChanged(currentTab.sessionKey, archived)}
            onError={setActionError}
          />
        )}

        {/* 上方快捷胶囊栏：目录 · 模型 · 发图 */}
        <div className="mb-2 flex items-center gap-1.5 overflow-x-auto">
          {/* 项目会话的目录是项目自己的（项目信息里看），在这里选目录只会另开一个无关的新会话 */}
          {!projectId && (
            <button
              type="button"
              onClick={() => setDirSheetOpen(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-page px-2.5 py-1 text-[11px] text-fg-2 transition active:scale-95"
            >
              <FolderOpen size={12} className="text-accent" />
              <span className="max-w-[110px] truncate">{workspaceLabel || "切换目录"}</span>
              <ChevronDown size={11} className="text-fg-muted" />
            </button>
          )}

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
            onChange={(e) => { setText(e.target.value); setSlashDismissed(false) }}
            onFocus={() => { clearTimeout(slashBlurTimer.current); setSlashDismissed(false) }}
            onBlur={() => { slashBlurTimer.current = setTimeout(() => setSlashDismissed(true), 200) }}
            onKeyDown={(e) => {
              // 手机软键盘上回车是换行（发送走右边的按钮）；有实体键盘时回车发送、Shift+回车换行
              const sendsOnEnter = shouldSendOnEnter({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, isTouchPrimary())
              // 指令菜单开着：Tab（和实体键盘的回车，输入的还不是完整指令时）选中第一项，而不是发出半截指令
              if (slashItems.length > 0 && !e.nativeEvent.isComposing && (e.key === "Tab" || (sendsOnEnter && text.trim() !== slashItems[0].cmd))) {
                e.preventDefault()
                pickSlash(slashItems[0].cmd)
                return
              }
              if (sendsOnEnter) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder={
              !route.connected
                ? "请先配对连接电脑端…"
                : busy
                  ? "Agent 运行中，发送的消息会排队…"
                  : "发消息给电脑端 Agent，输入 / 查看指令…"
            }
            className="max-h-[120px] min-h-[38px] flex-1 resize-none rounded-2xl border border-line bg-page px-3.5 py-2 text-[14px] leading-snug text-fg focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />

          {composerAction(busy, hasContent) === "stop" ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              title="停止并清空排队消息"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-rose-600 text-white shadow-sm transition active:scale-90"
            >
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!selected || !route.connected || !hasContent}
              onClick={() => void handleSend()}
              title={busy ? "发送（排队）" : "发送"}
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
        pins={pins}
        usageBytes={usageBytes}
        onSelect={setSelected}
        onNewTemp={(chId) => void handleNewTempSession(chId)}
        onNewProject={(chId) => setNewProjectFor(chId)}
        onTogglePin={(t) => void handleTogglePin(t)}
        onDelete={(t) => void handleDeleteSession(t)}
        onClearAll={() => void handleClearAll()}
        onOpenPair={() => setPairSheetOpen(true)}
      />

      <NewProjectSheet
        open={newProjectFor !== null}
        onClose={() => setNewProjectFor(null)}
        baseUrl={route.activeUrl}
        token={pairCfg.token}
        channelId={newProjectFor ?? ""}
        onCreated={handleProjectCreated}
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
        options={dirOptions}
        currentDir={workspaceDir}
        canRebind={canRebindDir}
        onSelect={(dir) => void handleChooseDir(dir)}
      />

      <BranchSheet
        open={branchSheetOpen && !!selected}
        onClose={() => setBranchSheetOpen(false)}
        baseUrl={route.activeUrl}
        token={pairCfg.token}
        sessionKey={selected ?? ""}
        shared={branchShared}
        onSwitched={(current) => {
          setBranchOverride(makeBranchOverride(currentTab?.branch ?? "", current, Date.now()))
          void refreshBootstrap(route.activeUrl, pairCfg.token)
        }}
        onError={setActionError}
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

      {ModalPortal}
      {previewImage && <ImageLightbox src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  )
}
