import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
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
import { appChatSessionId, chatStreamItems, upsertChatItems as upsertItems, type AppChatItem } from "../shared/app-chat-types"
import { hideDeletedTabs, markSessionDeleted, type DeletedSessions } from "../shared/deleted-sessions"
import { activityFromItems, applyActivityItem, isActivityBusy, type SessionActivity } from "./session-activity"
import {
  APP_CHANNEL_CHAT_ID,
  channelIdFromSessionKey,
  makeChatKey,
  workspaceDirFromSessionKey,
  type AgentResource,
} from "../shared/channel-types"
import { isTempChatWorkspace, tempWorkspaceCreatedAt } from "../shared/temp-workspace"
import { ImageLightbox } from "../renderer/components/chat/ImageLightbox"
import { sameChatSession } from "../renderer/components/chat/useAppChatItems"
import useInlineModal from "../renderer/components/useInlineModal"
import { modelSlug } from "../renderer/model-utils"
import {
  applyMobileTheme,
  clearMobileSession,
  connectMobileEvents,
  createMobileTempSession,
  deleteMobileSession,
  fetchBootstrap,
  fetchHistory,
  fetchSessionModels,
  fetchUpdateInfo,
  imageExtOf,
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
import { APP_VERSION } from "./app-version"
import { useBackToClose } from "./back-stack"
import MobileItemList from "./MobileItems"
import { DirSheet, ModelSheet, PairSheet, SessionDrawer } from "./MobileModals"
import { isNativeShell, tryOpenInSystemBrowser } from "./native-browser"
import { withDrafts, type DraftSession, type TabModel } from "./session-drafts"
import UpdateBanner from "./UpdateBanner"
import { loadDismissedUpdate, pendingUpdate, saveDismissedUpdate, type PendingUpdate } from "./update-check"

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
  const [titles, setTitles] = useState<Record<string, string>>({})
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
  const [actionError, setActionError] = useState("")
  /** App（APK）有新版本时的提示；网页版由电脑端直接提供，版本天然一致，不查 */
  const [update, setUpdate] = useState<PendingUpdate | null>(null)
  const [text, setText] = useState("")
  const [pendingImages, setPendingImages] = useState<{ path: string; previewUrl: string }[]>([])
  /** 正在放大查看的待发送图片 */
  const [previewImage, setPreviewImage] = useState<string | null>(null)
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
  const { showConfirm, dismiss: dismissConfirm, ModalPortal } = useInlineModal()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
    const pick = first.tabs.find((t) => sameChatSession(t.sessionKey, first.activeKey)) ?? first.tabs[0]
    setSelected(pick.sessionKey)
  }, [views, selected])

  const refreshBootstrap = useCallback(
    async (baseUrl: string, token: string) => {
      if (!baseUrl || !token) return
      try {
        const data = await fetchBootstrap(baseUrl, token)
        if (!data.ok) return
        setHostname(data.hostname || "")
        setServerViews(hideDeletedTabs(data.channels ?? [], deletedRef.current))
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

  // 打开 App 连上电脑端后查一次有没有新版（只在 APK 里查）。
  // 电脑端没查到时不算查过，下次线路变化再试；失败一律静默，不打扰对话
  const updateCheckedRef = useRef(false)
  useEffect(() => {
    if (updateCheckedRef.current || !route.connected || !route.activeUrl || !pairCfg.token) return
    if (!isNativeShell()) return
    void fetchUpdateInfo(route.activeUrl, pairCfg.token).then((info) => {
      if (!info.ok) return
      updateCheckedRef.current = true
      setUpdate(pendingUpdate(info, APP_VERSION, loadDismissedUpdate()))
    })
  }, [route.connected, route.activeUrl, pairCfg.token])

  const startUpdate = useCallback(async () => {
    if (!update) return
    // 交给系统浏览器下载 APK，下完点开即由系统安装器接手；签名一致才能覆盖安装
    const opened = await tryOpenInSystemBrowser(update.apkUrl)
    if (!opened.ok) {
      setActionError(`无法调起系统浏览器（${opened.reason}），请手动打开下载：${update.releaseUrl}`)
    }
  }, [update])
  const dismissUpdate = useCallback(() => {
    if (update) saveDismissedUpdate(update.version)
    setUpdate(null)
  }, [update])

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
        if (hit) setItems([])
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
  }, [route.connected, route.activeUrl, pairCfg.token, refreshBootstrap])

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

  // 拉取当前会话历史；实时流重连（resyncTick）后再拉一次，补回断线期间错过的消息
  useEffect(() => {
    setActionError("")
    if (!selected) {
      historyKeyRef.current = ""
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
      setHistoryLoading(true)
      setItems([])
    }
    void fetchHistory(route.activeUrl, pairCfg.token, selected).then((r) => {
      if (cancelled) return
      liveBufferRef.current = null
      setHistoryLoading(false)
      if (!r.ok) {
        setActionError(r.error ?? "读取历史消息失败")
        return
      }
      setItems(upsertItems(r.items ?? [], [...live.values()]))
      setActivity((prev) => ({ ...prev, [id]: activityFromItems(r.items ?? []) }))
    })
    return () => {
      cancelled = true
      if (liveBufferRef.current === live) liveBufferRef.current = null
    }
  }, [selected, route.connected, route.activeUrl, pairCfg.token, resyncTick])

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
  // 电脑端暂存区里排队中的消息（Agent 还没收到）不进聊天流，投递后才出现
  const streamItems = useMemo(() => chatStreamItems(items), [items])

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

    const draftText = text
    const draftImages = pendingImages
    if (overrideText === undefined) {
      setText("")
      setPendingImages([])
    }
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
      setText((cur) => cur || draftText)
      setPendingImages((cur) => (cur.length > 0 ? cur : draftImages))
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
    // 还没发过消息的草稿会话没有什么可丢的，不再确认
    if (!drafts.some((d) => sameChatSession(d.sessionKey, key))) {
      const effect = isTempChatWorkspace(workspaceDirFromSessionKey(key))
        ? "会停止 Agent、清除上下文和聊天记录，并删除这个会话的临时文件夹（其中生成的文件也会一并删除）。"
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
    const name = currentTab ? sessionName(currentTab) : "当前会话"
    if (!await showConfirm("清空本会话记录", `确定清空「${name}」在应用内的对话记录吗？\n只删除本页记录（会话名随之重置），Agent 的会话上下文不受影响。`, "清空")) return
    await clearMobileSession(route.activeUrl, pairCfg.token, { sessionKey: selected })
    setItems([])
  }

  // 清空全部会话记录
  const handleClearAll = async () => {
    if (!route.activeUrl || !pairCfg.token) return
    if (!await showConfirm("清空全部对话记录", "确定清空所有应用内会话的对话记录吗？\n只删除本页记录，Agent 的会话上下文不受影响。", "全部清空")) return
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
    // 当前若是草稿会话，它不在上面刷新的会话树里，要单独重读才能看到新模型
    await refreshDraftModels()
  }

  // 选择并上传图片
  const handlePickImages = async (files: FileList | null) => {
    if (!files || files.length === 0 || !route.activeUrl || !pairCfg.token) return
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

  useBackToClose(moreMenuOpen, () => setMoreMenuOpen(false))
  useBackToClose(ModalPortal !== null, dismissConfirm)
  useBackToClose(previewImage !== null, () => setPreviewImage(null))
  const moreAnchor = moreMenuOpen ? moreButtonRef.current?.getBoundingClientRect() : undefined

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
      {update && (
        <UpdateBanner
          update={update}
          currentVersion={APP_VERSION}
          onUpdate={() => void startUpdate()}
          onDismiss={dismissUpdate}
        />
      )}

      {/* ═══ 中间对话消息区 ═══ */}
      {selected && route.connected ? (
        <MobileItemList
          key={selected}
          items={streamItems}
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
                  onClick={() => setPreviewImage(img.previewUrl)}
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
            onChange={(e) => setText(e.target.value)}
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

      {ModalPortal}
      {previewImage && <ImageLightbox src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  )
}
