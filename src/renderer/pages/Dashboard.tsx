import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from "react"
import { createPortal } from "react-dom"
import {
  Play,
  Square,
  Settings,
  RefreshCw,
  Wifi,
  WifiOff,
  Bot,
  Bird,
  MessageSquare,
  Clock,
  Loader2,
  Trash2,
  LogIn,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Package,
  Rocket,
  Search,
  X,
  Plus,
  Cpu,
} from "lucide-react"
import logoUrl from "../assets/logo.png"
import TitleBar from "../components/TitleBar"
import useInlineModal from "../components/useInlineModal"
import ChannelTree from "../components/dashboard/ChannelTree"
import PanelShell from "../components/dashboard/PanelShell"
import { modelSlug } from "../model-utils"
import { disambiguatePathLabel } from "../../shared/path-label"
import { formatLogLineForUi, cardLabelFromSessionTab } from "../../shared/log-format"
import { buildDashboardTree, GROUP_IDS, type DashboardChannelNode, type DashboardSessionNode } from "../../shared/dashboard-tree"
import SessionRow from "../components/dashboard/SessionRow"
import { makeChatKey } from "../../shared/channel-types"

interface Props {
  /** 打开设置页，可指定初始 Tab */
  onSettings: (tab?: string) => void
  /** 当前是否为可见页面（从设置页返回时立即刷新） */
  active?: boolean
}

interface OnboardState {
  workspaceReady: boolean
  agentReady: boolean
  channelReady: boolean
}

