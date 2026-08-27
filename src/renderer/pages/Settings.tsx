import { useState, useEffect, useRef, useCallback } from "react"
import {
  ArrowLeft,
  FolderOpen,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  LogIn,
  Plus,
  Pencil,
  Trash2,
  Terminal,
  X,
  Settings as SettingsIcon,
  Network,
  Blocks,
  FileCode2,
  Timer,
  Sparkles,
  Bot,
  Download,
  Play,
  ChevronDown,
  ChevronRight,
  Wrench,
  File,
  Folder,
  FilePlus,
  FolderPlus,
  BookOpen,
  ExternalLink,
  Copy,
  Eye,
  EyeOff,
  Info,
  Github,
  MessageSquare,
  Upload,
} from "lucide-react"
import SearchableSelect from "../components/SearchableSelect"
import SortableList from "../components/SortableList"
import { FlowHubBrowser } from "../components/FlowHubBrowser"
import ToolboxPanel from "../components/ToolboxPanel"
import AgentPanel from "../components/AgentPanel"
import ChannelPanel from "../components/ChannelPanel"
import TaskPanel from "../components/TaskPanel"
import McpPanel from "../components/McpPanel"
import RulePanel from "../components/RulePanel"
import SkillPanel from "../components/SkillPanel"
import ProjectListPanel from "../components/ProjectListPanel"
import ProjectNodePanel from "../components/ProjectNodePanel"
import { PANEL_FRAME } from "../components/panel-layout"
import TitleBar from "../components/TitleBar"
import useInlineModal from "../components/useInlineModal"
import ConfigMigratePanel from "../components/ConfigMigratePanel"
import { REQUIRED_FEISHU_SCOPES, FEISHU_SCOPES_JSON, FEISHU_EVENT_SUBSCRIPTIONS } from "../constants"
import { modelSlug } from "../model-utils"

interface Props { onBack: () => void; initialTab?: string; onTabConsumed?: () => void; onReenterWizard?: () => void }

type Tab = "general" | "channel" | "proxy" | "agent" | "mcp" | "rules" | "tasks" | "skills" | "projects" | "toolbox" | "setup" | "about"
type CloseWindowAction = "ask" | "minimize" | "quit"

interface McpEditForm {
  json: string; source: "claw"; jsonError?: string
}
interface SkillFile { rootId: string; skillPath: string; name: string; content: string }
interface TaskItem {
  id: string; name: string; cron: string; content: string; enabled: boolean; independent?: boolean
  channelId?: string; model?: string; modelParams?: string; notifyChatId?: string
}
interface ProjectListItem {
  id: string
  name: string
  goal?: string
  storyUrl?: string
  productDocUrl?: string
  techDocUrl?: string
  featureBranch: string
  status: string
  groupId?: string
  groupIds?: string[]
  worktreePath?: string
  repoPath?: string
  workspaceType?: string
  metadata?: Record<string, string>
  groupChatId?: string
}
type ProjectsSubTab = "list" | "settings" | "groups"
const PROJECT_STATUS_LABEL: Record<string, string> = { active: "进行中", paused: "已暂停", done: "已完成" }

const MCP_TEMPLATE = JSON.stringify({
  "my-mcp-server": { command: "npx", args: ["-y", "@some/mcp-server"] },
}, null, 2)
const emptyMcpForm: McpEditForm = { json: MCP_TEMPLATE, source: "claw" }

const MASTER_DETAIL_TABS: Tab[] = ["agent", "channel", "rules", "skills", "mcp", "projects", "tasks"]

const TABS: { id: Tab; label: string; icon: typeof SettingsIcon }[] = [
  { id: "general", label: "通用", icon: SettingsIcon },
  { id: "proxy", label: "网络", icon: Network },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "channel", label: "消息通道", icon: MessageSquare },
  { id: "rules", label: "规则", icon: FileCode2 },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP", icon: Blocks },
  { id: "projects", label: "项目", icon: FolderOpen },
  { id: "tasks", label: "定时任务", icon: Timer },
  { id: "toolbox", label: "工具箱", icon: Wrench },
  { id: "setup", label: "帮助引导", icon: BookOpen },
  { id: "about", label: "关于", icon: Info },
]

