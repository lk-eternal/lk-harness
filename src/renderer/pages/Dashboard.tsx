import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import {
  Play,
  Square,
  Wifi,
  WifiOff,
  Bot,
  MessageSquare,
  Loader2,
  Trash2,
  X,
} from "lucide-react"
import TitleBar from "../components/TitleBar"
import TitleBrand from "../components/TitleBrand"
import TitleActions from "../components/TitleActions"
import PageTabs, { type MainPage } from "../components/PageTabs"
import useInlineModal from "../components/useInlineModal"
import StatusCard, { TabPane } from "../components/dashboard/StatusCard"
import LogPanel from "../components/dashboard/LogPanel"
import QueuePanel from "../components/dashboard/QueuePanel"
import SessionsArea from "../components/sessions/SessionsArea"
import {
  DEFAULT_DASHBOARD_TAB,
  activeCardSub,
  activeChannelCount,
  channelsCardSub,
  queueCardSub,
  type DashboardTab,
} from "../components/dashboard/dashboard-view"
import { ALL_CHANNELS } from "../components/sessions/sessions-view"
import { useManagedSessions } from "../hooks/useManagedSessions"
import { disambiguatePathLabel } from "../../shared/path-label"
import { cardLabelFromSessionTab } from "../../shared/log-format"
import { buildDashboardTree, GROUP_IDS, withAppChatNames, type DashboardChannelNode } from "../../shared/dashboard-tree"
import type { ModelChoice, ModelPickerSource } from "../components/chat/ModelPicker"
import { useModelFavorites } from "../hooks/useModelFavorites"
import { makeChatKey } from "../../shared/channel-types"

interface Props {
  /** 打开设置页，可指定初始 Tab */
  onSettings: (tab?: string) => void
  /** 标题栏页面切换 */
  onSwitchPage: (page: MainPage) => void
  /** 当前是否为可见页面（从设置页返回时立即刷新） */
  active?: boolean
}

interface OnboardState {
  workspaceReady: boolean
  agentReady: boolean
  channelReady: boolean
}