export default function Dashboard({ onSettings, active }: Props) {
  const [status, setStatus] = useState<DaemonStatus>({ running: false })
  const [logLines, setLogLines] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState("")
  const [queueMessages, setQueueMessages] = useState<{ index: number; fileId: string; preview: string; status?: "pending" | "processing"; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string; sessionLabel?: string }[]>([])
  const [treeChannels, setTreeChannels] = useState<DashboardChannelNode[]>([])
  /** 卡片面板互斥：同一时刻只展开一个，避免几块面板叠着把日志挤没 */
  const [activePanel, setActivePanel] = useState<"channels" | "sessions" | "queue" | null>(null)
  const showChannels = activePanel === "channels"
  const showSessions = activePanel === "sessions"
  const showQueue = activePanel === "queue"
  const togglePanel = (p: "channels" | "sessions" | "queue") =>
    setActivePanel((cur) => (cur === p ? null : p))
  const [expandedActive, setExpandedActive] = useState<string | null>(null)
  const [cliStatus, setCliStatus] = useState<"checking" | "installed" | "missing" | "need-login">("checking")
  const [cliLoggingIn, setCliLoggingIn] = useState(false)
  const [cliMessage, setCliMessage] = useState("")
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
  /** Agent 卡片下的扁平视图：跨通道拉平所有运行中会话，只用徽标标出来源通道 */
  const activeSessions = useMemo(() => {
    const out: { channelName: string; node: DashboardSessionNode }[] = []
    for (const ch of treeChannels) {
      for (const gid of GROUP_IDS) {
        for (const s of ch.groups[gid].sessions) {
          if (s.running) out.push({ channelName: ch.name, node: s })
        }
      }
    }
    return out
  }, [treeChannels])
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
  const [modelTabs, setModelTabs] = useState<{ model: string; modelParams?: string; label?: string }[]>([])
  const [modelSwitching, setModelSwitching] = useState("")
  const [activeSessionModel, setActiveSessionModel] = useState<{ model: string; modelParams?: string } | null>(null)
  const [modelFavPickerOpen, setModelFavPickerOpen] = useState(false)
  const [modelFavLoading, setModelFavLoading] = useState(false)
  const [modelFavOptions, setModelFavOptions] = useState<{ model: string; modelParams?: string; label?: string; used?: boolean }[]>([])
  const [modelFavQuery, setModelFavQuery] = useState("")
  const [sessionList, setSessionList] = useState<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "cli" | "sdk"; model?: string; modelParams?: string }[]>([])
  const [sessionDiag, setSessionDiag] = useState<Record<string, { running: boolean; resumeAgentId?: string; resumeUpdatedAt?: number; lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }; lastReplyAt: number | null }>>({})
  /** 切模后短暂锁住高亮，避免旧 sessionList 把 UI 刷回上一模型 */
  const modelPickHoldRef = useRef<{ sk: string; model: string; modelParams?: string; until: number } | null>(null)
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

  const refreshModelTabs = useCallback(async () => {
    const r = await window.electronAPI.listQuickModels()
    if (r.ok) setModelTabs(r.models)
  }, [])

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
      const connected = new Map((st.channels ?? []).map((c) => [c.id, !!c.connected]))
      const cfgChannels = (cfg.channels ?? []).filter((c) => c.enabled !== false)

      const dashChannels = (dash.ok && dash.channels.length > 0)
        ? dash.channels
        : cfgChannels.map((c) => {
            const raw = c.mainUserEnabled ? (c.mainUserChatId?.trim() || undefined) : undefined
            return {
              channelId: c.id,
              name: c.name,
              mainUserChatId: raw ? makeChatKey(c.id, raw) : undefined,
              mainTabs: [] as { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string }[],
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
      }[] = []
      const labelByKey = new Map<string, string>()
      const removable = new Set<string>()
      for (const ch of dashChannels) {
        if (ch.mainUserChatId && ch.activeKey) activeKeyByChat[ch.mainUserChatId] = ch.activeKey
        for (const t of ch.mainTabs) {
          labelByKey.set(t.sessionKey, t.label)
          if (t.removable) removable.add(t.sessionKey)
          if (!t.running) {
            mainSwitchable.push({
              channelId: ch.channelId,
              sessionKey: t.sessionKey,
              label: t.label,
              kind: t.kind,
              removable: t.removable,
              model: t.model,
              modelParams: t.modelParams,
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
        workspaceDir: s.workspaceDir,
        chatName: s.chatName,
      }))
      const tree = buildDashboardTree({
        channels: dashChannels.map((c) => ({
          id: c.channelId,
          name: c.name,
          connected: connected.get(c.channelId) ?? false,
          mainUserChatId: c.mainUserChatId,
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
    const current = cfg.workspaceDir ?? ""
    let favorites = cfg.favoriteWorkspaces ?? []
    const same = (a: string, b: string) => a.replace(/[\\/]+$/g, "").toLowerCase() === b.replace(/[\\/]+$/g, "").toLowerCase()
    if (current.trim() && !favorites.some((f) => same(f, current))) {
      favorites = [...favorites, current]
      void window.electronAPI.saveConfig({ favoriteWorkspaces: favorites })
    }
    setWsTabs({ current, favorites })
    await refreshModelTabs()
  }, [refreshModelTabs])

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

  const switchSessionModel = async (sk: string, m: { model: string; modelParams?: string; label?: string }) => {
    const key = `${m.model}\0${m.modelParams ?? ""}`
    if (modelSwitching || !sk) return
    setModelSwitching(key)
    try {
      const r = await window.electronAPI.setSessionModel(sk, m.model, m.modelParams)
      if (!r.ok) {
        setActionError(r.error ?? "切换模型失败")
        return
      }
      setActionError("")
      modelPickHoldRef.current = { sk, model: m.model, modelParams: m.modelParams, until: Date.now() + 12_000 }
      setActiveSessionModel({ model: m.model, modelParams: m.modelParams })
      await refreshModelTabs()
      await refreshDashboardTree()
    } finally {
      setModelSwitching("")
    }
  }

  const addFavoriteModel = async () => {
    setActionError("")
    if (modelFavPickerOpen) {
      setModelFavPickerOpen(false)
      setModelFavQuery("")
      return
    }
    setModelFavPickerOpen(true)
    setModelFavQuery("")
    setModelFavLoading(true)
    try {
      const cfg = await window.electronAPI.getConfig()
      const favs = cfg.favoriteModels ?? []
      const favKeys = new Set(favs.map((f) => `${f.model}\0${f.modelParams ?? ""}`))
      const out: { model: string; modelParams?: string; label?: string; used?: boolean }[] = []
      const seen = new Set<string>()
      const push = (m: { model: string; modelParams?: string; label?: string }, used?: boolean) => {
        if (!m.model) return
        const k = `${m.model}\0${m.modelParams ?? ""}`
        if (favKeys.has(k) || seen.has(k)) return
        seen.add(k)
        out.push({ model: m.model, modelParams: m.modelParams, label: m.label || modelSlug(m.model, m.modelParams), used })
      }

      const quick = await window.electronAPI.listQuickModels()
      if (quick.ok) {
        for (const m of quick.models) push(m, true)
      }
      for (const s of sessionList) {
        if (s.model) push({ model: s.model, modelParams: s.modelParams, label: modelSlug(s.model, s.modelParams) }, true)
      }
      if (activeSessionModel?.model) {
        push({ ...activeSessionModel, label: modelSlug(activeSessionModel.model, activeSessionModel.modelParams) }, true)
      }

      const sdkRes = (cfg.agentResources ?? []).find((r) => r.type === "sdk" && r.apiKey?.trim())
      if (sdkRes?.apiKey) {
        const r = await window.electronAPI.listSdkModels(sdkRes.apiKey, activeSessionModel?.model, activeSessionModel?.modelParams)
        if (r.ok) {
          for (const m of r.models) {
            push({ model: m.id, modelParams: m.params, label: m.label }, false)
          }
        }
      } else {
        const r = await window.electronAPI.listModels()
        if (r.ok) {
          for (const m of r.models) push({ model: m.id, modelParams: "", label: m.label || m.id }, false)
        }
      }

      // 用过的置顶
      out.sort((a, b) => Number(!!b.used) - Number(!!a.used))
      setModelFavOptions(out)
      if (out.length === 0) {
        setModelFavPickerOpen(false)
        setActionError(favs.length > 0 ? "可用模型均已在常用中" : "暂无模型可收藏：请先配置 Agent SDK Key 或产生过会话")
      }
    } finally {
      setModelFavLoading(false)
    }
  }

  const pickFavoriteModel = async (m: { model: string; modelParams?: string; label?: string }) => {
    setActionError("")
    const cfg = await window.electronAPI.getConfig()
    const favs = [...(cfg.favoriteModels ?? [])]
    if (favs.some((f) => f.model === m.model && (f.modelParams ?? "") === (m.modelParams ?? ""))) {
      setActionError("该模型已在常用列表中")
      setModelFavPickerOpen(false)
      setModelFavQuery("")
      return
    }
    favs.push({ model: m.model, modelParams: m.modelParams, label: m.label || modelSlug(m.model, m.modelParams) })
    await window.electronAPI.saveConfig({ favoriteModels: favs })
    setModelFavPickerOpen(false)
    setModelFavQuery("")
    await refreshModelTabs()
  }

  const removeFavoriteModel = async (m: { model: string; modelParams?: string }) => {
    const cfg = await window.electronAPI.getConfig()
    const key = `${m.model}\0${m.modelParams ?? ""}`
    const favs = (cfg.favoriteModels ?? []).filter(
      (f) => `${f.model}\0${f.modelParams ?? ""}` !== key,
    )
    await window.electronAPI.saveConfig({ favoriteModels: favs })
    // 快捷栏 = 收藏 ∪ 最近；只删收藏会从「最近」补回来，看起来像 ❌ 无效
    await window.electronAPI.forgetQuickModel(m.model, m.modelParams)
    await refreshModelTabs()
  }

  useEffect(() => {
    const hold = modelPickHoldRef.current
    if (hold && Date.now() < hold.until && (!activeSessionKey || activeSessionKey === hold.sk)) {
      setActiveSessionModel({ model: hold.model, modelParams: hold.modelParams })
      const live = sessionList.find((s) => s.sessionKey === hold.sk)
      if (live?.model === hold.model && (live.modelParams ?? "") === (hold.modelParams ?? "")) {
        modelPickHoldRef.current = null
      }
      return
    }
    if (hold && Date.now() >= hold.until) modelPickHoldRef.current = null
    const hit = (activeSessionKey && sessionList.find((s) => s.sessionKey === activeSessionKey && s.model))
      || [...sessionList.filter((s) => s.model)].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0]
    if (hit?.model) setActiveSessionModel({ model: hit.model, modelParams: hit.modelParams })
  }, [sessionList, activeSessionKey])

  const [exportingDiag, setExportingDiag] = useState(false)
  const [logFilter, setLogFilter] = useState("")
  const [logAtBottom, setLogAtBottom] = useState(true)
  const [logMatchCursor, setLogMatchCursor] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)
  /** 是否贴底跟随：用户上翻后暂停自动滚动，回到底部（或点击按钮）后恢复 */
  const logStickRef = useRef(true)
  const programmaticScrollRef = useRef(false)

  useEffect(() => {
    const syncCliStatus = (s: DaemonStatus) => {
      if (s.running && s.cliAvailable !== undefined) {
        setCliStatus((prev) =>
          !s.cliAvailable && (prev === "installed" || prev === "need-login") ? "missing" : prev,
        )
      }
    }

    const refresh = async () => {
      const s = await window.electronAPI.getDaemonStatus()
      setStatus(s)
      syncCliStatus(s)
      window.electronAPI.getSessionAgents().then(setSessionList).catch(() => {})
      await refreshOnboard()
      await refreshDashboardTree()
    }
    refresh()
    const timer = setInterval(refresh, 5_000)

    window.electronAPI.getLogBuffer().then((buf) => {
      if (buf.length > 0) setLogLines(buf.slice(-300))
    })

    const unsub = window.electronAPI.onDaemonStatus((s) => {
      setStatus(s)
      syncCliStatus(s)
    })
    const unsubLog = window.electronAPI.onDaemonLog((line) => {
      setLogLines((prev) => {
        const next = [...prev, line]
        return next.length > 300 ? next.slice(-300) : next
      })
    })

    let cancelCliSchedule: (() => void) | undefined
    window.electronAPI.getConfig().then((cfg) => {
      // 仅当存在绑定 CLI 资源的通道时才提示 CLI 安装/登录
      const cliInUse = (cfg.channels ?? []).some((c) => c.enabled && c.agentResourceId === "cli")
        || (cfg.channels ?? []).length === 0
      if (!cliInUse) {
        setCliStatus("installed")
        return
      }
      const runCliChecks = () => {
        void (async () => {
          const installed = await window.electronAPI.checkCli()
          if (!installed) {
            setCliStatus("missing")
            return
          }
          const st = await window.electronAPI.checkCliLogin()
          setCliStatus(st.loggedIn ? "installed" : "need-login")
        })()
      }
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(runCliChecks, { timeout: 2500 })
        cancelCliSchedule = () => cancelIdleCallback(id)
      } else {
        const cliTimer = window.setTimeout(runCliChecks, 0)
        cancelCliSchedule = () => clearTimeout(cliTimer)
      }
    })

    const unsubSessions = window.electronAPI.onSessionAgents?.((list: typeof sessionList) => { setSessionList(list); void refreshDashboardTree() })

    return () => {
      clearInterval(timer)
      cancelCliSchedule?.()
      unsub()
      unsubLog()
      unsubSessions?.()
    }
  }, [])

  const logQuery = logFilter.trim()
  const logMatchIndexes = useMemo(() => {
    const q = logQuery.toLowerCase()
    if (!q) return [] as number[]
    const out: number[] = []
    for (let i = 0; i < logLines.length; i++) {
      if (logLines[i].toLowerCase().includes(q)) out.push(i)
    }
    return out
  }, [logLines, logQuery])

  useEffect(() => {
    setLogMatchCursor(0)
  }, [logQuery])

  const jumpToLogMatch = (dir: -1 | 1) => {
    if (logMatchIndexes.length === 0) return
    const next = (logMatchCursor + dir + logMatchIndexes.length) % logMatchIndexes.length
    setLogMatchCursor(next)
    const lineIdx = logMatchIndexes[next]
    const el = logRef.current?.querySelector(`[data-log-idx="${lineIdx}"]`)
    if (!el) return
    logStickRef.current = false
    programmaticScrollRef.current = true
    setLogAtBottom(false)
    el.scrollIntoView({ block: "center" })
  }

  // layout 阶段同步吸底：避免 append 后 scroll 事件先于 rAF 误判离开底部
  useLayoutEffect(() => {
    if (!logStickRef.current) return
    const el = logRef.current
    if (!el) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
  }, [logLines, logFilter])

  /** 向上滚 = 明确离开底部的用户意图；scroll 事件可能被程序化标记吞掉，wheel 兜底解除吸底 */
  const handleLogWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0 && logStickRef.current) {
      logStickRef.current = false
      programmaticScrollRef.current = false
      setLogAtBottom(false)
    }
  }

  const handleLogScroll = () => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    // 离开底部：无条件取消吸底（覆盖程序化标记）。
    // 旧逻辑在 programmatic 期间吞掉一切 scroll，高频日志时用户上翻会被立刻拽回底部。
    if (!atBottom) {
      programmaticScrollRef.current = false
      if (logStickRef.current) logStickRef.current = false
      setLogAtBottom(false)
      return
    }
    // 仍在底部：程序化吸底触发的 scroll 只清标记，不改 stick
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      return
    }
    logStickRef.current = true
    setLogAtBottom(true)
  }

  const scrollLogToBottom = () => {
    logStickRef.current = true
    setLogAtBottom(true)
    programmaticScrollRef.current = true
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }

  // CLI 已登录也视为 Agent 资源就绪
  useEffect(() => {
    if (cliStatus === "installed") {
      setOnboard((prev) => (prev ? { ...prev, agentReady: true } : prev))
    }
  }, [cliStatus])

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

  const handleRefresh = async () => {
    const s = await window.electronAPI.getDaemonStatus()
    setStatus(s)
    if (s.queueLength && s.queueLength > 0) {
      const msgs = await window.electronAPI.getQueueMessages()
      setQueueMessages(msgs)
    } else {
      setQueueMessages([])
    }
  }

  const handleLoginOnly = async () => {
    setCliLoggingIn(true)
    setCliMessage("")
    try {
      const loginResult = await window.electronAPI.loginCli()
      if (!loginResult.ok) {
        setCliMessage(loginResult.output)
        setCliLoggingIn(false)
        return
      }
      const st = await window.electronAPI.checkCliLogin()
      if (st.loggedIn) {
        setCliStatus("installed")
        setCliMessage("")
      } else {
        setCliMessage(st.error ?? loginResult.output ?? "登录后仍未检测到账号，请重试")
      }
    } catch (e: unknown) {
      setCliMessage(e instanceof Error ? e.message : String(e))
    }
    setCliLoggingIn(false)
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

  const toggleQueue = async () => {
    if (!showQueue) await refreshQueueMessages()
    togglePanel("queue")
  }

  const handleClearQueue = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setClearingQueue(true)
    await window.electronAPI.clearQueueMessages()
    setQueueMessages([])
    setStatus((prev) => ({ ...prev, queueLength: 0 }))
    setClearingQueue(false)
  }

  const handleDeleteQueueMessage = async (fileId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    await window.electronAPI.deleteQueueMessage(fileId)
    const msgs = queueMessages.filter((m) => m.fileId !== fileId)
    setQueueMessages(msgs)
    setStatus((prev) => ({ ...prev, queueLength: Math.max(0, (prev.queueLength ?? 1) - 1) }))
  }

    const handleExportDiagnostics = async () => {
    setExportingDiag(true)
    try {
      const r = await window.electronAPI.exportDiagnostics()
      if (!r.ok) setActionError(r.error ?? "诊断包导出失败")
    } finally {
      setExportingDiag(false)
    }
  }

  const getSessionQueueMessages = (sessionKey: string) =>
    queueMessages.filter((m) => m.sessionKey === sessionKey)

  const formatTimestamp = (ts?: number) => {
    if (!ts) return ""
    const d = new Date(ts)
    return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  }

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

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <div className="flex flex-1 items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={logoUrl} alt="logo" className="h-6 w-6" />
            <h1 className="text-lg font-semibold">LK Harness</h1>
            {status.version && (
              <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                v{status.version}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <button
              onClick={handleRefresh}
              className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
              title="刷新状态"
            >
              <RefreshCw size={16} />
            </button>
            <button
              onClick={() => onSettings()}
              className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
              title="设置"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
      </TitleBar>

      {/* Status cards */}
      <div className="grid shrink-0 grid-cols-4 gap-3 px-6 py-4">
        <StatusCard
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
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止 Daemon"
            >
              {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : isStarting ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-yellow-400" title="正在启动 Daemon">
              <Loader2 size={10} className="animate-spin" />
              启动中
            </span>
          ) : (
            <button
              onClick={handleStart}
              disabled={starting}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-green-400 transition hover:bg-green-600/20 disabled:opacity-50"
              title="启动 Daemon"
            >
              {starting ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />}
              启动
            </button>
          )}
        />
        <div
          onClick={() => { if (treeChannels.length > 0) togglePanel("channels") }}
          className={treeChannels.length > 0 ? "cursor-pointer" : ""}
        >
          <StatusCard
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
            sub={treeChannels.length > 0 ? (showChannels ? "点击收起会话树" : "点击展开会话树") : "等待目标"}
            action={treeChannels.length > 0 ? (
              showChannels ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />
            ) : undefined}
          />
        </div>
        <div
          onClick={() => { if (sessionList.length > 0) togglePanel("sessions") }}
          className={sessionList.length > 0 ? "cursor-pointer" : ""}
        >
        <StatusCard
          icon={Bot}
          label="Agent"
          value={
            sessionList.length > 0
              ? `${sessionList.length} 个会话`
              : status.agentRunning ? `会话中 PID:${status.agentPid}` : "空闲"
          }
          color={status.agentRunning || sessionList.length > 0 ? "blue" : "gray"}
          sub={sessionList.length > 0 ? (showSessions ? "点击收起活跃会话" : "点击查看活跃会话") : "等待消息"}
          action={status.agentRunning || sessionList.length > 0 ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleStopAgent() }}
              disabled={stoppingAgent}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
              title="停止全部 Agent"
            >
              {stoppingAgent ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              停止
            </button>
          ) : undefined}
        />
        </div>
        <div onClick={() => void toggleQueue()} className="cursor-pointer">
        <StatusCard
          icon={MessageSquare}
          label="消息队列"
          value={(() => {
            const processing = status.queueCounts?.processing ?? 0
            const pending = status.queueCounts?.pending ?? 0
            if (processing === 0 && pending === 0) return "0"
            return (
              <span className="flex items-baseline gap-2.5">
                {processing > 0 && (
                  <span className="flex items-baseline gap-1 text-blue-400" title="处理中">
                    {processing}<span className="text-[10px] text-blue-500/70">处理中</span>
                  </span>
                )}
                {pending > 0 && (
                  <span className="flex items-baseline gap-1 text-yellow-400" title="排队中">
                    {pending}<span className="text-[10px] text-yellow-500/70">排队</span>
                  </span>
                )}
              </span>
            )
          })()}
          color={(status.queueCounts?.processing ?? 0) > 0 ? "blue" : (status.queueCounts?.pending ?? 0) > 0 ? "yellow" : "gray"}
          sub={showQueue ? "点击收起明细" : "点击查看明细"}
          action={status.queueLength ? (
            <button
              onClick={handleClearQueue}
              disabled={clearingQueue}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition hover:bg-red-600/20 disabled:opacity-50"
              title="清空队列"
            >
              {clearingQueue ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
              清空
            </button>
          ) : undefined}
        />
        </div>
      </div>

      {showSessions && (
        <PanelShell title="活跃会话" meta={`${activeSessions.length} 个运行中`}>
          {activeSessions.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-gray-600">当前没有运行中的会话</p>
          ) : (
            activeSessions.map(({ channelName, node }) => (
              <SessionRow
                key={node.sessionKey}
                node={node}
                channelName={channelName}
                quickModels={modelTabs}
                modelSwitching={modelSwitching}
                expanded={expandedActive === node.sessionKey}
                onToggle={() => setExpandedActive((k) => k === node.sessionKey ? null : node.sessionKey)}
                onSwitchModel={(m) => void switchSessionModel(node.sessionKey, m)}
                onAddFavoriteModel={() => void addFavoriteModel()}
                onRemoveFavoriteModel={(m) => void removeFavoriteModel(m)}
                onStop={() => { void window.electronAPI.stopSessionAgent(node.sessionKey); void refreshDashboardTree() }}
                onDeleteQueueItem={(fileId) => void handleDeleteQueueMessage(fileId)}
              />
            ))
          )}
        </PanelShell>
      )}

      {showQueue && (
        <PanelShell title="全局消息队列" meta={`${queueMessages.length} 条`}>
          {queueMessages.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-gray-600">队列为空</p>
          ) : (
            <div className="space-y-1.5 p-3">
              {queueMessages.map((msg) => {
                const meta = msg.sessionKey ? sessionMetaByKey.get(msg.sessionKey.toLowerCase()) : undefined
                return (
                  <div key={msg.fileId || msg.index} className="flex items-start justify-between gap-2 rounded-lg bg-gray-800/60 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {meta && (
                          <span className="shrink-0 rounded bg-gray-800 px-1 text-[10px] text-gray-400" title="所属通道">
                            {meta.channelName}
                          </span>
                        )}
                        <span className="min-w-0 truncate text-[10px] font-medium text-blue-400" title={msg.sessionKey}>
                          {meta?.label ?? getSessionLabel(msg)}
                        </span>
                        <span className={`shrink-0 rounded px-1 text-[9px] ${msg.status === "processing" ? "bg-blue-600/25 text-blue-300" : "bg-yellow-600/20 text-yellow-300"}`}>
                          {msg.status === "processing" ? "处理中" : "排队"}
                        </span>
                        <span className="shrink-0 text-[10px] text-gray-500">{formatTimestamp(msg.timestamp)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-gray-300">{msg.preview}</p>
                    </div>
                    <button
                      onClick={(e) => handleDeleteQueueMessage(msg.fileId, e)}
                      className="shrink-0 rounded p-0.5 text-gray-500 transition hover:bg-red-600/20 hover:text-red-400"
                      title="删除此消息"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </PanelShell>
      )}

      {showChannels && treeChannels.length > 0 && (
        <PanelShell
          title="消息通道"
          meta={`${treeChannels.length} 通道${activeSessions.length > 0 ? ` · 运行 ${activeSessions.length}` : ""}`}
        >
        <ChannelTree
          channels={treeChannels}
          quickModels={modelTabs}
          modelSwitching={modelSwitching}
          onAddFavorite={(channelId) => void addFavoriteWorkspace(channelId)}
          onSwitchModel={(sk, m) => void switchSessionModel(sk, m)}
          onAddFavoriteModel={() => void addFavoriteModel()}
          onRemoveFavoriteModel={(m) => void removeFavoriteModel(m)}
          onStopSession={(sk) => { void window.electronAPI.stopSessionAgent(sk); void refreshDashboardTree() }}
          onDeleteSession={(node) => void deleteSessionTab(node.sessionKey, node.kind, node.label)}
          onActivateSession={(sk) => void switchSessionTab(sk)}
          onDeleteQueueItem={(fileId) => void handleDeleteQueueMessage(fileId)}
        />
        </PanelShell>
      )}

      {/* CLI 未安装不在首页提示（Agent 资源可选 CLI 或 SDK，向导内可安装） */}
      {cliStatus === "need-login" && (
        <div className="mx-6 flex items-center justify-between rounded-lg border border-yellow-800/50 bg-yellow-950/20 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-yellow-400" />
            <span className="text-xs text-yellow-300">
              Cursor CLI 未登录 — 请完成授权后再使用自动会话等功能
            </span>
          </div>
          <button
            onClick={handleLoginOnly}
            disabled={cliLoggingIn}
            className="flex items-center gap-1.5 rounded-md bg-blue-600/20 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-600/30 disabled:opacity-50"
          >
            {cliLoggingIn ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <LogIn size={12} />
            )}
            {cliLoggingIn ? "登录中..." : "登录 Cursor"}
          </button>
        </div>
      )}
      {cliMessage && (
        <div className="mx-6 mt-1 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-gray-400">{cliMessage}</pre>
        </div>
      )}

      {/* Error message */}
      {actionError && (
        <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-300">
          <span className="min-w-0 flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError("")}
            className="shrink-0 rounded px-1 text-red-400 hover:bg-red-900/50 hover:text-red-200" title="关闭">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Logs */}
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <div className="mb-2 flex items-center justify-between gap-3 text-sm text-gray-400">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Clock size={14} className="shrink-0" />
            <span className="shrink-0">日志</span>
            <div className="relative ml-2 flex max-w-[260px] flex-1 items-center">
              <Search size={12} className="pointer-events-none absolute left-2 text-gray-600" />
              <input
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder="搜索日志..."
                className="w-full rounded-md border border-gray-800 bg-gray-900/60 py-1 pl-7 pr-7 text-xs text-gray-300 placeholder-gray-600 outline-none transition focus:border-gray-600"
              />
              {logFilter && (
                <button
                  onClick={() => setLogFilter("")}
                  className="absolute right-1.5 rounded p-0.5 text-gray-600 transition hover:text-gray-300"
                  title="清除搜索"
                >
                  <X size={11} />
                </button>
              )}
            </div>
            {logQuery && (
              <>
                <span className="shrink-0 text-[10px] text-gray-600">
                  {logMatchIndexes.length > 0
                    ? `${logMatchCursor + 1}/${logMatchIndexes.length}`
                    : "0 条命中"}
                </span>
                <button
                  type="button"
                  onClick={() => jumpToLogMatch(-1)}
                  disabled={logMatchIndexes.length === 0}
                  className="rounded p-0.5 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300 disabled:opacity-40"
                  title="上一条命中"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => jumpToLogMatch(1)}
                  disabled={logMatchIndexes.length === 0}
                  className="rounded p-0.5 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300 disabled:opacity-40"
                  title="下一条命中"
                >
                  <ChevronDown size={14} />
                </button>
              </>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => void handleExportDiagnostics()}
              disabled={exportingDiag}
              className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300 disabled:opacity-50"
              title="汇总日志、脱敏配置、会话与队列快照到单个文件，用于远程排障"
            >
              {exportingDiag ? "导出中..." : "导出诊断包"}
            </button>
            {logLines.length > 0 && (
              <button
                onClick={() => { navigator.clipboard.writeText(logLines.join("\n")) }}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
                title="复制全部日志"
              >
                复制
              </button>
            )}
            {logLines.length > 0 && (
              <button
                onClick={() => setLogLines([])}
                className="rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
              >
                清空
              </button>
            )}
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <div
            ref={logRef}
            onScroll={handleLogScroll}
            onWheel={handleLogWheel}
            className="h-full overflow-auto rounded-lg border border-gray-800 bg-gray-900/50 p-3 font-mono text-xs leading-5"
          >
            {logLines.length > 0
              ? logLines.map((line, i) => (
                  <div
                    key={i}
                    data-log-idx={i}
                    className={logMatchIndexes[logMatchCursor] === i ? "rounded bg-yellow-500/10" : undefined}
                  >
                    <LogLine
                      line={line}
                      highlight={logQuery}
                      resolveLabel={resolveLogSessionLabel}
                    />
                  </div>
                ))
              : <span className="text-gray-600">暂无日志</span>}
          </div>
          {!logAtBottom && (
            <button
              onClick={scrollLogToBottom}
              className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800/95 px-2.5 py-1 text-[11px] text-gray-300 shadow-lg transition hover:bg-gray-700"
              title="恢复自动滚动"
            >
              <ChevronDown size={12} />
              回到底部
            </button>
          )}
        </div>
      </div>
      {modelFavPickerOpen && createPortal(
        <div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-24"
          onClick={() => { setModelFavPickerOpen(false); setModelFavQuery("") }}
        >
          <div
            className="flex max-h-[60vh] w-96 flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-gray-800 p-2">
              <div className="relative flex items-center">
                <Search size={12} className="pointer-events-none absolute left-2 text-gray-600" />
                <input
                  autoFocus
                  value={modelFavQuery}
                  onChange={(e) => setModelFavQuery(e.target.value)}
                  placeholder="搜索模型…"
                  className="w-full rounded border border-gray-700 bg-gray-950 py-1.5 pl-7 pr-2 text-xs text-gray-200 outline-none placeholder:text-gray-600 focus:border-violet-500"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {modelFavLoading && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500">
                  <Loader2 size={12} className="animate-spin" />加载模型列表…
                </div>
              )}
              {!modelFavLoading && (() => {
                const q = modelFavQuery.trim().toLowerCase()
                const filtered = q
                  ? modelFavOptions.filter((m) =>
                      (m.label || "").toLowerCase().includes(q)
                      || m.model.toLowerCase().includes(q)
                      || (m.modelParams || "").toLowerCase().includes(q))
                  : modelFavOptions
                if (filtered.length === 0) {
                  return <div className="px-3 py-2 text-xs text-gray-500">{modelFavOptions.length === 0 ? "暂无可添加的模型" : "无匹配模型"}</div>
                }
                const used = filtered.filter((m) => m.used)
                const rest = filtered.filter((m) => !m.used)
                return (
                  <>
                    {used.length > 0 && (
                      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-600">用过的</div>
                    )}
                    {used.map((m) => (
                      <button key={`u:${m.model}\0${m.modelParams ?? ""}`} type="button"
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-violet-200 hover:bg-gray-800"
                        onClick={() => void pickFavoriteModel(m)}>
                        {m.label || m.model}
                      </button>
                    ))}
                    {rest.length > 0 && (
                      <div className={`px-3 py-1 text-[10px] uppercase tracking-wide text-gray-600 ${used.length ? "mt-1 border-t border-gray-800" : ""}`}>全部模型</div>
                    )}
                    {rest.map((m) => (
                      <button key={`a:${m.model}\0${m.modelParams ?? ""}`} type="button"
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800"
                        onClick={() => void pickFavoriteModel(m)}>
                        {m.label || m.model}
                      </button>
                    ))}
                  </>
                )
              })()}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {ModalPortal}
    </div>
  )
}

const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] (\w+) (.*)$/

/** 与主进程 escapeLogContentSingleLine 对应：展示时把 ⏎ 标记还原为换行 */
function displayLogMessageBody(msg: string): string {
  return msg.replace(/⏎/g, "\n")
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: "text-red-400",
  WARN: "text-yellow-400",
  INFO: "text-blue-400",
  DEBUG: "text-gray-500",
}

const PROCESS_COLORS: Record<string, string> = {
  Daemon: "text-purple-400",
  Agent: "text-cyan-400",
  Electron: "text-orange-400",
  Scheduler: "text-teal-400",
}

const CHANNEL_STATUS_TEXT: Record<string, string> = {
  connected: "在线",
  connecting: "连接中",
  qr_pending: "待扫码",
  logging_in: "登录中",
  disconnected: "已断开",
  error: "错误",
}

/** 命中片段高亮渲染（大小写不敏感） */
function renderHighlighted(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let idx: number
  while ((idx = lower.indexOf(q, i)) >= 0) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={idx} className="rounded-sm bg-yellow-500/40 text-yellow-100">{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  if (parts.length === 0) return text
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

const LogLine = memo(function LogLine({ line, highlight = "", resolveLabel }: { line: string; highlight?: string; resolveLabel?: (sk: string) => string | undefined }) {
  const view = formatLogLineForUi(line, resolveLabel)
  const m = LOG_RE.exec(view)
  if (!m) {
    return <div className="whitespace-pre-wrap break-all text-gray-400">{renderHighlighted(displayLogMessageBody(view), highlight)}</div>
  }
  const [, ts, proc, level, msg] = m
  const body = displayLogMessageBody(msg)
  return (
    <div className="whitespace-pre-wrap break-all" title={line.length > 120 ? line : undefined}>
      <span className="text-gray-600">{renderHighlighted(ts, highlight)}</span>
      {" "}
      <span className={PROCESS_COLORS[proc] ?? "text-gray-400"}>{renderHighlighted(`[${proc}]`, highlight)}</span>
      {" "}
      <span className={LEVEL_COLORS[level] ?? "text-gray-400"}>{renderHighlighted(level, highlight)}</span>
      {" "}
      <span className={level === "ERROR" ? "text-red-300" : level === "WARN" ? "text-yellow-300" : "text-gray-300"}>{renderHighlighted(body, highlight)}</span>
    </div>
  )
})

function StatusCard({
  icon: Icon,
  label,
  value,
  color,
  sub,
  action,
}: {
  icon: typeof Wifi
  label: string
  value: React.ReactNode
  color: "green" | "red" | "blue" | "yellow" | "gray"
  sub?: string
  action?: React.ReactNode
}) {
  const colors: Record<string, string> = {
    green: "text-green-400",
    red: "text-red-400",
    blue: "text-blue-400",
    yellow: "text-yellow-400",
    gray: "text-gray-500",
  }

  const dotColors: Record<string, string> = {
    green: "bg-green-400",
    red: "bg-red-400",
    blue: "bg-blue-400",
    yellow: "bg-yellow-400",
    gray: "bg-gray-600",
  }

  return (
    <div className="flex h-[88px] flex-col rounded-lg border border-gray-800 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={colors[color]} />
          <span className="text-xs text-gray-500">{label}</span>
        </div>
        <div className="min-w-0">{action}</div>
      </div>
      <div className="mt-auto">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 shrink-0 rounded-full ${dotColors[color]}`} />
          <span className={`text-sm font-medium ${colors[color]}`}>{value}</span>
        </div>
        <div className="mt-1 h-4 truncate text-xs text-gray-600">{sub ?? "\u00A0"}</div>
      </div>
    </div>
  )
}