export default function Settings({ onBack, initialTab, onTabConsumed, onReenterWizard }: Props) {
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || "general")

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab as Tab)
      onTabConsumed?.()
    }
  }, [initialTab, onTabConsumed])

  const [proxy, setProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,feishu.cn")
  const [closeWindowAction, setCloseWindowAction] = useState<CloseWindowAction>("ask")
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoUpgradePrompt, setAutoUpgradePrompt] = useState(true)
  /** 帮助引导页飞书控制台链接用 */
  const [firstFeishuAppId, setFirstFeishuAppId] = useState("")
  const [taskChannels, setTaskChannels] = useState<ChannelConfig[]>([])
  const [agentResources, setAgentResources] = useState<AgentResource[]>([])
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()

  const [appVersion, setAppVersion] = useState("")
  const [gitlabToken, setGitlabToken] = useState("")
  const [showGitlabToken, setShowGitlabToken] = useState(false)
  const [gitlabHost, setGitlabHost] = useState("")
  const [repoProfiles, setRepoProfiles] = useState<{ path: string; baseBranch: string; testBranch?: string; developBranch?: string }[]>([])
  type ProjectNodeItem = { id: string; label: string; prompt?: string; defaultPrompt?: string; hubId?: string; hubRevision?: number; hubContentHash?: string; localRevision?: number }
  type ProjectNodeGroup = { id: string; name: string; nodes: ProjectNodeItem[]; workspace?: "worktree" | "plain"; hubId?: string; hubRevision?: number; hubContentHash?: string; localRevision?: number }
  const [nodeGroups, setNodeGroups] = useState<ProjectNodeGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState("")
  const [nodeEditing, setNodeEditing] = useState<(ProjectNodeItem & { index: number }) | null>(null)
  const [groupEditing, setGroupEditing] = useState<{ id: string; name: string; index: number } | null>(null)
  const [worktreeRoot, setWorktreeRoot] = useState("")
  const [flowHubUrl, setFlowHubUrl] = useState("")
  const [flowHubToken, setFlowHubToken] = useState("")
  const [showFlowHubToken, setShowFlowHubToken] = useState(false)
  const [flowHubAuthor, setFlowHubAuthor] = useState("")
  const [hubBrowser, setHubBrowser] = useState<{ kind: "group" | "node" } | null>(null)
  const [projectsSubTab, setProjectsSubTab] = useState<ProjectsSubTab>("list")
  const [projectList, setProjectList] = useState<ProjectListItem[]>([])
  const [projectEditing, setProjectEditing] = useState<ProjectListItem | null>(null)
  const [metadataEditText, setMetadataEditText] = useState("{}")
  const [metadataExpanded, setMetadataExpanded] = useState<Record<string, boolean>>({})
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<Awaited<ReturnType<typeof window.electronAPI.checkAppUpdate>> | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [updateDownloadPct, setUpdateDownloadPct] = useState<number | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const updateDownloadingRef = useRef(false)

  const [saved, setSaved] = useState(false)
  /** 任务编辑弹窗的模型选项（按所选通道的 Agent 资源拉取） */
  const [taskModelOptions, setTaskModelOptions] = useState<{ id: string; label: string; params: string }[]>([])
  const [loadingTaskModels, setLoadingTaskModels] = useState(false)

  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([])
  const [mcpLoading, setMcpLoading] = useState<Record<string, boolean>>({})
  const [mcpStatusLoading, setMcpStatusLoading] = useState(true)
  const [mcpEditing, setMcpEditing] = useState<McpEditForm | null>(null)
  const [mcpEditOriginalName, setMcpEditOriginalName] = useState<string | null>(null)
  const [mcpExpanded, setMcpExpanded] = useState<string | null>(null)
  const [mcpTools, setMcpTools] = useState<Record<string, { loading: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }>>({})
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({})

  const toggleMcpExpand = async (name: string) => {
    if (mcpExpanded === name) { setMcpExpanded(null); return }
    setMcpExpanded(name)
    if (!mcpTools[name]) {
      setMcpTools((p) => ({ ...p, [name]: { loading: true, tools: [] } }))
      const res = await window.electronAPI.getMcpTools(name)
      setMcpTools((p) => ({ ...p, [name]: { loading: false, tools: res.tools, error: res.ok ? undefined : res.error } }))
    }
  }

  const [skillRoots, setSkillRoots] = useState<{ id: string; label: string; path: string; skillCount: number }[]>([])
  const [skillRootId, setSkillRootId] = useState("cursor")
  const [skills, setSkills] = useState<SkillFile[]>([])
  const [skillTree, setSkillTree] = useState<SkillTreeNode[]>([])
  const [skillExpanded, setSkillExpanded] = useState<Set<string>>(new Set())
  const [skillEditing, setSkillEditing] = useState<SkillFile | null>(null)
  const [skillEditOriginalName, setSkillEditOriginalName] = useState<string | null>(null)
  const [skillFileEditing, setSkillFileEditing] = useState<{ rootId: string; skillPath: string; relativePath: string; content: string } | null>(null)
  const [skillPrompt, setSkillPrompt] = useState<{ rootId: string; skillPath: string; parentPath: string; kind: "file" | "folder"; value: string } | null>(null)
  const [skillDeleteConfirm, setSkillDeleteConfirm] = useState<{ rootId: string; skillPath: string; relativePath: string } | null>(null)

  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [taskEditing, setTaskEditing] = useState<TaskItem | null>(null)
  const [taskCronValid, setTaskCronValid] = useState(true)
  const [cronPreviewRuns, setCronPreviewRuns] = useState<string[] | null>(null)
  const [cronPreviewErr, setCronPreviewErr] = useState<string | null>(null)
  const [cronPreviewLoading, setCronPreviewLoading] = useState(false)
  const cronPreviewReq = useRef(0)
  const cronPreviewTaskIdRef = useRef("")
  const [taskStatuses, setTaskStatuses] = useState<Record<string, { running: boolean; pid?: number; startedAt?: number }>>({})

  const loaded = useRef(false)
  const projectsLoaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const projectsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const refreshMcpServers = useCallback(async (force = false) => {
    setMcpRefreshing(true)
    setMcpStatusLoading(true)
    const [servers, enabled, status] = await Promise.all([
      window.electronAPI.getMcpServers(),
      window.electronAPI.getMcpEnabledMap(force),
      window.electronAPI.getMcpStatusMap(force),
    ])
    setMcpServers(servers.map((s) => ({ ...s, enabled: enabled[s.name] ?? false })))
    setMcpStatus(status)
    setMcpStatusLoading(false)
    setMcpRefreshing(false)
    for (const s of servers) {
      window.electronAPI.getMcpTools(s.name).then((res) => {
        setMcpTools((p) => ({ ...p, [s.name]: { loading: false, tools: res.tools, error: res.ok ? undefined : res.error } }))
      })
    }
  }, [])
  const refreshSkillRoots = useCallback(() => {
    window.electronAPI.getSkillRoots().then((roots) => {
      setSkillRoots(roots)
      if (!roots.some((r) => r.id === skillRootId) && roots[0]) setSkillRootId(roots[0].id)
    })
  }, [skillRootId])
  const refreshSkills = useCallback(() => {
    window.electronAPI.getSkills(skillRootId).then(setSkills)
    window.electronAPI.getSkillTree(skillRootId).then(setSkillTree)
  }, [skillRootId])
  const refreshTasks = useCallback(() => {
    window.electronAPI.getScheduledTasks().then(setTasks)
  }, [])
  const refreshProjectList = useCallback(() => {
    void window.electronAPI.listProjects().then(setProjectList).catch(() => setProjectList([]))
  }, [])

  useEffect(() => {
    void window.electronAPI.getAppVersion().then(setAppVersion)
  }, [])


  useEffect(() => {
    updateDownloadingRef.current = updateDownloading
  }, [updateDownloading])

  useEffect(() => {
    const offS = window.electronAPI.onUpdaterStatus((s) => {
      if (s.kind === "downloading") {
        setUpdateDownloading(true)
        setUpdateDownloadPct(null)
        setUpdateMsg("正在下载更新…")
      }
      if (s.kind === "downloaded") {
        setUpdateDownloading(false)
        setUpdateDownloadPct(null)
        setUpdateMsg(`新版本 v${s.version} 已下载，可立即安装。`)
        void window.electronAPI.checkAppUpdate().then((r) => {
          if (r.status === "ready" || r.status === "available") {
            setUpdateCheck(r)
          }
        })
      }
    })
    const offP = window.electronAPI.onUpdaterProgress((pct) => {
      if (!updateDownloadingRef.current) {
        return
      }
      const p = Math.round(pct)
      setUpdateDownloadPct(p)
      setUpdateMsg(`正在下载更新… ${p}%`)
    })
    const offE = window.electronAPI.onUpdaterError((m) => {
      setUpdateDownloading(false)
      setUpdateDownloadPct(null)
      setUpdateMsg((prev) => (prev ? `${prev}\n${m}` : m))
    })
    return () => {
      offS()
      offP()
      offE()
    }
  }, [])

  useEffect(() => {
    if (tab !== "about") {
      return
    }
    void window.electronAPI.checkAppUpdate().then((r) => {
      if (r.status === "ready") {
        setUpdateCheck(r)
        setUpdateDownloading(false)
        setUpdateDownloadPct(null)
        setUpdateMsg(`新版本 v${r.latestVersion} 已下载，可立即安装。`)
      } else if (r.status === "available") {
        setUpdateCheck(r)
        if (!updateDownloading) {
          setUpdateMsg(`发现新版本 v${r.latestVersion}，当前 v${r.currentVersion}。`)
        }
      } else if (r.status === "latest") {
        setUpdateCheck(r)
        setUpdateDownloading(false)
        setUpdateDownloadPct(null)
      }
    })
  }, [tab])

  useEffect(() => {
    const unsub1 = window.electronAPI.onMcpLoginComplete(({ serverName, ok }) => {
      if (ok) setMcpServers((prev) => prev.map((s) => s.name === serverName ? { ...s, authenticated: true } : s))
    })
    const unsub2 = window.electronAPI.onScheduledTaskStatus(setTaskStatuses)
    return () => { unsub1(); unsub2() }
  }, [])

  useEffect(() => {
    if (tab === "general" || tab === "setup") window.electronAPI.getConfig().then((config) => {
      setProxy(config.httpProxy || config.httpsProxy || "")
      setNoProxy(config.noProxy || "localhost,127.0.0.1,feishu.cn")
      setCloseWindowAction(config.closeWindowAction ?? "ask")
      setAutoLaunch(config.autoStart ?? false)
      setFirstFeishuAppId(config.channels?.find((c) => c.type === "feishu")?.larkAppId ?? config.larkAppId ?? "")
      loaded.current = true
    })
    if (tab === "mcp") refreshMcpServers()
    if (tab === "skills") { refreshSkillRoots(); refreshSkills() }
    if (tab === "tasks") {
      refreshTasks()
      window.electronAPI.getScheduledTaskStatus().then(setTaskStatuses)
      window.electronAPI.getConfig().then((cfg) => {
        setTaskChannels(cfg.channels ?? [])
        setAgentResources(cfg.agentResources ?? [])
      })
    }
    if (tab === "about") {
      window.electronAPI.getConfig().then((config) => {
        setAutoUpgradePrompt(config.autoUpgradePrompt !== false)
      })
    }
    if (tab === "projects") {
      projectsLoaded.current = false
      refreshProjectList()
      window.electronAPI.getConfig().then((config) => {
        setGitlabToken(config.gitlabToken ?? "")
        setGitlabHost(config.gitlabHost ?? "")
        const profiles = (config.repoProfiles?.length)
          ? config.repoProfiles
          : (config.repoRoots ?? []).map((p) => ({ path: p, baseBranch: "" }))
        setRepoProfiles(profiles)
        setWorktreeRoot(config.worktreeRoot ?? "")
        setFlowHubUrl(config.flowHubUrl ?? "")
        setFlowHubToken(config.flowHubToken ?? "")
        setFlowHubAuthor(config.flowHubAuthor ?? "")
        projectsLoaded.current = true
      })
      window.electronAPI.getProjectNodeGroups().then((gs) => {
        setNodeGroups(gs)
        setActiveGroupId((prev) => gs.some((g) => g.id === prev) ? prev : (gs[0]?.id ?? ""))
      }).catch(() => {})
    }
  }, [tab, refreshMcpServers, refreshSkillRoots, refreshSkills, refreshTasks, refreshProjectList])

  useEffect(() => {
    if (tab !== "skills") return
    refreshSkills()
  }, [skillRootId, tab, refreshSkills])

  const autoSave = useCallback(() => {
    if (!loaded.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      await window.electronAPI.saveConfig({
        httpProxy: proxy.trim(), httpsProxy: proxy.trim(), noProxy: noProxy.trim(),
        closeWindowAction,
      })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    }, 500)
  }, [proxy, noProxy, closeWindowAction])

  useEffect(() => { autoSave() }, [autoSave])

  const autoSaveProjects = useCallback(() => {
    if (!projectsLoaded.current || tab !== "projects") return
    if (projectsSaveTimer.current) clearTimeout(projectsSaveTimer.current)
    projectsSaveTimer.current = setTimeout(async () => {
      const profiles = repoProfiles
        .map((p) => ({
          path: p.path.trim(),
          baseBranch: p.baseBranch.trim(),
          testBranch: p.testBranch?.trim() || undefined,
          developBranch: p.developBranch?.trim() || undefined,
        }))
        .filter((p) => p.path)
      await window.electronAPI.saveConfig({
        gitlabToken: gitlabToken.trim(),
        gitlabHost: gitlabHost.trim(),
        repoProfiles: profiles,
        repoRoots: profiles.map((p) => p.path),
        worktreeRoot: worktreeRoot.trim(),
        flowHubUrl: flowHubUrl.trim(),
        flowHubToken: flowHubToken.trim(),
        flowHubAuthor: flowHubAuthor.trim(),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }, 500)
  }, [tab, gitlabToken, gitlabHost, repoProfiles, worktreeRoot, flowHubUrl, flowHubToken, flowHubAuthor])

  const hubUrlReady = flowHubUrl.trim().length > 0
  const hubConfigured = hubUrlReady && (flowHubToken.trim().length > 0 || gitlabToken.trim().length > 0)

  const openHubBrowser = (kind: "group" | "node") => {
    if (!hubUrlReady) {
      void showAlert("无法连接共享空间", "请先填写 Hub 地址。")
      return
    }
    if (!hubConfigured) {
      void showAlert("无法连接共享空间", "请填写 Hub Token，或在「项目设置」中配置 GitLab Token。")
      return
    }
    setHubBrowser({ kind })
  }

  const refreshNodeGroups = useCallback(async () => {
    const gs = await window.electronAPI.getProjectNodeGroups()
    setNodeGroups(gs)
    setActiveGroupId((prev) => gs.some((g) => g.id === prev) ? prev : (gs[0]?.id ?? ""))
  }, [])

  useEffect(() => { autoSaveProjects() }, [autoSaveProjects])

  const handleCheckUpdate = async () => {
    setUpdateBusy(true)
    setUpdateMsg(null)
    setUpdateCheck(null)
    setUpdateDownloadPct(null)
    setUpdateDownloading(false)
    try {
      const r = await window.electronAPI.checkAppUpdate()
      setUpdateCheck(r)
      if (r.status === "latest") {
        setUpdateMsg(`已是最新 v${r.latestVersion}。`)
      } else if (r.status === "dev") {
        setUpdateMsg(r.message)
      } else if (r.status === "error") {
        setUpdateMsg(r.message)
      } else if (r.status === "available") {
        setUpdateMsg(`发现新版本 v${r.latestVersion}，当前 v${r.currentVersion}。`)
      } else if (r.status === "ready") {
        setUpdateMsg(`新版本 v${r.latestVersion} 已下载，可立即安装。`)
      }
    } finally {
      setUpdateBusy(false)
    }
  }

  const handleApplyUpdate = async () => {
    setUpdateBusy(true)
    setUpdateMsg("正在连接更新服务器…")
    try {
      const res = await window.electronAPI.applyAppUpdate()
      if (res.ok) {
        setUpdateMsg(res.message ?? "已触发更新流程。")
        setUpdateCheck(null)
      } else {
        setUpdateDownloading(false)
        setUpdateDownloadPct(null)
        setUpdateMsg(res.error ?? "更新失败")
      }
    } finally {
      setUpdateBusy(false)
    }
  }

  const taskModalOpen = taskEditing !== null
  const taskIdForCronPreview = taskEditing?.id ?? ""
  const taskCronForPreview = taskEditing?.cron ?? ""

  useEffect(() => {
    if (!taskModalOpen) {
      cronPreviewTaskIdRef.current = ""
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
      setCronPreviewLoading(false)
      return
    }
    const cron = taskCronForPreview.trim()
    if (!cron) {
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
      setCronPreviewLoading(false)
      return
    }
    if (cronPreviewTaskIdRef.current !== taskIdForCronPreview) {
      cronPreviewTaskIdRef.current = taskIdForCronPreview
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
    }
    const req = ++cronPreviewReq.current
    const t = setTimeout(async () => {
      if (req !== cronPreviewReq.current) return
      setCronPreviewLoading(true)
      setCronPreviewErr(null)
      try {
        const r = await window.electronAPI.previewCronNextRuns(cron)
        if (req !== cronPreviewReq.current) return
        if (r.ok) {
          setCronPreviewRuns(r.runs)
        } else {
          setCronPreviewRuns(null)
          setCronPreviewErr(r.error)
        }
      } finally {
        if (req === cronPreviewReq.current) setCronPreviewLoading(false)
      }
    }, 320)
    return () => clearTimeout(t)
  }, [taskModalOpen, taskIdForCronPreview, taskCronForPreview])

  /** 按任务所选通道的 Agent 资源拉取模型列表 */
  const fetchTaskModels = async (channelId?: string, silent = false) => {
    const channel = taskChannels.find((c) => c.id === channelId) ?? taskChannels[0]
    const resource = agentResources.find((r) => r.id === channel?.agentResourceId)
    setLoadingTaskModels(true)
    try {
      if (resource?.type === "sdk") {
        const r = await window.electronAPI.listSdkModels(resource.apiKey ?? "")
        if (r.ok && r.models.length > 0) setTaskModelOptions(r.models)
        else if (!r.ok && !silent) void showAlert("错误", r.error || "获取模型列表失败")
      } else {
        const r = await window.electronAPI.listModels()
        if (r.ok && r.models.length > 0) setTaskModelOptions(r.models.map((m) => ({ ...m, label: m.id, params: "" })))
        else if (!r.ok && !silent) void showAlert("错误", r.error || "获取模型列表失败")
      }
    } finally {
      setLoadingTaskModels(false)
    }
  }

  // 任务弹窗打开与切换通道时自动加载模型列表（静默失败，按钮可手动重试）
  const taskModalVisible = taskEditing !== null
  const taskModelChannelId = taskEditing?.channelId
  useEffect(() => {
    if (!taskModalVisible) return
    setTaskModelOptions([])
    void fetchTaskModels(taskModelChannelId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModalVisible, taskModelChannelId])

  const handleAutoLaunchToggle = async () => {
    const next = !autoLaunch
    setAutoLaunch(next)
    await window.electronAPI.setAutoStart(next)
  }

  const handleAutoUpgradePromptToggle = async () => {
    const next = !autoUpgradePrompt
    setAutoUpgradePrompt(next)
    await window.electronAPI.saveConfig({ autoUpgradePrompt: next })
  }

  // ── MCP ──
  const handleMcpToggle = async (name: string, enabled: boolean) => {
    setMcpServers((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s))
    setMcpLoading((p) => ({ ...p, [name]: true }))
    const res = await window.electronAPI.toggleMcp(name, enabled)
    setMcpLoading((p) => ({ ...p, [name]: false }))
    if (!res.ok) {
      setMcpServers((prev) => prev.map((s) => s.name === name ? { ...s, enabled: !enabled } : s))
      void showAlert("错误", res.output || `MCP ${enabled ? "启用" : "禁用"}失败`)
    }
  }
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim()
  const [mcpLoginPending, setMcpLoginPending] = useState<Record<string, boolean>>({})
  const handleMcpLogin = (name: string) => {
    setMcpLoginPending((p) => ({ ...p, [name]: true }))
    window.electronAPI.loginMcp(name).then((res) => {
      setMcpLoginPending((p) => ({ ...p, [name]: false }))
      if (res.ok) {
        setMcpServers((prev) => prev.map((s) => s.name === name ? { ...s, authenticated: true } : s))
      }
    })
  }
  const openMcpAdd = () => { setMcpEditOriginalName(null); setMcpEditing({ ...emptyMcpForm }) }
  const openMcpEdit = (s: McpServerEntry) => {
    setMcpEditOriginalName(s.name)
    const inner = s.rawConfig ?? {}
    setMcpEditing({ json: JSON.stringify({ [s.name]: inner }, null, 2), source: s.source })
  }
  const handleMcpDelete = async (name: string) => {
    await window.electronAPI.deleteMcpServer(name)
    setMcpServers((prev) => prev.filter((s) => s.name !== name))
  }
  const handleMcpSave = async () => {
    if (!mcpEditing) return
    const setErr = (msg: string) => setMcpEditing({ ...mcpEditing, jsonError: msg })
    let raw = mcpEditing.json.trim()

    // 兼容粘贴片段 `"name": { ... }` —— 补成 `{ "name": { ... } }`
    if (raw.startsWith('"') && !raw.startsWith('{')) raw = `{${raw}}`

    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(raw) }
    catch { setErr("JSON 格式无效"); return }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setErr("JSON 必须是一个对象"); return
    }

    // 兼容完整 mcp.json 格式 `{ "mcpServers": { ... } }`
    if ("mcpServers" in parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
      parsed = parsed.mcpServers as Record<string, unknown>
    }

    const keys = Object.keys(parsed)
    if (keys.length === 0) { setErr("JSON 中没有 MCP 服务器配置"); return }
    if (keys.length !== 1) { setErr("一次只能保存一个 MCP 服务器"); return }

    const name = keys[0]
    const entry = parsed[name]
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      setErr(`"${name}" 的值必须是一个对象`); return
    }
    if (mcpEditOriginalName && mcpEditOriginalName !== name) await window.electronAPI.deleteMcpServer(mcpEditOriginalName)
    await window.electronAPI.saveMcpServer(name, entry as Record<string, unknown>, mcpEditing.source)
    const isNew = !mcpEditOriginalName
    if (isNew) window.electronAPI.toggleMcp(name, true)
    const isUrl = "url" in (entry as Record<string, unknown>) && !("command" in (entry as Record<string, unknown>))
    const saved: McpServerEntry = {
      name, type: isUrl ? "url" : "command", source: mcpEditing.source,
      ...(isUrl ? { url: (entry as Record<string, string>).url } : { command: (entry as Record<string, string>).command, args: (entry as Record<string, string[]>).args }),
      rawConfig: entry as Record<string, unknown>,
      enabled: isNew ? true : undefined,
    }
    setMcpServers((prev) => {
      const old = prev.find((s) => s.name === mcpEditOriginalName || s.name === name)
      if (!isNew && old) saved.enabled = old.enabled
      const filtered = prev.filter((s) => s.name !== name && s.name !== mcpEditOriginalName)
      return [...filtered, saved]
    })
    setMcpEditing(null)
  }

  // ── Skills ──
  const openSkillAdd = () => { setSkillEditOriginalName(null); setSkillEditing({ rootId: skillRootId, skillPath: "", name: "", content: "" }) }
  const openSkillEdit = (s: SkillFile) => { setSkillEditOriginalName(s.skillPath); setSkillEditing({ ...s }) }
  const handleSkillDelete = async (skillPath: string) => {
    await window.electronAPI.deleteSkill(skillRootId, skillPath)
    refreshSkillRoots(); refreshSkills()
  }
  const handleSkillSave = async () => {
    if (!skillEditing || !skillEditing.name.trim()) return
    const newPath = skillEditing.name.trim()
    if (skillEditOriginalName && skillEditOriginalName !== newPath) {
      await window.electronAPI.renameSkill(skillRootId, skillEditOriginalName, newPath)
    }
    await window.electronAPI.saveSkill(skillRootId, newPath, skillEditing.content)
    setSkillEditing(null); refreshSkillRoots(); refreshSkills()
  }
  const toggleSkillExpand = (key: string) => {
    setSkillExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }
  const openSkillFile = async (skillPath: string, relativePath: string) => {
    const res = await window.electronAPI.readSkillFile(skillRootId, skillPath, relativePath)
    if (res.ok) setSkillFileEditing({ rootId: skillRootId, skillPath, relativePath, content: res.content ?? "" })
  }
  const handleSkillFileSave = async () => {
    if (!skillFileEditing) return
    await window.electronAPI.saveSkillFile(skillFileEditing.rootId, skillFileEditing.skillPath, skillFileEditing.relativePath, skillFileEditing.content)
    setSkillFileEditing(null); refreshSkills()
  }
  const handleCreateFile = (skillPath: string, parentPath: string) => setSkillPrompt({ rootId: skillRootId, skillPath, parentPath, kind: "file", value: "" })
  const handleCreateFolder = (skillPath: string, parentPath: string) => setSkillPrompt({ rootId: skillRootId, skillPath, parentPath, kind: "folder", value: "" })
  const handleSkillPromptConfirm = async () => {
    if (!skillPrompt || !skillPrompt.value.trim()) return
    const name = skillPrompt.value.trim()
    const { rootId, skillPath, parentPath, kind } = skillPrompt
    if (kind === "file") {
      const rel = parentPath ? `${parentPath}/${name}` : name
      await window.electronAPI.saveSkillFile(rootId, skillPath, rel, "")
      refreshSkills(); setSkillPrompt(null)
      openSkillFile(skillPath, rel)
    } else {
      const rel = parentPath ? `${parentPath}/${name}` : name
      await window.electronAPI.createSkillDir(rootId, skillPath, rel)
      refreshSkills(); setSkillPrompt(null)
    }
  }
  const handleDeleteFile = (skillPath: string, relativePath: string) => setSkillDeleteConfirm({ rootId: skillRootId, skillPath, relativePath })
  const handleDeleteFileConfirm = async () => {
    if (!skillDeleteConfirm) return
    await window.electronAPI.deleteSkillFile(skillDeleteConfirm.rootId, skillDeleteConfirm.skillPath, skillDeleteConfirm.relativePath)
    setSkillDeleteConfirm(null); refreshSkills()
  }

  // ── Tasks ──
  const openTaskAdd = () => {
    setTaskEditing({
      id: crypto.randomUUID(), name: "", cron: "", content: "", enabled: true, independent: true,
      channelId: taskChannels.find((c) => c.enabled)?.id ?? taskChannels[0]?.id,
    })
    setTaskCronValid(true)
    setTaskModelOptions([])
  }
  const openTaskEdit = (t: TaskItem) => { setTaskEditing({ ...t }); setTaskCronValid(true); setTaskModelOptions([]) }
  const handleTaskDelete = async (id: string) => {
    const updated = tasks.filter((t) => t.id !== id)
    await window.electronAPI.saveScheduledTasks(updated); refreshTasks()
  }
  const handleTaskToggle = async (id: string) => {
    const updated = tasks.map((t) => t.id === id ? { ...t, enabled: !t.enabled } : t)
    await window.electronAPI.saveScheduledTasks(updated); refreshTasks()
  }
  const handleTaskTrigger = async (id: string) => {
    await window.electronAPI.triggerScheduledTask(id)
  }
  const handleTaskSave = async () => {
    if (!taskEditing || !taskEditing.name.trim() || !taskEditing.cron.trim()) return
    const valid = await window.electronAPI.validateCron(taskEditing.cron.trim())
    setTaskCronValid(valid)
    if (!valid) return
    const exists = tasks.find((t) => t.id === taskEditing.id)
    const updated = exists ? tasks.map((t) => t.id === taskEditing.id ? taskEditing : t) : [...tasks, taskEditing]
    await window.electronAPI.saveScheduledTasks(updated)
    setTaskEditing(null); refreshTasks()
  }

  const activeGroup = nodeGroups.find((g) => g.id === activeGroupId) ?? nodeGroups[0]

  const persistNodeGroups = async (groups: ProjectNodeGroup[]) => {
    await window.electronAPI.saveProjectNodeGroups(groups.map((g) => ({
      ...g,
      nodes: g.nodes.map(({ defaultPrompt: _d, ...n }) => n),
    })))
    const fresh = await window.electronAPI.getProjectNodeGroups()
    setNodeGroups(fresh)
  }
  const saveActiveGroupNodes = async (nodes: ProjectNodeItem[]) => {
    if (!activeGroup) return
    await persistNodeGroups(nodeGroups.map((g) => g.id === activeGroup.id ? { ...g, nodes } : g))
  }
  const handleGroupExport = async () => {
    if (!activeGroup) return
    const r = await window.electronAPI.exportProjectNodeGroup(activeGroup.id)
    if (r.ok && r.path) void showAlert("导出成功", r.path)
    else if (!r.ok && r.error !== "已取消") void showAlert("导出失败", r.error ?? "未知错误")
  }
  const handleGroupImport = async () => {
    const r = await window.electronAPI.importProjectNodeGroup()
    if (!r.ok) {
      if (r.error !== "已取消") void showAlert("导入失败", r.error ?? "未知错误")
      return
    }
    const fresh = await window.electronAPI.getProjectNodeGroups()
    setNodeGroups(fresh)
    if (r.group) {
      setActiveGroupId(r.group.id)
      void showAlert("导入成功", `已导入为新组「${r.group.name}」(${r.group.id})`)
    }
  }
  const handleGroupDelete = async () => {
    if (!activeGroup) return
    if (nodeGroups.length <= 1) { void showAlert("无法删除", "至少保留 1 个流程组"); return }
    const usage = await window.electronAPI.getProjectNodeGroupUsage().catch(() => ({} as Record<string, number>))
    const count = usage[activeGroup.id] ?? 0
    if (count > 0) { void showAlert("无法删除", `有 ${count} 个项目正在使用该组`); return }
    if (!(await showConfirm("删除流程组", `确定删除「${activeGroup.name}」？组内 ${activeGroup.nodes.length} 个节点将一并删除。`))) return
    const next = nodeGroups.filter((g) => g.id !== activeGroup.id)
    await persistNodeGroups(next)
    setActiveGroupId(next[0]?.id ?? "")
  }
  const handleGroupSave = async () => {
    if (!groupEditing) return
    const id = groupEditing.id.trim()
    const name = groupEditing.name.trim()
    if (!name) return
    if (groupEditing.index < 0) {
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        void showAlert("组 id 不可用", `「${id}」需小写字母开头（可含数字/-）`)
        return
      }
      if (nodeGroups.some((g) => g.id === id)) {
        void showAlert("无法保存", "组 id 与已有组重复")
        return
      }
      await persistNodeGroups([...nodeGroups, { id, name, workspace: "worktree", nodes: [] }])
      setActiveGroupId(id)
    } else {
      await persistNodeGroups(nodeGroups.map((g) => g.id === groupEditing.id ? { ...g, name } : g))
    }
    setGroupEditing(null)
  }

  const handleProjectSwitch = async (id: string) => {
    const r = await window.electronAPI.switchProject(id)
    if (!r.ok) void showAlert("错误", r.error ?? "切换失败")
    refreshProjectList()
  }
  const handleProjectDelete = async (p: ProjectListItem) => {
    if (!(await showConfirm("删除项目", `确定删除「${p.name}」？\n将移除 AI 工作目录（含未提交改动）；主仓与远程分支不受影响。`, "删除", "取消"))) return
    const r = await window.electronAPI.deleteProject(p.id)
    if (!r.ok) void showAlert("错误", r.error ?? "删除失败")
    refreshProjectList()
  }
  const handleProjectSave = async () => {
    if (!projectEditing || !projectEditing.name.trim()) return
    let metadata: Record<string, string> | undefined
    try {
      const parsed = JSON.parse(metadataEditText || "{}") as unknown
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (!k.trim()) continue
          metadata[k] = String(v ?? "")
        }
        if (!Object.keys(metadata).length) metadata = undefined
      } else {
        void showAlert("错误", "metadata 必须是 JSON 对象")
        return
      }
    } catch {
      void showAlert("错误", "metadata JSON 格式无效")
      return
    }
    const r = await window.electronAPI.updateProject({
      id: projectEditing.id,
      name: projectEditing.name.trim(),
      goal: projectEditing.goal?.trim() || "",
      storyUrl: projectEditing.storyUrl?.trim() || "",
      productDocUrl: projectEditing.productDocUrl?.trim() || "",
      techDocUrl: projectEditing.techDocUrl?.trim() || "",
      status: projectEditing.status,
      groupIds: projectEditing.groupIds ?? [],
      metadata,
    })
    if (!r.ok) { void showAlert("错误", r.error ?? "保存失败"); return }
    setProjectEditing(null)
    refreshProjectList()
  }

  const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
  const masterDetailLayout = MASTER_DETAIL_TABS.includes(tab) || tab === "projects"

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <div className="flex flex-1 items-center gap-3">
          <button onClick={onBack} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-800 hover:text-white" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}><ArrowLeft size={18} /></button>
          <h1 className="text-lg font-semibold">设置</h1>
          <div className="flex-1" />
          {saved && <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={14} />已保存</span>}
        </div>
      </TitleBar>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-36 shrink-0 border-r border-gray-800 py-3">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition ${tab === t.id ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}>
              <t.icon size={15} />{t.label}
            </button>
          ))}
        </nav>

        <div className={`flex-1 ${masterDetailLayout ? "flex min-h-0 flex-col overflow-hidden" : "overflow-y-auto px-8 py-6"}`}>
          <div className={masterDetailLayout ? PANEL_FRAME : "mx-auto max-w-xl space-y-6"}>

            {tab === "agent" && <AgentPanel />}
            {tab === "channel" && <ChannelPanel />}
            {tab === "tasks" && <TaskPanel />}
            {tab === "mcp" && <McpPanel />}
            {tab === "rules" && <RulePanel />}
            {tab === "skills" && <SkillPanel />}

            {tab === "projects" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
                  <button type="button"
                    onClick={() => { setProjectsSubTab("list"); refreshProjectList() }}
                    className={`rounded-md border px-3 py-1.5 text-xs transition ${projectsSubTab === "list" ? "border-blue-500 bg-blue-500/10 font-medium text-white" : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
                  >项目列表</button>
                  <button type="button"
                    onClick={() => setProjectsSubTab("settings")}
                    className={`rounded-md border px-3 py-1.5 text-xs transition ${projectsSubTab === "settings" ? "border-blue-500 bg-blue-500/10 font-medium text-white" : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
                  >项目设置</button>
                  <button type="button"
                    onClick={() => setProjectsSubTab("groups")}
                    className={`rounded-md border px-3 py-1.5 text-xs transition ${projectsSubTab === "groups" ? "border-blue-500 bg-blue-500/10 font-medium text-white" : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
                  >流程组</button>
                </div>
                {projectsSubTab === "list" && <ProjectListPanel />}
                {projectsSubTab === "settings" && (
                  <div className="flex-1 overflow-y-auto pb-6">
                    <div className="mx-auto max-w-xl space-y-6">
                      <section className="space-y-4">
                        <h3 className="text-sm font-medium text-gray-300">项目配置</h3>
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">GitLab Token</label>
                          <div className="relative">
                            <input type={showGitlabToken ? "text" : "password"} value={gitlabToken} onChange={(e) => setGitlabToken(e.target.value)} placeholder="glpat-..." className={inputCls + " pr-16"} />
                            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                              <button type="button" title="复制" disabled={!gitlabToken.trim()} onClick={() => void navigator.clipboard.writeText(gitlabToken)} className="text-gray-500 hover:text-gray-300 disabled:opacity-40"><Copy size={13} /></button>
                              <button type="button" title={showGitlabToken ? "隐藏" : "显示"} onClick={() => setShowGitlabToken(!showGitlabToken)} className="text-gray-500 hover:text-gray-300">{showGitlabToken ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                            </div>
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">GitLab Host（可空，默认从 origin 推断）</label>
                          <input type="text" value={gitlabHost} onChange={(e) => setGitlabHost(e.target.value)} placeholder="https://gitlab.com" className={inputCls} />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">主仓（路径须为 git 根目录；基线=生产分支，只作切 feature 起点；测试/开发可空）</label>
                          <div className="space-y-2">
                            {repoProfiles.map((p, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <input type="text" value={p.path} placeholder="D:\repos\foo"
                                  onChange={(e) => setRepoProfiles((list) => list.map((x, j) => j === i ? { ...x, path: e.target.value } : x))}
                                  className={`${inputCls} flex-[3]`} />
                                <input type="text" value={p.baseBranch} placeholder="基线"
                                  onChange={(e) => setRepoProfiles((list) => list.map((x, j) => j === i ? { ...x, baseBranch: e.target.value } : x))}
                                  className={`${inputCls} flex-1`} />
                                <input type="text" value={p.testBranch ?? ""} placeholder="测试"
                                  onChange={(e) => setRepoProfiles((list) => list.map((x, j) => j === i ? { ...x, testBranch: e.target.value || undefined } : x))}
                                  className={`${inputCls} flex-1`} />
                                <input type="text" value={p.developBranch ?? ""} placeholder="开发"
                                  onChange={(e) => setRepoProfiles((list) => list.map((x, j) => j === i ? { ...x, developBranch: e.target.value || undefined } : x))}
                                  className={`${inputCls} flex-1`} />
                                <button type="button" title="删除"
                                  onClick={() => setRepoProfiles((list) => list.filter((_, j) => j !== i))}
                                  className="shrink-0 rounded-md border border-gray-700 px-2 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-red-400"
                                >✕</button>
                              </div>
                            ))}
                            <button
                              type="button"
                              onClick={() => setRepoProfiles((list) => [...list, { path: "", baseBranch: "" }])}
                              className="rounded-md border border-dashed border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800"
                            >+ 添加主仓</button>
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-500">AI 工作目录</label>
                          <div className="flex gap-2">
                            <input type="text" value={worktreeRoot} onChange={(e) => setWorktreeRoot(e.target.value)} placeholder="D:\claw-projects" className={inputCls} />
                            <button
                              type="button"
                              onClick={async () => {
                                const dir = await window.electronAPI.selectDirectory()
                                if (dir) setWorktreeRoot(dir)
                              }}
                              className="shrink-0 rounded-md border border-gray-700 px-3 text-xs text-gray-300 hover:bg-gray-800"
                            >浏览</button>
                          </div>
                        </div>
                      </section>
                    </div>
                  </div>
                )}
                {projectsSubTab === "groups" && (
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-2">
                    <div className="flex-1 overflow-y-auto">
                      <div className="space-y-4">
                        <h3 className="text-sm font-medium text-gray-300">流程组</h3>
                        <p className="text-xs text-gray-500">建项可多选（不选默认「开发」）；推进节点按所选组分组展示；点击节点编辑提示词；拖动左侧把手调整顺序。</p>
                        <div className="rounded-lg border border-gray-800 p-3 space-y-2">
                          <h4 className="text-xs font-medium text-gray-400">共享空间</h4>
                          <div>
                            <label className="mb-1 block text-xs text-gray-500">Hub 地址</label>
                            <input type="text" value={flowHubUrl} onChange={(e) => setFlowHubUrl(e.target.value)}
                              placeholder="https://gitlab.example.com/group/your-flow-hub" className={inputCls} />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-gray-500">Hub Token（Flow Hub 项目专用）</label>
                            <div className="relative">
                              <input type={showFlowHubToken ? "text" : "password"} value={flowHubToken} onChange={(e) => setFlowHubToken(e.target.value)}
                                placeholder="glpat-...（需 Maintainer 及以上权限）" className={inputCls + " pr-16"} />
                              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                                <button type="button" title="复制" disabled={!flowHubToken.trim()} onClick={() => void navigator.clipboard.writeText(flowHubToken)} className="text-gray-500 hover:text-gray-300 disabled:opacity-40"><Copy size={13} /></button>
                                <button type="button" title={showFlowHubToken ? "隐藏" : "显示"} onClick={() => setShowFlowHubToken(!showFlowHubToken)} className="text-gray-500 hover:text-gray-300">{showFlowHubToken ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-gray-500">作者昵称（上传时展示）</label>
                            <input type="text" value={flowHubAuthor} onChange={(e) => setFlowHubAuthor(e.target.value)}
                              placeholder="你的名字" className={inputCls} />
                          </div>
                          <p className="text-[10px] text-gray-600">Hub Token 与上方项目 Token 独立；未填 Hub Token 时回退使用项目 Token。</p>
                          <button
                            type="button"
                            onClick={() => openHubBrowser("group")}
                            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition ${hubConfigured ? "border-blue-600/50 text-blue-400 hover:bg-gray-800" : "border-gray-700 text-gray-500 hover:bg-gray-800 hover:text-gray-300"}`}
                          ><Download className="h-3 w-3" />从共享空间获取组</button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {nodeGroups.map((g) => (
                            <button key={g.id} type="button"
                              onClick={() => setActiveGroupId(g.id)}
                              className={`rounded-md border px-3 py-1.5 text-xs transition ${g.id === activeGroup?.id ? "border-blue-500 bg-blue-500/10 font-medium text-white" : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
                            >{g.name}</button>
                          ))}
                          <button
                            type="button"
                            onClick={() => setGroupEditing({ id: "", name: "", index: -1 })}
                            className="rounded-md border border-dashed border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800"
                          >+ 新增组</button>
                          <button
                            type="button"
                            onClick={() => openHubBrowser("group")}
                            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition ${hubConfigured ? "border-gray-700 text-blue-400 hover:bg-gray-800" : "border-gray-700 text-gray-500 hover:bg-gray-800 hover:text-gray-300"}`}
                          ><Download className="h-3 w-3" />从共享空间获取组</button>
                        </div>
                        {activeGroup && (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-3 text-xs text-gray-500">
                              <span>当前组 <span className="font-mono">{activeGroup.id}</span> · {activeGroup.nodes.length} 个节点</span>
                              <button type="button" className="text-blue-400 hover:text-blue-300"
                                onClick={() => setGroupEditing({ id: activeGroup.id, name: activeGroup.name, index: nodeGroups.findIndex((g) => g.id === activeGroup.id) })}
                              >编辑</button>
                              <button type="button" className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300" onClick={() => void handleGroupExport()}>
                                <Download className="h-3 w-3" />导出
                              </button>
                              <button type="button" className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300" onClick={() => void handleGroupImport()}>
                                <FilePlus className="h-3 w-3" />导入
                              </button>
                              {hubConfigured && (
                                <button type="button" className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                                  onClick={async () => {
                                    const r = await window.electronAPI.flowHub.uploadGroup(activeGroup.id)
                                    if (r.ok) { void showAlert("上传成功", `流程组「${activeGroup.name}」已上传到共享空间`); void refreshNodeGroups() }
                                    else void showAlert("上传失败", r.error ?? "未知错误")
                                  }}>
                                  <Upload className="h-3 w-3" />上传
                                </button>
                              )}
                              {nodeGroups.length > 1 && (
                                <button type="button" className="text-red-400 hover:text-red-300" onClick={handleGroupDelete}>删除组</button>
                              )}
                            </div>
                            <ProjectNodePanel
                              nodes={activeGroup.nodes}
                              onSaveNodes={saveActiveGroupNodes}
                              hubConfigured={hubConfigured}
                              groupId={activeGroup.id}
                              onUploadNode={hubConfigured ? async (nodeId) => {
                                const r = await window.electronAPI.flowHub.uploadNode(activeGroup.id, nodeId)
                                if (r.ok) void showAlert("上传成功", `节点已上传`)
                                else void showAlert("上传失败", r.error ?? "未知错误")
                              } : undefined}
                            />
                            {hubUrlReady && (
                              <button
                                type="button"
                                onClick={() => openHubBrowser("node")}
                                className={`w-full rounded-md border border-dashed px-3 py-2 text-xs transition ${hubConfigured ? "border-gray-700 text-blue-400 hover:bg-gray-800" : "border-gray-700 text-gray-500 hover:bg-gray-800 hover:text-gray-300"}`}
                              >从共享空间获取节点</button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!masterDetailLayout && (<>

            {/* channel / tasks / mcp / rules / skills → Panel 组件 */}

            {/* ═══ General ═══ */}
            {tab === "general" && (<>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">启动</h3>
                <div className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-medium">开机自启</p>
                    <p className="text-xs text-gray-500">系统登录后自动启动 LK Harness；应用启动后自动拉起 Daemon 并连接消息通道</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoLaunch}
                    onClick={handleAutoLaunchToggle}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${autoLaunch ? "bg-green-500" : "bg-gray-600"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${autoLaunch ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </button>
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">关闭主窗口</h3>
                <p className="text-xs text-gray-600">点击窗口右上角关闭时的行为（可从系统托盘再次打开窗口）。</p>
                <div className="space-y-2">
                  {([
                    { v: "ask" as const, t: "每次询问", d: "弹窗选择最小化到托盘或退出应用" },
                    { v: "minimize" as const, t: "总是最小化到托盘", d: "直接隐藏窗口，不弹窗" },
                    { v: "quit" as const, t: "总是退出应用", d: "关闭窗口并退出（含 Daemon、托盘）" },
                  ]).map((opt) => (
                    <label
                      key={opt.v}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${closeWindowAction === opt.v ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-600"}`}
                    >
                      <input
                        type="radio"
                        name="closeWindowAction"
                        checked={closeWindowAction === opt.v}
                        onChange={() => setCloseWindowAction(opt.v)}
                        className="mt-1 rounded-full border-gray-600"
                      />
                      <div>
                        <p className="text-sm font-medium">{opt.t}</p>
                        <p className="text-xs text-gray-500">{opt.d}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">配置迁移</h3>
                <ConfigMigratePanel
                  showAlert={showAlert}
                  showConfirm={showConfirm}
                  onMigrateSuccess={() => {
                    window.electronAPI.getConfig().then((config) => {
                      setAutoLaunch(!!config.autoStart)
                      setCloseWindowAction(config.closeWindowAction ?? "ask")
                    })
                  }}
                />
              </section>
              <p className="text-xs text-gray-500">关闭窗口相关选项保存后立即生效。其余设置自动保存，部分项需重启 Daemon 后生效。</p>
            </>)}

            {/* ═══ Proxy ═══ */}
            {tab === "proxy" && (<>
              <section className="space-y-4">
                <h3 className="text-sm font-medium text-gray-300">代理设置</h3>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">HTTP / HTTPS 代理</label>
                  <input type="text" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://127.0.0.1:1080" className={inputCls} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">NO_PROXY</label>
                  <input type="text" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} placeholder="localhost,127.0.0.1,feishu.cn" className={inputCls} />
                </div>
              </section>
            </>)}

            {/* ═══ MCP ═══ */}
            {tab === "mcp" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">MCP 服务器</h3>
                  <button onClick={() => refreshMcpServers(true)} disabled={mcpRefreshing} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-50"><RefreshCw size={12} className={mcpRefreshing ? "animate-spin" : ""} />{mcpRefreshing ? "加载中" : "刷新"}</button>
                  <div className="flex-1" />
                  <button onClick={openMcpAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <div className="space-y-2">
                  {mcpServers.map((s) => {
                    const expanded = mcpExpanded === s.name
                    const toolState = mcpTools[s.name]
                    const rawStatus = mcpStatus[s.name]
                    const isReady = rawStatus === "ready" || rawStatus === "enabled"
                    const statusColor = !rawStatus ? "text-gray-600" : isReady ? "text-green-400" : rawStatus === "disabled" || rawStatus.includes("not loaded") ? "text-gray-500" : "text-red-400"
                    const statusLabel = !rawStatus ? "—" : isReady ? "ready" : rawStatus === "disabled" ? "disabled" : rawStatus.includes("not loaded") ? "not loaded" : rawStatus
                    return (
                    <div key={s.name} className="rounded-lg border border-gray-700 overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <button onClick={() => toggleMcpExpand(s.name)} className="shrink-0 rounded p-0.5 text-gray-500 transition hover:text-white">
                            <ChevronDown size={14} className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
                          </button>
                          {s.type === "url" ? (s.enabled && s.authenticated ? <ShieldCheck size={16} className="shrink-0 text-green-400" /> : s.enabled && !s.authenticated ? <ShieldAlert size={16} className="shrink-0 text-amber-400" /> : <Network size={16} className="shrink-0 text-gray-400" />) : <Terminal size={16} className="shrink-0 text-gray-400" />}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">{s.name}</p>
                              <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">Claw</span>
                              {!mcpStatusLoading && <span className={`shrink-0 text-[10px] ${statusColor}`}>{statusLabel}</span>}
                              {toolState && !toolState.loading && toolState.tools.length > 0 && <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">{toolState.tools.length} tools</span>}
                            </div>
                            <p className="truncate text-xs text-gray-500">{s.type === "url" ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`}</p>
                          </div>
                        </div>
                        <div className="ml-3 flex shrink-0 items-center gap-2">
                          {s.type === "url" && s.enabled && (s.authenticated ? <span className="text-xs text-green-400">已认证</span> : mcpLoginPending[s.name] ? <button onClick={() => handleMcpLogin(s.name)} className="flex items-center gap-1 rounded-md bg-blue-600/70 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Loader2 size={12} className="animate-spin" />认证中</button> : <button onClick={() => handleMcpLogin(s.name)} className="flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-500" title="仅当该 MCP 使用浏览器 OAuth 时需要"><LogIn size={12} />授权</button>)}
                          <button onClick={() => openMcpEdit(s)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                          <button onClick={() => handleMcpDelete(s.name)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                          {(mcpStatusLoading && s.enabled === undefined) || mcpLoading[s.name] ? (
                            <div className="inline-flex h-5 w-9 shrink-0 items-center justify-center rounded-full bg-gray-700">
                              <Loader2 size={12} className="animate-spin text-gray-400" />
                            </div>
                          ) : (
                            <button
                              onClick={() => handleMcpToggle(s.name, !s.enabled)}
                              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${s.enabled ? "bg-green-500" : "bg-gray-600"}`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${s.enabled ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                            </button>
                          )}
                        </div>
                      </div>
                      {expanded && (
                        <div className="border-t border-gray-700/50 bg-gray-900/30 px-4 py-2.5">
                          {toolState?.loading ? (
                            <div className="flex items-center gap-2 py-1 text-xs text-gray-500"><Loader2 size={12} className="animate-spin" />正在获取工具列表…</div>
                          ) : toolState?.error ? (
                            <p className="py-1 text-xs text-gray-500">{toolState.error}</p>
                          ) : toolState && toolState.tools.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {toolState.tools.map((t) => {
                                const tip = [t.description, ...(t.params ?? []).map((p) => `${p.required ? "* " : ""}${p.name}${p.type ? `: ${p.type}` : ""}${p.description ? ` — ${p.description}` : ""}`)].filter(Boolean).join("\n") || t.name
                                return (
                                  <span key={t.name} className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300" title={tip}>
                                    <Wrench size={10} className="shrink-0 text-gray-500" />{t.name}
                                  </span>
                                )
                              })}
                            </div>
                          ) : (
                            <p className="py-1 text-xs text-gray-500">无已注册工具</p>
                          )}
                        </div>
                      )}
                    </div>
                  )})}
                  {mcpServers.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无 MCP 服务器配置</p>}
                </div>
              </section>
            </>)}

            {/* ═══ Tasks ═══ */}
            {tab === "tasks" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">定时任务</h3>
                  <button onClick={refreshTasks} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
                  <div className="flex-1" />
                  <button onClick={openTaskAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <div className="space-y-2">
                  {tasks.map((t) => {
                    const status = taskStatuses[t.id]
                    const isRunning = !!status?.running
                    return (
                    <div key={t.id} className={`flex items-center justify-between rounded-lg border px-4 py-3 ${isRunning ? "border-green-700/50 bg-green-950/20" : "border-gray-700"}`}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`truncate text-sm font-medium ${t.enabled ? "" : "text-gray-600 line-through"}`}>{t.name}</p>
                          <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">{t.cron}</span>
                          {t.channelId && <span className="shrink-0 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">{taskChannels.find((c) => c.id === t.channelId)?.name ?? "通道已删除"}</span>}
                          {t.model && <span className="shrink-0 rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] text-purple-400">{modelSlug(t.model, t.modelParams)}</span>}
                          {t.independent !== false && <span className="shrink-0 rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] text-indigo-400">独立</span>}
                          {t.notifyChatId && <span className="shrink-0 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-400/90" title={t.notifyChatId}>通知群</span>}
                          {isRunning && <span className="inline-flex items-center gap-1 shrink-0 rounded bg-green-900/40 px-1.5 py-0.5 text-[10px] text-green-400"><span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />运行中</span>}
                        </div>
                        <p className="truncate text-xs text-gray-500">{t.content.slice(0, 80)}{t.content.length > 80 ? "..." : ""}</p>
                      </div>
                      <div className="ml-3 flex shrink-0 items-center gap-2">
                        <button onClick={() => handleTaskTrigger(t.id)} title="立即执行" className="rounded p-1 text-gray-500 transition hover:bg-blue-600/20 hover:text-blue-400"><Play size={13} /></button>
                        <button onClick={() => handleTaskToggle(t.id)} className={`rounded px-2 py-0.5 text-xs transition ${t.enabled ? "text-green-400 hover:bg-green-600/20" : "text-gray-500 hover:bg-gray-800"}`}>
                          {t.enabled ? "启用" : "禁用"}
                        </button>
                        <button onClick={() => openTaskEdit(t)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                        <button onClick={() => handleTaskDelete(t.id)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                      </div>
                    </div>
                    )
                  })}
                  {tasks.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无定时任务</p>}
                </div>
              </section>
            </>)}

            {/* ═══ Skills ═══ */}
            {tab === "skills" && (<>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-gray-300">Agent Skills</h3>
                  <button onClick={() => { refreshSkillRoots(); refreshSkills() }} className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"><RefreshCw size={12} />刷新</button>
                  <div className="flex-1" />
                  <button onClick={openSkillAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />新增</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {skillRoots.map((root) => (
                    <button
                      key={root.id}
                      type="button"
                      onClick={() => { setSkillRootId(root.id); setSkillExpanded(new Set()) }}
                      className={`rounded-md border px-2.5 py-1 text-xs transition ${skillRootId === root.id ? "border-blue-500 bg-blue-500/10 font-medium text-white" : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-200"}`}
                    >
                      {root.label} ({root.skillCount})
                    </button>
                  ))}
                </div>
                <div className="space-y-1">
                  {skillTree.map((skill) => {
                    const skillKey = `${skillRootId}:${skill.name}`
                    const isExpanded = skillExpanded.has(skillKey)
                    const renderNode = (node: SkillTreeNode, parentPath: string, depth: number): React.ReactNode => {
                      const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name
                      const nodeKey = `${skillKey}/${fullPath}`
                      if (node.type === "directory") {
                        const dirExpanded = skillExpanded.has(nodeKey)
                        return (
                          <div key={nodeKey}>
                            <div className="group flex items-center" style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}>
                              <button
                                onClick={() => toggleSkillExpand(nodeKey)}
                                className="flex flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-xs text-gray-400 transition hover:bg-gray-800/50 hover:text-gray-200"
                              >
                                {dirExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <Folder size={12} className="text-blue-400/70" />
                                <span>{node.name}</span>
                              </button>
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                                <button onClick={() => handleCreateFile(skill.name, fullPath)} className="rounded p-0.5 text-gray-600 hover:text-gray-300" title="新建文件"><FilePlus size={12} /></button>
                                <button onClick={() => handleCreateFolder(skill.name, fullPath)} className="rounded p-0.5 text-gray-600 hover:text-gray-300" title="新建文件夹"><FolderPlus size={12} /></button>
                                <button onClick={() => handleDeleteFile(skill.name, fullPath)} className="rounded p-0.5 text-gray-600 hover:text-red-400" title="删除文件夹"><Trash2 size={12} /></button>
                              </div>
                            </div>
                            {dirExpanded && node.children?.map((child) => renderNode(child, fullPath, depth + 1))}
                          </div>
                        )
                      }
                      return (
                        <div key={nodeKey} className="group flex items-center" style={{ paddingLeft: `${(depth + 1) * 16 + 20}px` }}>
                          <button
                            onClick={() => openSkillFile(skill.name, fullPath)}
                            className="flex flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-xs text-gray-500 transition hover:bg-gray-800/50 hover:text-gray-200"
                          >
                            <File size={11} className="shrink-0 text-gray-600" />
                            <span className="truncate">{node.name}</span>
                          </button>
                          <button onClick={() => handleDeleteFile(skill.name, fullPath)} className="shrink-0 rounded p-0.5 text-gray-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100" title="删除文件"><Trash2 size={12} /></button>
                        </div>
                      )
                    }
                    return (
                      <div key={skillKey} className="rounded-lg border border-gray-700 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2.5">
                          <button onClick={() => toggleSkillExpand(skillKey)} className="flex items-center gap-2 min-w-0">
                            {isExpanded ? <ChevronDown size={14} className="shrink-0 text-gray-500" /> : <ChevronRight size={14} className="shrink-0 text-gray-500" />}
                            <Sparkles size={14} className="shrink-0 text-amber-400/70" />
                            <span className="truncate text-sm font-medium">{skill.name}</span>
                          </button>
                          <div className="ml-3 flex shrink-0 items-center gap-1">
                            <button onClick={() => handleCreateFile(skill.name, "")} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white" title="新建文件"><FilePlus size={13} /></button>
                            <button onClick={() => handleCreateFolder(skill.name, "")} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white" title="新建文件夹"><FolderPlus size={13} /></button>
                            <button onClick={() => { const s = skills.find((x) => x.skillPath === skill.name); if (s) openSkillEdit(s) }} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white" title="编辑 SKILL.md"><Pencil size={13} /></button>
                            <button onClick={() => handleSkillDelete(skill.name)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400" title="删除整个 Skill"><Trash2 size={13} /></button>
                          </div>
                        </div>
                        {isExpanded && skill.children && skill.children.length > 0 && (
                          <div className="border-t border-gray-700/50 bg-gray-900/30 px-1 py-1.5">
                            {skill.children.map((child) => renderNode(child, "", 0))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {skillTree.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无 Skill</p>}
                </div>
              </section>
            </>)}

            {/* ═══ Toolbox ═══ */}
            {tab === "toolbox" && <ToolboxPanel />}

            {/* ═══ Setup Guide ═══ */}
            {tab === "setup" && (<>
              <section className="space-y-4">
                <h3 className="text-sm font-medium text-gray-300">新手引导</h3>
                <div className="rounded-lg border border-gray-700 p-4 space-y-3">
                  <p className="text-sm text-gray-400">从头走一遍五步引导：选工作目录 → 接入 AI → 连上飞书 → 绑定自己 → 装工具。已有配置会自动带入，不会被清空。</p>
                  <button
                    onClick={() => onReenterWizard?.()}
                    className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
                  >
                    <BookOpen size={15} />重新进入引导
                  </button>
                  <p className="text-xs text-gray-600">以下为飞书手动建应用时需要的权限与事件配置参考。</p>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-300">应用权限</h3>
                  <div className="flex items-center gap-2">
                    {firstFeishuAppId.trim() && (
                      <a href={`https://open.feishu.cn/app/${firstFeishuAppId.trim()}/auth`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-blue-400">
                        <ExternalLink size={12} />前往设置权限
                      </a>
                    )}
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(FEISHU_SCOPES_JSON)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white"
                    >
                      <Copy size={12} />复制权限 JSON
                    </button>
                  </div>
                </div>
                <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                  {REQUIRED_FEISHU_SCOPES.map((p) => (
                    <div key={p.scope} className="flex items-center justify-between px-3 py-2">
                      <code className="text-xs text-blue-400">{p.scope}</code>
                      <span className="text-xs text-gray-500">{p.desc}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-300">事件订阅</h3>
                  {firstFeishuAppId.trim() && (
                    <a href={`https://open.feishu.cn/app/${firstFeishuAppId.trim()}/event`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-blue-400">
                      <ExternalLink size={12} />前往设置事件订阅
                    </a>
                  )}
                </div>
                <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                  {FEISHU_EVENT_SUBSCRIPTIONS.map((e) => (
                    <div key={e.event} className="px-3 py-2 flex items-center justify-between">
                      <code className="text-xs text-blue-400">{e.event}</code>
                      <span className="text-xs text-gray-500">{e.desc}</span>
                    </div>
                  ))}
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-gray-300">读取用户发给机器人的单聊消息</span>
                    <span className="text-xs text-emerald-400">需开通</span>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-gray-300">获取群组中用户@机器人消息</span>
                    <span className="text-xs text-emerald-400">需开通</span>
                  </div>
                  <div className="px-3 py-2 text-xs text-gray-500 space-y-1">
                    <div>订阅方式：<span className="text-gray-300">应用身份</span></div>
                    <div>回调类型：<span className="text-gray-300">长连接（WebSocket）</span></div>
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-300">回调订阅</h3>
                  {firstFeishuAppId.trim() && (
                    <a href={`https://open.feishu.cn/app/${firstFeishuAppId.trim()}/event?tab=callback`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-blue-400">
                      <ExternalLink size={12} />前往设置回调订阅
                    </a>
                  )}
                </div>
                <div className="rounded-lg border border-gray-800 divide-y divide-gray-800">
                  <div className="px-3 py-2 flex items-center justify-between">
                    <code className="text-xs text-blue-400">card.action.trigger</code>
                    <span className="text-xs text-gray-500">卡片回传交互</span>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-gray-300">用户点击卡片按钮（选项 / 指令）时回调</span>
                    <span className="text-xs text-emerald-400">需订阅</span>
                  </div>
                  <div className="px-3 py-2 text-xs text-gray-500 space-y-1">
                    <div>订阅方式：<span className="text-gray-300">应用身份</span></div>
                    <div>回调类型：<span className="text-gray-300">长连接（WebSocket）</span></div>
                    <div className="text-gray-600">不订阅时按钮点击无响应，send_question / 指令按钮不可用</div>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">参考文档</h3>
                <div className="flex flex-wrap gap-2">
                  <a href="https://github.com/lk-eternal/lk-harness" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-blue-400">
                    <ExternalLink size={12} />项目 GitHub
                  </a>
                </div>
              </section>
            </>)}

            {tab === "about" && (<>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">应用更新</h3>
                <div className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-medium">启动时自动提示升级</p>
                    <p className="text-xs text-gray-500">关闭后不再弹窗打扰；仍可在下方手动「检查更新」</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoUpgradePrompt}
                    onClick={() => void handleAutoUpgradePromptToggle()}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${autoUpgradePrompt ? "bg-green-500" : "bg-gray-600"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${autoUpgradePrompt ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </button>
                </div>
                <p className="text-xs text-gray-600">
                  当前 <span className="font-mono text-gray-400">v{appVersion || "…"}</span>
                  ，可检查是否有新版本。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={updateBusy || updateDownloading}
                    onClick={() => void handleCheckUpdate()}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-600 bg-gray-800/50 px-4 py-2 text-sm transition hover:border-blue-500 hover:bg-gray-800 disabled:opacity-50"
                  >
                    {updateBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    检查更新
                  </button>
                  {updateCheck?.status === "available" && (
                    <button
                      type="button"
                      disabled={updateBusy || updateDownloading}
                      onClick={() => void handleApplyUpdate()}
                      className="inline-flex items-center gap-2 rounded-lg border border-blue-500 bg-blue-500/15 px-4 py-2 text-sm text-blue-200 transition hover:bg-blue-500/25 disabled:opacity-50"
                    >
                      立即更新
                    </button>
                  )}
                  {updateCheck?.status === "ready" && (
                    <button
                      type="button"
                      disabled={updateBusy}
                      onClick={() => void handleApplyUpdate()}
                      className="inline-flex items-center gap-2 rounded-lg border border-green-500 bg-green-500/15 px-4 py-2 text-sm text-green-200 transition hover:bg-green-500/25 disabled:opacity-50"
                    >
                      立即安装
                    </button>
                  )}
                </div>
                {(updateCheck?.status === "available" || updateCheck?.status === "ready") && updateCheck.releaseNotes && (
                  <div className="rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2">
                    <p className="mb-1.5 text-xs font-medium text-gray-300">更新内容</p>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-400">{updateCheck.releaseNotes}</p>
                  </div>
                )}
                {updateMsg && (
                  <div className="space-y-2">
                    <p className="whitespace-pre-wrap rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2 text-xs text-gray-400">{updateMsg}</p>
                    {updateDownloading && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                          style={{ width: updateDownloadPct === null ? "0%" : `${updateDownloadPct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">项目信息</h3>
                <a
                  href="https://github.com/lk-eternal/lk-harness"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-600 bg-gray-800/50 px-4 py-2 text-sm text-gray-300 transition hover:border-blue-500 hover:bg-gray-800 hover:text-blue-400"
                >
                  <Github size={16} />
                  GitHub 仓库
                  <ExternalLink size={12} className="text-gray-500" />
                </a>
              </section>
            </>)}

            </>)}

          </div>
        </div>
      </div>

      {/* ═══ MCP Edit Modal ═══ */}
      {mcpEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{mcpEditOriginalName ? "编辑 MCP" : "新增 MCP"}</h3>
              <button onClick={() => setMcpEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div>
                <label className="mb-1 block text-xs text-gray-500">配置 JSON</label>
                <textarea
                  value={mcpEditing.json}
                  onChange={(e) => setMcpEditing({ ...mcpEditing, json: e.target.value, jsonError: undefined })}
                  rows={14}
                  spellCheck={false}
                  className={inputCls + " font-mono text-xs leading-relaxed" + (mcpEditing.jsonError ? " border-red-500" : "")}
                  placeholder={MCP_TEMPLATE}
                />
                {mcpEditing.jsonError && <p className="mt-1 text-xs text-red-400">{mcpEditing.jsonError}</p>}
                <p className="mt-1 text-xs text-gray-600">格式: {"{"} "名称": {"{"} "command"|"url": ... {"}"} {"}"}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setMcpEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleMcpSave} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Project Node Edit Modal ═══ */}
      {nodeEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{nodeEditing.index < 0 ? "添加节点" : `编辑节点 · ${nodeEditing.label || nodeEditing.id}`}</h3>
              <button onClick={() => setNodeEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div className="flex gap-3">
                <div className="flex-1"><label className="mb-1 block text-xs text-gray-500">节点 id（/p 命令）</label>
                  <input type="text" value={nodeEditing.id}
                    onChange={(e) => setNodeEditing({ ...nodeEditing, id: e.target.value.trim() })}
                    className={inputCls} placeholder="如 test-report" /></div>
                <div className="flex-1"><label className="mb-1 block text-xs text-gray-500">按钮名称</label>
                  <input type="text" value={nodeEditing.label}
                    onChange={(e) => setNodeEditing({ ...nodeEditing, label: e.target.value })}
                    className={inputCls} placeholder="如 测试报告" /></div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs text-gray-500">节点提示词（告诉 AI 该节点做什么、产出标准）</label>
                  {(nodeEditing.defaultPrompt ?? "").trim() !== "" && (nodeEditing.prompt ?? "").trim() !== "" && (
                    <button type="button" className="text-xs text-blue-400 hover:text-blue-300"
                      onClick={() => setNodeEditing({ ...nodeEditing, prompt: undefined })}
                    >恢复默认模板</button>
                  )}
                </div>
                <textarea rows={12}
                  value={nodeEditing.prompt ?? nodeEditing.defaultPrompt ?? ""}
                  onChange={(e) => setNodeEditing({ ...nodeEditing, prompt: e.target.value })}
                  className={inputCls + " font-mono text-xs leading-relaxed"}
                  placeholder="每行一条要求，会原样进入节点任务提示词" />
                {(nodeEditing.defaultPrompt ?? "").trim() !== "" && (nodeEditing.prompt ?? "").trim() === "" && (
                  <p className="mt-1 text-[10px] text-gray-500">当前使用内置默认模板（上方内容即模板全文，编辑即覆盖）</p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-gray-800 px-6 py-4">
              <div>
                {nodeEditing.index >= 0 && hubConfigured && activeGroup && (
                  <button
                    type="button"
                    className="mr-2 inline-flex items-center gap-1 rounded-md px-4 py-1.5 text-xs text-blue-400 transition hover:bg-gray-800"
                    onClick={async () => {
                      const r = await window.electronAPI.flowHub.uploadNode(activeGroup.id, nodeEditing.id)
                      if (r.ok) void showAlert("上传成功", `节点「${nodeEditing.label}」已上传`)
                      else void showAlert("上传失败", r.error ?? "未知错误")
                    }}
                  ><Upload className="h-3 w-3" />上传此节点</button>
                )}
                {nodeEditing.index >= 0 && (
                  <button
                    onClick={async () => {
                      if (!activeGroup) return
                      if (!(await showConfirm("删除节点", `确定删除「${nodeEditing.label || nodeEditing.id}」？`))) return
                      await saveActiveGroupNodes(activeGroup.nodes.filter((_, j) => j !== nodeEditing.index))
                      setNodeEditing(null)
                    }}
                    className="rounded-md px-4 py-1.5 text-xs text-red-400 transition hover:bg-gray-800"
                  >删除节点</button>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setNodeEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
                <button
                  disabled={!nodeEditing.id.trim() || !nodeEditing.label.trim()}
                  onClick={async () => {
                    if (!activeGroup) return
                    const reserved = ["help", "menu", "ls", "list", "use", "leave", "info", "new", "del", "delete", "rm", "setup", "sync", "ship"]
                    const id = nodeEditing.id.trim()
                    if (reserved.includes(id) || !/^[a-z][a-z0-9-]*$/.test(id)) {
                      void showAlert("节点 id 不可用", `「${id}」需小写字母开头（可含数字/-），且不能与保留命令冲突`)
                      return
                    }
                    if (activeGroup.nodes.some((n, j) => n.id === id && j !== nodeEditing.index)) {
                      void showAlert("无法保存", "节点 id 与组内已有节点重复")
                      return
                    }
                    // 与默认模板一致的内容不落库（保持跟随模板升级）
                    const raw = (nodeEditing.prompt ?? "").trim()
                    const promptVal = raw && raw !== (nodeEditing.defaultPrompt ?? "").trim() ? raw : undefined
                    const item: ProjectNodeItem = { id, label: nodeEditing.label.trim(), prompt: promptVal }
                    const nodes: ProjectNodeItem[] = nodeEditing.index < 0
                      ? [...activeGroup.nodes, item]
                      : activeGroup.nodes.map((n, j) => j === nodeEditing.index ? { ...n, ...item } : n)
                    await saveActiveGroupNodes(nodes)
                    setNodeEditing(null)
                  }}
                  className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
                >保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Project Edit → ProjectListPanel */}

      {/* ═══ Node Group Edit Modal ═══ */}
      {groupEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-sm flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{groupEditing.index < 0 ? "新增流程组" : "编辑流程组"}</h3>
              <button onClick={() => setGroupEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="space-y-3 px-6 py-4">
              <div><label className="mb-1 block text-xs text-gray-500">组 id</label>
                <input type="text" value={groupEditing.id} disabled={groupEditing.index >= 0}
                  onChange={(e) => setGroupEditing({ ...groupEditing, id: e.target.value.trim() })}
                  className={`${inputCls} ${groupEditing.index >= 0 ? "opacity-60" : ""}`} placeholder="如 design" /></div>
              <div><label className="mb-1 block text-xs text-gray-500">组名</label>
                <input type="text" value={groupEditing.name}
                  onChange={(e) => setGroupEditing({ ...groupEditing, name: e.target.value })}
                  className={inputCls} placeholder="如 设计" /></div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setGroupEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleGroupSave} disabled={!groupEditing.id.trim() || !groupEditing.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Skill Edit Modal ═══ */}
      {skillEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{skillEditOriginalName ? "编辑 Skill" : "新增 Skill"}</h3>
              <button onClick={() => setSkillEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div><label className="mb-1 block text-xs text-gray-500">路径（相对根目录）</label><input type="text" value={skillEditing.name} onChange={(e) => setSkillEditing({ ...skillEditing, name: e.target.value })} className={inputCls} placeholder="my-skill 或 group/my-skill" /></div>
              <div><label className="mb-1 block text-xs text-gray-500">SKILL.md 内容</label><textarea value={skillEditing.content} onChange={(e) => setSkillEditing({ ...skillEditing, content: e.target.value })} rows={16} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="# My Skill\n\nDescription of what this skill does..." /></div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setSkillEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleSkillSave} disabled={!skillEditing.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Skill File Edit Modal ═══ */}
      {skillFileEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-2xl flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "85vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-200">编辑文件</h3>
                <p className="truncate text-xs text-gray-500 mt-0.5">{skillFileEditing.skillPath}/{skillFileEditing.relativePath}</p>
              </div>
              <button onClick={() => setSkillFileEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <textarea
                value={skillFileEditing.content}
                onChange={(e) => setSkillFileEditing({ ...skillFileEditing, content: e.target.value })}
                rows={24}
                spellCheck={false}
                className={inputCls + " font-mono text-xs leading-relaxed"}
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setSkillFileEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleSkillFileSave} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Skill Create Prompt ═══ */}
      {skillPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-xs rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="border-b border-gray-800 px-5 py-3">
              <h3 className="text-sm font-semibold text-gray-200">新建{skillPrompt.kind === "file" ? "文件" : "文件夹"}</h3>
            </div>
            <div className="px-5 py-4">
              <input
                autoFocus
                type="text"
                value={skillPrompt.value}
                onChange={(e) => setSkillPrompt({ ...skillPrompt, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSkillPromptConfirm() }}
                placeholder={skillPrompt.kind === "file" ? "例如 utils.py" : "例如 scripts"}
                className={inputCls}
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-3">
              <button onClick={() => setSkillPrompt(null)} className="rounded-md px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={() => void handleSkillPromptConfirm()} disabled={!skillPrompt.value.trim()} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Skill Delete Confirm ═══ */}
      {skillDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-xs rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="px-5 py-4">
              <p className="text-sm text-gray-300">确定删除 <code className="text-red-300">{skillDeleteConfirm.relativePath}</code> ？</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-3">
              <button onClick={() => setSkillDeleteConfirm(null)} className="rounded-md px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={() => void handleDeleteFileConfirm()} className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500">删除</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Task Edit Modal ═══ */}
      {taskEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{tasks.find((t) => t.id === taskEditing.id) ? "编辑定时任务" : "新增定时任务"}</h3>
              <button onClick={() => setTaskEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div><label className="mb-1 block text-xs text-gray-500">任务名称</label><input type="text" value={taskEditing.name} onChange={(e) => setTaskEditing({ ...taskEditing, name: e.target.value })} className={inputCls} placeholder="日报推送" /></div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Cron 表达式</label>
                <input type="text" value={taskEditing.cron} onChange={(e) => { setTaskEditing({ ...taskEditing, cron: e.target.value }); setTaskCronValid(true) }} className={inputCls + (!taskCronValid ? " border-red-500" : "")} placeholder="0 9 * * 1-5" />
                {!taskCronValid && <p className="mt-1 text-xs text-red-400">Cron 表达式无效</p>}
                <p className="mt-1 text-xs text-gray-600">
                  五段：分 时 日 月 周（如 0 9 * * 1-5 = 工作日 9:00）。六段时在前面加「秒」：秒 分 时 日 月 周。
                  每 5 秒请用 <code className="rounded bg-gray-800 px-1">*/5 * * * * *</code>，勿用 <code className="rounded bg-gray-800 px-1">0/5</code>（在 node-cron 里会变成每分钟一次）。
                </p>
                <div className="mt-2 rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-gray-500">最近 5 次触发（本地时间）</p>
                    {cronPreviewLoading && cronPreviewRuns && cronPreviewRuns.length > 0 && (
                      <span className="flex items-center gap-1 text-[11px] text-gray-500">
                        <Loader2 size={11} className="animate-spin shrink-0" />
                        更新中…
                      </span>
                    )}
                  </div>
                  {cronPreviewLoading && (!cronPreviewRuns || cronPreviewRuns.length === 0) && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                      <Loader2 size={12} className="animate-spin" />计算中…
                    </p>
                  )}
                  {!cronPreviewLoading && cronPreviewErr && (
                    <p className="mt-1 text-xs text-amber-400/90">{cronPreviewErr}</p>
                  )}
                  {cronPreviewRuns && cronPreviewRuns.length > 0 && (
                    <ol className={`mt-1.5 list-decimal space-y-0.5 pl-4 font-mono text-[11px] leading-relaxed text-gray-400 ${cronPreviewLoading ? "opacity-70" : ""}`}>
                      {cronPreviewRuns.map((line, i) => (
                        <li key={`${line}-${i}`}>{line}</li>
                      ))}
                    </ol>
                  )}
                  <p className="mt-1.5 text-[10px] text-gray-600">由解析库推算，与 node-cron 在少数写法上可能略有差异，以实际日志为准。</p>
                </div>
              </div>
              <div><label className="mb-1 block text-xs text-gray-500">消息内容</label><textarea value={taskEditing.content} onChange={(e) => setTaskEditing({ ...taskEditing, content: e.target.value })} rows={6} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="要发送给 Agent 的消息..." /></div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-gray-500">消息通道</label>
                  <select
                    value={taskEditing.channelId ?? ""}
                    onChange={(e) => { setTaskEditing({ ...taskEditing, channelId: e.target.value || undefined }); setTaskModelOptions([]) }}
                    className={inputCls}
                  >
                    <option value="">默认（第一个可用通道）</option>
                    {taskChannels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? "" : "（已停用）"}</option>)}
                  </select>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <label className="block text-xs text-gray-500">模型</label>
                    <button onClick={() => void fetchTaskModels(taskEditing.channelId)} disabled={loadingTaskModels} className="flex items-center gap-1 rounded px-1.5 py-0 text-[10px] text-gray-500 transition hover:bg-gray-800 hover:text-white disabled:opacity-50">
                      {loadingTaskModels ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}{loadingTaskModels ? "加载中" : "刷新"}
                    </button>
                  </div>
                  {taskModelOptions.length > 0
                    ? <SearchableSelect
                        value={taskEditing.model ? taskEditing.model + (taskEditing.modelParams ? "\0" + taskEditing.modelParams : "") : ""}
                        onChange={(key) => {
                          if (!key) { setTaskEditing({ ...taskEditing, model: undefined, modelParams: undefined }); return }
                          const sep = key.indexOf("\0")
                          setTaskEditing(sep >= 0
                            ? { ...taskEditing, model: key.slice(0, sep), modelParams: key.slice(sep + 1) }
                            : { ...taskEditing, model: key, modelParams: undefined })
                        }}
                        options={[{ id: "", label: "跟随通道主模型" }, ...taskModelOptions.map((o) => ({ id: o.id + (o.params ? "\0" + o.params : ""), label: o.label }))]}
                        placeholder="跟随通道主模型"
                        fallbackLabel={modelSlug(taskEditing.model, taskEditing.modelParams)}
                      />
                    : <input type="text" value={modelSlug(taskEditing.model, taskEditing.modelParams)} onChange={(e) => setTaskEditing({ ...taskEditing, model: e.target.value || undefined, modelParams: undefined })} placeholder="留空跟随通道主模型" className={inputCls} />}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">结果通知群（可选）</label>
                <input
                  type="text"
                  value={taskEditing.notifyChatId ?? ""}
                  onChange={(e) => setTaskEditing({ ...taskEditing, notifyChatId: e.target.value.trim() || undefined })}
                  className={inputCls + " font-mono text-xs"}
                  placeholder="群 chat_id，如 oc_xxx"
                />
                <p className="mt-1 text-[10px] text-gray-600">填了的话，任务跑完后 Agent 会把结果发到这个群；不填则不在群里通知。</p>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={taskEditing.enabled} onChange={(e) => setTaskEditing({ ...taskEditing, enabled: e.target.checked })} className="rounded border-gray-600" />启用</label>
                <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={taskEditing.independent !== false} onChange={(e) => setTaskEditing({ ...taskEditing, independent: e.target.checked })} className="rounded border-gray-600" />独立运行</label>
              </div>
              <p className="text-[10px] text-gray-600">独立运行：触发时直接启动新 Agent 会话，不进入消息队列</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setTaskEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={handleTaskSave} disabled={!taskEditing.name.trim() || !taskEditing.cron.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}

      {hubBrowser && activeGroup && (
        <FlowHubBrowser
          kind={hubBrowser.kind}
          targetGroupId={activeGroup.id}
          onClose={() => setHubBrowser(null)}
          onImported={() => { void refreshNodeGroups(); setHubBrowser(null) }}
          showAlert={showAlert}
          showConfirm={showConfirm}
        />
      )}

      {ModalPortal}
    </div>
  )
}