export default function Dashboard({ onSettings, onSwitchPage, active }: Props) {
  const [status, setStatus] = useState<DaemonStatus>({ running: false })
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState("")
  const [queueMessages, setQueueMessages] = useState<{ index: number; fileId: string; preview: string; status?: "pending" | "processing"; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string; sessionLabel?: string; channelName?: string; audience?: "main" | "others" }[]>([])
  const [rawTreeChannels, setTreeChannels] = useState<DashboardChannelNode[]>([])
  /** 应用内对话通道的 id，和会话摘要标题（键为 appChatSessionId）：这些通道的会话在清单里叫会话名，和对话页一致 */
  const [appChannelIds, setAppChannelIds] = useState<ReadonlySet<string>>(() => new Set())
  const [appChatTitles, setAppChatTitles] = useState<Record<string, string>>({})
  const treeChannels = useMemo(
    () => withAppChatNames(rawTreeChannels, appChannelIds, appChatTitles),
    [rawTreeChannels, appChannelIds, appChatTitles],
  )
  /** 四张卡片就是四个页签：选中哪张，下面的功能区就显示它的内容。启动时看日志，不记住上次选的 */
  const [activeTab, setActiveTab] = useState<DashboardTab>(DEFAULT_DASHBOARD_TAB)
  /** 「消息通道」功能区看哪个通道：ALL_CHANNELS = 全部（选中的通道没了会自动回到全部） */
  const [sessionsChannelId, setSessionsChannelId] = useState<string>(ALL_CHANNELS)
  const [stoppingAgent, setStoppingAgent] = useState(false)
  const [clearingQueue, setClearingQueue] = useState(false)
  const [onboard, setOnboard] = useState<OnboardState | null>(null)
  const [onboardDismissed, setOnboardDismissed] = useState(false)
  const [wsTabs, setWsTabs] = useState<{ current: string; favorites: string[] }>({ current: "", favorites: [] })
  const [sessionTabs, setSessionTabs] = useState<{ sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean }[]>([])
  const deletableSessionKeys = useMemo(
    () => new Set(sessionTabs.filter((t) => t.removable).map((t) => t.sessionKey)),
    [sessionTabs],
  )
  const { showConfirm, ModalPortal } = useInlineModal()
  /** 队列行复用会话树的通道名与会话 label，两处徽标口径一致 */
  const sessionMetaByKey = useMemo(() => {
    const m = new Map<string, { channelName: string; label: string }>()
    for (const ch of treeChannels) {
      for (const gid of GROUP_IDS) {
        for (const s of ch.groups[gid].sessions) {
          m.set(s.sessionKey.toLowerCase(), { channelName: ch.name, label: s.label })
        }
      }
    }
    return m
  }, [treeChannels])
  const [projectNameById, setProjectNameById] = useState<Map<string, string>>(() => new Map())
  const projectNameByIdRef = useRef(projectNameById)
  projectNameByIdRef.current = projectNameById

  const projectSessionLabel = (sessionKey: string, chatName?: string, chatType?: string): string | undefined => {
    if (chatType !== "project" && !/::project_[a-f0-9]+/i.test(sessionKey)) return undefined
    const pid = sessionKey.match(/::project_([a-f0-9]+)/i)?.[1]
    const name = pid ? projectNameByIdRef.current.get(pid) : undefined
    if (name) return `📦 ${name}`
    const legacy = chatName?.replace(/^P:\s*/, "").trim()
    if (legacy) return legacy.startsWith("📦") ? legacy : `📦 ${legacy}`
    return undefined
  }
  const [taskNameById, setTaskNameById] = useState<Map<string, string>>(() => new Map())

  const refreshProjectNames = useCallback(() => {
    void window.electronAPI.listProjects().then((list) => {
      const m = new Map<string, string>()
      for (const p of list) {
        if (p.id && p.name) m.set(p.id, p.name)
      }
      setProjectNameById(m)
    }).catch(() => { /* ignore */ })
  }, [])

  useEffect(() => {
    refreshProjectNames()
    const t = setInterval(refreshProjectNames, 30_000)
    return () => clearInterval(t)
  }, [refreshProjectNames, active])

  // 应用内会话的摘要标题：生成完成 / 改名 / 清空 / 删除都会整体推送；先订阅再拉取，拉取晚到不能盖掉已推送的新值
  useEffect(() => {
    let pushed = false
    let disposed = false
    const unsub = window.electronAPI.onAppChatTitles((t) => {
      pushed = true
      setAppChatTitles(t)
    })
    void window.electronAPI.appChatTitles().then((t) => { if (!pushed && !disposed) setAppChatTitles(t) }).catch(() => { /* 取不到就先显示目录名 */ })
    return () => {
      disposed = true
      unsub()
    }
  }, [])

  const refreshTaskNames = useCallback(() => {
    window.electronAPI.getScheduledTasks().then((tasks) => {
      const m = new Map<string, string>()
      for (const t of tasks) {
        if (t.id && t.name) m.set(t.id, t.name)
      }
      setTaskNameById(m)
    }).catch(() => { /* ignore */ })
  }, [])

  useEffect(() => {
    refreshTaskNames()
    const t = setInterval(refreshTaskNames, 30_000)
    return () => clearInterval(t)
  }, [refreshTaskNames, active])

  const sessionLogLabelByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of sessionTabs) {
      m.set(t.sessionKey, cardLabelFromSessionTab(t))
    }
    return m
  }, [sessionTabs])

  const [activeSessionKey, setActiveSessionKey] = useState("")
  const [sessionSwitching, setSessionSwitching] = useState("")
  /** 正在切换模型的会话 key；同一时刻只允许切一个 */
  const [modelSwitching, setModelSwitching] = useState("")
  const { quickModels, favorites: favoriteModels, refresh: refreshModels, toggleFavorite } = useModelFavorites()
  /** 会话行上的模型选择器要列的供应商（跟着通道配置走，5 秒轮询里顺带更新） */
  const [agentResources, setAgentResources] = useState<AgentResource[]>([])
  const modelPicker = useMemo<ModelPickerSource>(() => ({
    resources: agentResources,
    quickModels,
    favorites: favoriteModels,
    onToggleFavorite: toggleFavorite,
    onOpen: () => void refreshModels(),
  }), [agentResources, quickModels, favoriteModels, toggleFavorite, refreshModels])
  const [sessionList, setSessionList] = useState<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string; resourceId?: string }[]>([])
  const [sessionDiag, setSessionDiag] = useState<Record<string, { running: boolean; resumeAgentId?: string; resumeUpdatedAt?: number; lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }; lastReplyAt: number | null }>>({})
  /** 走 ref 读 sessionList：让 refreshDashboardTree 引用恒定，否则会与 refreshOnboard 的 effect 互相触发成刷新风暴 */
  const sessionListRef = useRef(sessionList)
  sessionListRef.current = sessionList
  const treeBusyRef = useRef(false)

  const resolveLogSessionLabel = useCallback((sk: string) => {
    const direct = sessionLogLabelByKey.get(sk)
    if (direct) return direct
    const norm = sk.replace(/\\/g, "/").toLowerCase()
    for (const [k, v] of sessionLogLabelByKey) {
      if (k.replace(/\\/g, "/").toLowerCase() === norm) return v
    }
    const taskName = taskNameById.get(sk)
    if (taskName) return `⏰ ${taskName}`
    const running = sessionListRef.current.find((s) =>
      s.sessionKey === sk || s.sessionKey.replace(/\\/g, "/").toLowerCase() === norm)
    if (running?.chatName) {
      if (running.chatType === "task") return `⏰ ${running.chatName}`
      return running.chatName
    }
    const pid = sk.match(/::project_([a-f0-9]+)/i)?.[1]
    if (pid) {
      for (const [k, v] of sessionLogLabelByKey) {
        if (k.includes(`project_${pid}`)) return v
      }
      const name = projectNameById.get(pid)
      if (name) return `📦 ${name}`
    }
    return undefined
  }, [sessionLogLabelByKey, projectNameById, taskNameById])
  const resolveLogSessionLabelRef = useRef(resolveLogSessionLabel)
  resolveLogSessionLabelRef.current = resolveLogSessionLabel

  useEffect(() => {
    if (!actionError) return
    const t = window.setTimeout(() => setActionError(""), 4000)
    return () => window.clearTimeout(t)
  }, [actionError])

  const refreshDashboardTree = useCallback(async () => {
    // 定时器与 onSessionAgents 推送都会触发；同一时刻只跑一轮，丢弃的由 5s 定时器兜底
    if (treeBusyRef.current) return
    treeBusyRef.current = true
    try {
      const [dash, queue, st, cfg] = await Promise.all([
        window.electronAPI.listDashboardTree().catch(() => ({ ok: false as const, channels: [], running: [], error: "ipc" })),
        window.electronAPI.getQueueMessages().catch(() => []),
        window.electronAPI.getDaemonStatus(),
        window.electronAPI.getConfig(),
      ])
      setQueueMessages(queue)
      setAgentResources(cfg.agentResources ?? [])
      const connected = new Map((st.channels ?? []).map((c) => [c.id, !!c.connected]))
      const cfgChannels = (cfg.channels ?? []).filter((c) => c.enabled !== false)
      const appIds = cfgChannels.filter((c) => c.type === "app").map((c) => c.id)
      // 5 秒一轮：内容没变就沿用旧集合，不白白触发重算
      setAppChannelIds((prev) => (prev.size === appIds.length && appIds.every((id) => prev.has(id)) ? prev : new Set(appIds)))

      const dashChannels = (dash.ok && dash.channels.length > 0)
        ? dash.channels
        : cfgChannels.map((c) => {
            const raw = c.mainUserEnabled ? (c.mainUserChatId?.trim() || undefined) : undefined
            return {
              channelId: c.id,
              name: c.name,
              mainUserChatId: raw ? makeChatKey(c.id, raw) : undefined,
              mainTabs: [] as { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string; resourceId?: string }[],
              activeKey: undefined as string | undefined,
            }
          })

      const activeKeyByChat: Record<string, string | undefined> = {}
      const mainSwitchable: {
        channelId: string
        sessionKey: string
        label: string
        kind?: string
        removable?: boolean
        model?: string
        modelParams?: string
        resourceId?: string
      }[] = []
      const labelByKey = new Map<string, string>()
      const removable = new Set<string>()
      for (const ch of dashChannels) {
        if (ch.mainUserChatId && ch.activeKey) activeKeyByChat[ch.mainUserChatId] = ch.activeKey
        for (const t of ch.mainTabs) {
          labelByKey.set(t.sessionKey, t.label)
          if (t.removable) removable.add(t.sessionKey)
          // 定时任务会话不是可切换的对话会话（运行中时另在 running 列表里显示），不进可切换清单
          if (!t.running && (t.kind as string) !== "task") {
            mainSwitchable.push({
              channelId: ch.channelId,
              sessionKey: t.sessionKey,
              label: t.label,
              kind: t.kind,
              removable: t.removable,
              model: t.model,
              modelParams: t.modelParams,
              resourceId: t.resourceId,
            })
          }
        }
      }
      const runningSrc = (dash.ok && dash.running.length > 0) ? dash.running : sessionListRef.current
      const running = runningSrc.map((s) => ({
        sessionKey: s.sessionKey,
        chatType: s.chatType,
        channelId: (s as { channelId?: string }).channelId,
        // 与日志同一套标签（📦/📂/⏰）；项目会话不走 raw chatName（旧版为 P: 名）
        label: labelByKey.get(s.sessionKey)
          || resolveLogSessionLabelRef.current(s.sessionKey)
          || projectSessionLabel(s.sessionKey, s.chatName, s.chatType)
          || (s.chatType === "task" && s.chatName ? `⏰ ${s.chatName}` : s.chatName)
          || s.sessionKey,
        model: s.model,
        modelParams: s.modelParams,
        resourceId: s.resourceId,
        workspaceDir: s.workspaceDir,
        chatName: s.chatName,
      }))
      const tree = buildDashboardTree({
        channels: dashChannels.map((c) => ({
          id: c.channelId,
          name: c.name,
          connected: connected.get(c.channelId) ?? false,
          mainUserChatId: c.mainUserChatId,
          agentResourceId: cfgChannels.find((x) => x.id === c.channelId)?.agentResourceId,
          othersAgentResourceId: cfgChannels.find((x) => x.id === c.channelId)?.othersAgentResourceId,
        })),
        running,
        mainSwitchable,
        activeKeyByChat,
        queue,
      })
      for (const ch of tree.channels) {
        for (const g of Object.values(ch.groups)) {
          for (const s of g.sessions) {
            if (removable.has(s.sessionKey)) s.removable = true
          }
        }
      }
      setTreeChannels(tree.channels)
      const cur = dashChannels.find((c) => c.activeKey)?.activeKey
        || dashChannels.flatMap((c) => c.mainTabs).find((t) => t.current)?.sessionKey
        || ""
      if (cur) setActiveSessionKey(cur)
      setSessionTabs(dashChannels.flatMap((c) => c.mainTabs))
    } catch {
      /* 保留上一棵树，避免闪成「未配置」 */
    } finally {
      treeBusyRef.current = false
    }
  }, [])

  useEffect(() => {
    if (projectNameById.size === 0) return
    void refreshDashboardTree()
  }, [projectNameById.size, refreshDashboardTree])

  const refreshOnboard = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    const channels = cfg.channels ?? []
    const channelReady = channels.some((c) => c.enabled && (c.type === "feishu"
      ? !!(c.larkAppId?.trim() && c.larkAppSecret?.trim())
      : !!c.wechatToken?.trim()))
    const hasSdkKey = (cfg.agentResources ?? []).some((r) => r.type === "sdk" && r.apiKey?.trim())
    setOnboard((prev) => ({
      workspaceReady: !!cfg.workspaceDir?.trim(),
      agentReady: hasSdkKey || (prev?.agentReady ?? false),
      channelReady,
    }))
    const mainChannel = (cfg.channels ?? []).find((c) => c.enabled && c.mainUserEnabled)
    const current = mainChannel?.workspaceDir?.trim() ?? ""
    // 通道常用 ∪ 全局常用（去重）：通道有值也不隐藏全局里的目录
    const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/g, "").toLowerCase() === b.replace(/[\\/]+$/g, "").toLowerCase()
    const favorites = [...(mainChannel?.favoriteWorkspaces ?? [])]
    for (const f of cfg.favoriteWorkspaces ?? []) {
      if (f?.trim() && !favorites.some((x) => sameDir(x, f))) favorites.push(f)
    }
    setWsTabs({ current, favorites })
  }, [])

  // 从设置页返回时立即刷新清单状态
  useEffect(() => {
    if (!active) return
    void refreshOnboard()
    void refreshDashboardTree()
  }, [active, refreshOnboard, refreshDashboardTree])

  const switchSessionTab = async (sessionKey: string) => {
    if (!sessionKey || sessionKey === activeSessionKey || sessionSwitching) return
    setSessionSwitching(sessionKey)
    try {
      const r = await window.electronAPI.switchSession(sessionKey)
      if (!r.ok) {
        setActionError(r.error ?? "切换会话失败")
        return
      }
      setActionError("")
      await refreshDashboardTree()
    } finally {
      setSessionSwitching("")
    }
  }

  const addFavoriteWorkspace = async (channelId: string) => {
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const r = await window.electronAPI.addChannelFavoriteWorkspace(channelId, dir)
    if (!r.ok) {
      setActionError(r.error ?? "添加常用目录失败")
      return
    }
    await refreshDashboardTree()
  }

  const deleteSessionTab = async (sessionKey: string, kind?: string, label?: string) => {
    const tab = sessionTabs.find((t) => t.sessionKey === sessionKey)
    const k = kind || tab?.kind
    const name = label || tab?.label || sessionKey
    // 项目行由项目表派生：只清会话上下文的话行不会消失，所以这里就是删项目本身。
    // 以 sessionKey 为准，运行中的项目会话不一定带 kind。
    const pid = sessionKey.match(/::project_([a-f0-9]+)/i)?.[1]
    if (pid || k === "project") {
      const short = name.split(" · ")[0]?.trim() || name
      if (!pid) {
        setActionError("无法解析项目 id")
        return
      }
      if (!(await showConfirm(
        "删除项目",
        `确定删除项目「${short}」？\n将移除 AI 工作目录（含未提交改动），主仓与远程分支不受影响。`,
        "删除项目",
        "取消",
      ))) return
      const r = await window.electronAPI.deleteProject(pid)
      if (!r.ok) {
        setActionError(r.error ?? "删除项目失败")
        return
      }
    } else {
      if (!(await showConfirm("删除会话", `确定删除「${name}」？`, "删除", "取消"))) return
      const r = await window.electronAPI.deleteSession(sessionKey)
      if (!r.ok) {
        setActionError(r.error ?? "删除会话失败")
        return
      }
    }
    await refreshDashboardTree()
  }

  /** 首页切模型：只认 UI 选中页签或主用户页签当前项，禁止跨通道「猜最近」 */
  const resolveModelTargetSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionKey.trim()) return activeSessionKey
    const tabs = await window.electronAPI.listSessionTabs()
    if (tabs.ok) {
      const key = tabs.activeKey ?? tabs.tabs.find((t) => t.current)?.sessionKey
      if (key) return key
    }
    return null
  }, [activeSessionKey])

  const switchSessionModel = async (sk: string, m: ModelChoice) => {
    if (modelSwitching || !sk) return
    setModelSwitching(sk)
    try {
      const r = await window.electronAPI.setSessionModel(sk, m.model, m.modelParams, m.resourceId)
      if (!r.ok) {
        setActionError(r.error ?? "切换模型失败")
        return
      }
      setActionError("")
      await refreshModels()
      await refreshDashboardTree()
    } finally {
      setModelSwitching("")
    }
  }

  // 工作台常驻（切到对话页 / 设置页只是被藏起来），但 5 秒一轮的轮询每轮都要让主进程重算一遍会话树，
  // 看不见的时候不跑：只留两个很轻的订阅，回到工作台时下面的 effect（active 变真）和这里会马上补一次
  const dashboardVisible = active !== false
  useEffect(() => {
    // 日志的订阅、缓冲和滚动都在 LogPanel 里（它在整个页面生命周期内常驻，切到别的功能区只是被藏起来）
    const unsub = window.electronAPI.onDaemonStatus((s) => {
      setStatus(s)
    })

    if (!dashboardVisible) {
      const unsubQuiet = window.electronAPI.onSessionAgents?.((list: typeof sessionList) => { setSessionList(list) })
      return () => {
        unsub()
        unsubQuiet?.()
      }
    }

    const refresh = async () => {
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
      window.electronAPI.getSessionAgents().then(setSessionList).catch(() => {})
      await refreshOnboard()
      await refreshDashboardTree()
    }
    refresh()
    const timer = setInterval(refresh, 5_000)

    const unsubSessions = window.electronAPI.onSessionAgents?.((list: typeof sessionList) => { setSessionList(list); void refreshDashboardTree() })

    return () => {
      clearInterval(timer)
      unsub()
      unsubSessions?.()
    }
  }, [dashboardVisible])

  // 会话清单（磁盘上存着的会话，含空闲的别人的会话）：只在「消息通道」/「活跃会话」功能区看得见时才读磁盘。
  // 清单由工作台持有、不跟功能区一起卸载：切走再切回来先显示旧的，同时刷新，不闪「正在加载」。
  const sessionsAreaOpen = active !== false && (activeTab === "channels" || activeTab === "sessions")
  const managedSessions = useManagedSessions(sessionsAreaOpen)
  const refreshManagedSessions = managedSessions.refresh
  // 运行中的会话集合变了（Agent 推送 + 5 秒轮询）就补读一次清单：别人的会话是不是「运行中」靠它，不等 8 秒的定时刷新
  const runningSig = useMemo(() => sessionList.map((s) => s.sessionKey).sort().join("\n"), [sessionList])
  const prevRunningSig = useRef(runningSig)
  useEffect(() => {
    if (prevRunningSig.current === runningSig) return
    prevRunningSig.current = runningSig
    if (sessionsAreaOpen) void refreshManagedSessions()
  }, [runningSig, sessionsAreaOpen, refreshManagedSessions])

  const handleStart = async () => {
    setStarting(true)
    setActionError("")
    try {
      const result = await window.electronAPI.startDaemon()
      if (result.ok) {
        const s = await window.electronAPI.getDaemonStatus()
        setStatus(s)
      } else {
        setActionError(result.error ?? "启动失败")
        // 启动失败大多因配置缺失，重新展示引导清单
        setOnboardDismissed(false)
        void refreshOnboard()
      }
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
      setOnboardDismissed(false)
      void refreshOnboard()
    }
    setStarting(false)
  }

  const handleStop = async () => {
    setStopping(true)
    await window.electronAPI.stopDaemon()
    setStatus({ running: false })
    setStopping(false)
  }

  const handleStopAgent = async () => {
    setStoppingAgent(true)
    try {
      await Promise.all([
        window.electronAPI.stopAgent(),
        window.electronAPI.stopAllSessionAgents(),
      ])
      setSessionList([])
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
    } catch { /* ignore */ }
    setStoppingAgent(false)
  }

  const refreshQueueMessages = async () => {
    const msgs = await window.electronAPI.getQueueMessages()
    setQueueMessages(msgs)
    return msgs
  }

  /** 选中一张卡片：队列明细切进来时先拉一次最新的，不等 5 秒轮询 */
  const selectTab = (next: DashboardTab) => {
    setActiveTab(next)
    if (next === "queue") void refreshQueueMessages().catch(() => { /* 5 秒轮询会兜底 */ })
  }

  const handleClearQueue = async () => {
    setClearingQueue(true)
    await window.electronAPI.clearQueueMessages()
    setQueueMessages([])
    setStatus((prev) => ({ ...prev, queueLength: 0 }))
    setClearingQueue(false)
  }

  const handleDeleteQueueMessage = async (fileId: string) => {
    await window.electronAPI.deleteQueueMessage(fileId)
    const msgs = queueMessages.filter((m) => m.fileId !== fileId)
    setQueueMessages(msgs)
    setStatus((prev) => ({ ...prev, queueLength: Math.max(0, (prev.queueLength ?? 1) - 1) }))
  }

  const getSessionQueueMessages = (sessionKey: string) =>
    queueMessages.filter((m) => m.sessionKey === sessionKey)

  const getSessionLabel = (msg: { sessionKey?: string; chatType?: string; sessionLabel?: string }) => {
    if (msg.sessionLabel) return msg.sessionLabel
    if (!msg.sessionKey) return "未知会话"
    const chatLabel = msg.chatType === "group" ? "群聊" : msg.chatType === "task" ? "定时" : "私聊"
    const tab = sessionTabs.find((t) => t.sessionKey === msg.sessionKey)
    if (tab?.label) {
      const icon = tab.kind === "project" ? "📦" : tab.kind === "temp" ? "⏱" : "📁"
      return `${chatLabel} ${icon}${tab.label}`
    }
    const running = sessionList.find((s) => s.sessionKey === msg.sessionKey)
    if (running?.chatName) return `${chatLabel} ${running.chatName}`
    const parts = msg.sessionKey.split("::")
    const suffix = parts[1] || ""
    if (suffix.startsWith("project_")) {
      const pid = suffix.slice("project_".length)
      const name = projectNameById.get(pid)
      return name ? `${chatLabel} 📦${name}` : `${chatLabel} 📦项目 ${pid.slice(0, 12)}`
    }
    if (suffix.startsWith("temp_") || msg.sessionKey.startsWith("temp_")) return `${chatLabel} ⏱临时会话`
    const peers = [
      ...sessionList.map((s) => s.workspaceDir),
      ...queueMessages.map((m) => {
        const s = m.sessionKey?.split("::")[1]
        return s && /[\\/]/.test(s) ? s : undefined
      }),
    ].filter((d): d is string => !!d)
    const dir = suffix && /[\\/]/.test(suffix) ? disambiguatePathLabel(suffix, peers.length ? peers : [suffix]) : ""
    return `${chatLabel}${dir ? ` 📁${dir}` : ""}`
  }

  const formatUptime = (seconds?: number): string => {
    if (!seconds) return "-"
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
    if (m > 0) return `${m} 分钟`
    return `${seconds} 秒`
  }

  const isStarting = starting || !!status.starting

  const sessionWsDirs = sessionList.map((s) => s.workspaceDir).filter((d): d is string => !!d)

  const activeChannels = activeChannelCount(treeChannels)

  return (
    <div className="flex h-screen flex-col">
      <TitleBar
        center={<PageTabs page="dashboard" onChange={onSwitchPage} />}
        actions={<TitleActions onSettings={onSettings} active={active} />}
      >
        <TitleBrand />
      </TitleBar>

      {/* 四张状态卡片 = 四个页签：选中哪张，下面的功能区就显示它的内容 */}
      <div role="tablist" aria-label="工作台" className="grid shrink-0 grid-cols-4 gap-3 px-6 py-4">
        <StatusCard
          tab="logs"
          selected={activeTab === "logs"}
          onSelect={() => selectTab("logs")}
          icon={status.running ? Wifi : WifiOff}
          label="Daemon"
          value={status.running ? "运行中" : isStarting ? "启动中" : "已停止"}
          color={status.running ? "green" : isStarting ? "yellow" : "red"}
          sub={
            status.running
              ? [
                  status.uptime != null ? `已运行 ${formatUptime(status.uptime)}` : "",
                  status.workspaceMismatch
                    ? (status.daemonWorkspaceDir
                      ? `目录与设置不一致（Daemon: ${status.daemonWorkspaceDir}）`
                      : "工作目录与设置不一致")
                    : "",
                ].filter(Boolean).join(" · ")
              : status.error
          }
          action={status.running ? (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-danger transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止 Daemon"
            >
              {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : isStarting ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-warning" title="正在启动 Daemon">
              <Loader2 size={10} className="animate-spin" />
              启动中
            </span>
          ) : (
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-success transition hover:bg-green-600/20 disabled:opacity-50"
              title="启动 Daemon"
            >
              {starting ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
              启动
            </button>
          )}
        />
        <StatusCard
          tab="channels"
          selected={activeTab === "channels"}
          onSelect={() => selectTab("channels")}
          icon={(status.channels ?? []).some((c) => c.connected) ? Wifi : WifiOff}
          label="消息通道"
          value={(() => {
            const chs = status.channels ?? []
            if (chs.length === 0) return status.running ? "未配置通道" : "等待连接"
            const ok = chs.filter((c) => c.connected).length
            if (ok === chs.length) return chs.length === 1 ? `${chs[0].name} 已连接` : `${ok}/${chs.length} 通道在线`
            if (ok > 0) return `${ok}/${chs.length} 通道在线`
            return status.running ? "通道连接中" : "等待连接"
          })()}
          color={(() => {
            const chs = status.channels ?? []
            const ok = chs.filter((c) => c.connected).length
            if (ok > 0 && ok === chs.length) return "green"
            if (ok > 0 || (status.running && chs.length > 0)) return "yellow"
            return "gray"
          })()}
          sub={channelsCardSub(treeChannels.length)}
        />
        <StatusCard
          tab="sessions"
          selected={activeTab === "sessions"}
          onSelect={() => selectTab("sessions")}
          icon={Bot}
          label="活跃会话"
          value={
            sessionList.length > 0
              ? `${sessionList.length} 个会话`
              : status.agentRunning ? `会话中 PID:${status.agentPid}` : "空闲"
          }
          color={status.agentRunning || sessionList.length > 0 ? "blue" : "gray"}
          sub={activeCardSub(sessionList.length, activeChannels)}
          action={status.agentRunning || sessionList.length > 0 ? (
            <button
              onClick={() => void handleStopAgent()}
              disabled={stoppingAgent}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-danger transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止全部 Agent"
            >
              {stoppingAgent ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : undefined}
        />
        <StatusCard
          tab="queue"
          selected={activeTab === "queue"}
          onSelect={() => selectTab("queue")}
          icon={MessageSquare}
          label="消息队列"
          value={(() => {
            const processing = status.queueCounts?.processing ?? 0
            const pending = status.queueCounts?.pending ?? 0
            if (processing === 0 && pending === 0) return "0"
            return (
              <span className="flex items-baseline gap-2.5">
                {processing > 0 && (
                  <span className="flex items-baseline gap-1 text-accent" title="处理中">
                    {processing}<span className="text-[10px] text-blue-500/70">处理中</span>
                  </span>
                )}
                {pending > 0 && (
                  <span className="flex items-baseline gap-1 text-warning" title="排队中">
                    {pending}<span className="text-[10px] text-yellow-500/70">排队</span>
                  </span>
                )}
              </span>
            )
          })()}
          color={(status.queueCounts?.processing ?? 0) > 0 ? "blue" : (status.queueCounts?.pending ?? 0) > 0 ? "yellow" : "gray"}
          sub={queueCardSub(status.queueLength)}
          action={status.queueLength ? (
            <button
              onClick={() => void handleClearQueue()}
              disabled={clearingQueue}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-danger transition hover:bg-red-600/20 disabled:opacity-50"
              title="清空队列"
            >
              {clearingQueue ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
              清空
            </button>
          ) : undefined}
        />
      </div>

      {/* Error message */}
      {actionError && (
        <div className="mx-6 mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-danger-line bg-danger-tint/50 px-4 py-2 text-sm text-danger-soft">
          <span className="min-w-0 flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError("")}
            className="shrink-0 rounded px-1 text-danger hover:bg-danger-tint-strong/50 hover:text-danger-bright" title="关闭">
            <X size={14} />
          </button>
        </div>
      )}

      {/* 功能区：日志常驻（切走只是藏起来），其余只在选中时渲染 */}
      <div className="relative min-h-0 flex-1">
        <TabPane tab="logs" selected={activeTab === "logs"}>
          <LogPanel resolveLabel={resolveLogSessionLabel} onError={setActionError} />
        </TabPane>
        {(activeTab === "channels" || activeTab === "sessions") && (
          <TabPane key={activeTab} tab={activeTab} selected>
            <SessionsArea
              scope={activeTab === "channels" ? "channels" : "active"}
              channels={treeChannels}
              channelId={sessionsChannelId}
              onSelectChannel={setSessionsChannelId}
              managed={managedSessions}
              queue={queueMessages}
              modelPicker={modelPicker}
              modelSwitching={modelSwitching}
              confirm={showConfirm}
              onNotice={setActionError}
              onOpenChannelSettings={() => onSettings("channel")}
              onAddFavorite={(channelId) => void addFavoriteWorkspace(channelId)}
              onSwitchModel={(sk, m) => void switchSessionModel(sk, m)}
              onStopSession={(sk) => { void window.electronAPI.stopSessionAgent(sk); void refreshDashboardTree() }}
              onDeleteSession={(node) => void deleteSessionTab(node.sessionKey, node.kind, node.label)}
              onActivateSession={(sk) => void switchSessionTab(sk)}
              onDeleteQueueItem={(fileId) => void handleDeleteQueueMessage(fileId)}
            />
          </TabPane>
        )}
        {activeTab === "queue" && (
          <TabPane tab="queue" selected>
            <QueuePanel
              messages={queueMessages}
              metaByKey={sessionMetaByKey}
              labelOf={getSessionLabel}
              onDelete={(fileId) => void handleDeleteQueueMessage(fileId)}
            />
          </TabPane>
        )}
      </div>
      {ModalPortal}
    </div>
  )
}
