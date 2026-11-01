import { useState, useEffect, useRef, useCallback } from "react"
import {
  ArrowLeft,
  FolderOpen,
  CheckCircle2,
  Loader2,
  X,
  Settings as SettingsIcon,
  Network,
  Blocks,
  FileCode2,
  Timer,
  Sparkles,
  Bot,
  Download,
  Wrench,
  FilePlus,
  BookOpen,
  ExternalLink,
  Copy,
  Eye,
  EyeOff,
  Info,
  Github,
  MessageSquare,
  Smartphone,
  Upload,
} from "lucide-react"
import { FlowHubBrowser } from "../components/FlowHubBrowser"
import ToolboxPanel from "../components/ToolboxPanel"
import AgentPanel from "../components/AgentPanel"
import ChannelPanel from "../components/ChannelPanel"
import MobilePairPanel from "../components/MobilePairPanel"
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
import { THEME_OPTIONS, type Theme } from "../theme-options"

interface Props { onBack: () => void; initialTab?: string; onTabConsumed?: () => void; onReenterWizard?: () => void }

type Tab = "general" | "channel" | "mobile" | "proxy" | "agent" | "mcp" | "rules" | "tasks" | "skills" | "projects" | "toolbox" | "setup" | "about"
type CloseWindowAction = "ask" | "minimize" | "quit"

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

const MASTER_DETAIL_TABS: Tab[] = ["agent", "channel", "rules", "skills", "mcp", "projects", "tasks"]

const TABS: { id: Tab; label: string; icon: typeof SettingsIcon }[] = [
  { id: "general", label: "通用", icon: SettingsIcon },
  { id: "proxy", label: "网络", icon: Network },
  { id: "mobile", label: "手机端", icon: Smartphone },
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
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,feishu.cn,weixin.qq.com")
  const [closeWindowAction, setCloseWindowAction] = useState<CloseWindowAction>("ask")
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [theme, setTheme] = useState<Theme>("system")
  const [autoUpgradePrompt, setAutoUpgradePrompt] = useState(true)
  /** 帮助引导页飞书控制台链接用 */
  const [firstFeishuAppId, setFirstFeishuAppId] = useState("")
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

  const loaded = useRef(false)
  const projectsLoaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const projectsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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
      if (s.kind === "retrying") {
        // 下载中断后在自动重试/续传；数据重新流动后下一次进度事件会把文案改回「正在下载更新… N%」
        setUpdateDownloading(true)
        setUpdateMsg(s.message)
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
    if (tab === "general" || tab === "setup") window.electronAPI.getConfig().then((config) => {
      setProxy(config.httpProxy || config.httpsProxy || "")
      setNoProxy(config.noProxy || "localhost,127.0.0.1,feishu.cn,weixin.qq.com")
      setCloseWindowAction(config.closeWindowAction ?? "ask")
      setAutoLaunch(config.autoStart ?? false)
      setTheme(config.theme)
      setFirstFeishuAppId(config.channels?.find((c) => c.type === "feishu")?.larkAppId ?? config.larkAppId ?? "")
      loaded.current = true
    })
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
  }, [tab, refreshProjectList])

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

  const handleAutoLaunchToggle = async () => {
    const next = !autoLaunch
    setAutoLaunch(next)
    await window.electronAPI.setAutoStart(next)
  }

  const handleThemeChange = async (next: Theme) => {
    setTheme(next)
    await window.electronAPI.setTheme(next)
  }

  const handleAutoUpgradePromptToggle = async () => {
    const next = !autoUpgradePrompt
    setAutoUpgradePrompt(next)
    await window.electronAPI.saveConfig({ autoUpgradePrompt: next })
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

  const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"
  const masterDetailLayout = MASTER_DETAIL_TABS.includes(tab) || tab === "projects"

  return (
    <div className="flex h-screen flex-col">
      <TitleBar>
        <div className="flex flex-1 items-center gap-3">
          <button onClick={onBack} className="rounded-lg p-1.5 text-fg-3 transition hover:bg-raised hover:text-fg" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}><ArrowLeft size={18} /></button>
          <h1 className="text-lg font-semibold">设置</h1>
          <div className="flex-1" />
          {saved && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={14} />已保存</span>}
        </div>
      </TitleBar>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-36 shrink-0 border-r border-line-subtle py-3">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition ${tab === t.id ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}>
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
                    className={`rounded-md border px-3 py-1.5 text-xs transition ${projectsSubTab === "list" ? "border-blue-500 bg-blue-500/10 font-medium text-fg" : "border-line text-fg-3 hover:bg-raised hover:text-fg-soft"}`}
                  >项目列表</button>
                  <button type="button"
                    onClick={() => setProjectsSubTab("settings")}
                    className={`rounded-md border px-3 py-1.5 text-xs transition ${projectsSubTab === "settings" ? "border-blue-500 bg-blue-500/10 font-medium text-fg" : "border-line text-fg-3 hover:bg-raised hover:text-fg-soft"}`}
                  >项目设置</button>
                  <button type="button"
                    onClick={() => setProjectsSubTab("groups")}
                    className={`rounded-md border px-3 py-1.5 text-xs transition ${projectsSubTab === "groups" ? "border-blue-500 bg-blue-500/10 font-medium text-fg" : "border-line text-fg-3 hover:bg-raised hover:text-fg-soft"}`}
                  >流程组</button>
                </div>
                {projectsSubTab === "list" && <ProjectListPanel />}
                {projectsSubTab === "settings" && (
                  <div className="flex-1 overflow-y-auto pb-6">
                    <div className="mx-auto max-w-xl space-y-6">
                      <section className="space-y-4">
                        <h3 className="text-sm font-medium text-fg-2">项目配置</h3>
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted">GitLab Token</label>
                          <div className="relative">
                            <input type={showGitlabToken ? "text" : "password"} value={gitlabToken} onChange={(e) => setGitlabToken(e.target.value)} placeholder="glpat-..." className={inputCls + " pr-16"} />
                            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                              <button type="button" title="复制" disabled={!gitlabToken.trim()} onClick={() => void navigator.clipboard.writeText(gitlabToken)} className="text-fg-muted hover:text-fg-2 disabled:opacity-40"><Copy size={13} /></button>
                              <button type="button" title={showGitlabToken ? "隐藏" : "显示"} onClick={() => setShowGitlabToken(!showGitlabToken)} className="text-fg-muted hover:text-fg-2">{showGitlabToken ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                            </div>
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted">GitLab Host（可空，默认从 origin 推断）</label>
                          <input type="text" value={gitlabHost} onChange={(e) => setGitlabHost(e.target.value)} placeholder="https://gitlab.com" className={inputCls} />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted">主仓（路径须为 git 根目录；基线=生产分支，只作切 feature 起点；测试/开发可空）</label>
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
                                  className="shrink-0 rounded-md border border-line px-2 py-1.5 text-xs text-fg-3 hover:bg-raised hover:text-danger"
                                >✕</button>
                              </div>
                            ))}
                            <button
                              type="button"
                              onClick={() => setRepoProfiles((list) => [...list, { path: "", baseBranch: "" }])}
                              className="rounded-md border border-dashed border-line px-3 py-1.5 text-xs text-fg-3 hover:bg-raised"
                            >+ 添加主仓</button>
                          </div>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted">AI 工作目录</label>
                          <div className="flex gap-2">
                            <input type="text" value={worktreeRoot} onChange={(e) => setWorktreeRoot(e.target.value)} placeholder="D:\claw-projects" className={inputCls} />
                            <button
                              type="button"
                              onClick={async () => {
                                const dir = await window.electronAPI.selectDirectory()
                                if (dir) setWorktreeRoot(dir)
                              }}
                              className="shrink-0 rounded-md border border-line px-3 text-xs text-fg-2 hover:bg-raised"
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
                        <h3 className="text-sm font-medium text-fg-2">流程组</h3>
                        <p className="text-xs text-fg-muted">建项可多选（不选默认「开发」）；推进节点按所选组分组展示；点击节点编辑提示词；拖动左侧把手调整顺序。</p>
                        <div className="rounded-lg border border-line-subtle p-3 space-y-2">
                          <h4 className="text-xs font-medium text-fg-3">共享空间</h4>
                          <div>
                            <label className="mb-1 block text-xs text-fg-muted">Hub 地址</label>
                            <input type="text" value={flowHubUrl} onChange={(e) => setFlowHubUrl(e.target.value)}
                              placeholder="https://gitlab.example.com/group/your-flow-hub" className={inputCls} />
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-fg-muted">Hub Token（Flow Hub 项目专用）</label>
                            <div className="relative">
                              <input type={showFlowHubToken ? "text" : "password"} value={flowHubToken} onChange={(e) => setFlowHubToken(e.target.value)}
                                placeholder="glpat-...（需 Maintainer 及以上权限）" className={inputCls + " pr-16"} />
                              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                                <button type="button" title="复制" disabled={!flowHubToken.trim()} onClick={() => void navigator.clipboard.writeText(flowHubToken)} className="text-fg-muted hover:text-fg-2 disabled:opacity-40"><Copy size={13} /></button>
                                <button type="button" title={showFlowHubToken ? "隐藏" : "显示"} onClick={() => setShowFlowHubToken(!showFlowHubToken)} className="text-fg-muted hover:text-fg-2">{showFlowHubToken ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="mb-1 block text-xs text-fg-muted">作者昵称（上传时展示）</label>
                            <input type="text" value={flowHubAuthor} onChange={(e) => setFlowHubAuthor(e.target.value)}
                              placeholder="你的名字" className={inputCls} />
                          </div>
                          <p className="text-[10px] text-fg-faint">Hub Token 与上方项目 Token 独立；未填 Hub Token 时回退使用项目 Token。</p>
                          <button
                            type="button"
                            onClick={() => openHubBrowser("group")}
                            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition ${hubConfigured ? "border-blue-600/50 text-accent hover:bg-raised" : "border-line text-fg-muted hover:bg-raised hover:text-fg-2"}`}
                          ><Download className="h-3 w-3" />从共享空间获取组</button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {nodeGroups.map((g) => (
                            <button key={g.id} type="button"
                              onClick={() => setActiveGroupId(g.id)}
                              className={`rounded-md border px-3 py-1.5 text-xs transition ${g.id === activeGroup?.id ? "border-blue-500 bg-blue-500/10 font-medium text-fg" : "border-line text-fg-3 hover:bg-raised hover:text-fg-soft"}`}
                            >{g.name}</button>
                          ))}
                          <button
                            type="button"
                            onClick={() => setGroupEditing({ id: "", name: "", index: -1 })}
                            className="rounded-md border border-dashed border-line px-3 py-1.5 text-xs text-fg-3 hover:bg-raised"
                          >+ 新增组</button>
                          <button
                            type="button"
                            onClick={() => openHubBrowser("group")}
                            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition ${hubConfigured ? "border-line text-accent hover:bg-raised" : "border-line text-fg-muted hover:bg-raised hover:text-fg-2"}`}
                          ><Download className="h-3 w-3" />从共享空间获取组</button>
                        </div>
                        {activeGroup && (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-3 text-xs text-fg-muted">
                              <span>当前组 <span className="font-mono">{activeGroup.id}</span> · {activeGroup.nodes.length} 个节点</span>
                              <button type="button" className="text-accent hover:text-accent-soft"
                                onClick={() => setGroupEditing({ id: activeGroup.id, name: activeGroup.name, index: nodeGroups.findIndex((g) => g.id === activeGroup.id) })}
                              >编辑</button>
                              <button type="button" className="inline-flex items-center gap-1 text-accent hover:text-accent-soft" onClick={() => void handleGroupExport()}>
                                <Download className="h-3 w-3" />导出
                              </button>
                              <button type="button" className="inline-flex items-center gap-1 text-accent hover:text-accent-soft" onClick={() => void handleGroupImport()}>
                                <FilePlus className="h-3 w-3" />导入
                              </button>
                              {hubConfigured && (
                                <button type="button" className="inline-flex items-center gap-1 text-accent hover:text-accent-soft"
                                  onClick={async () => {
                                    const r = await window.electronAPI.flowHub.uploadGroup(activeGroup.id)
                                    if (r.ok) { void showAlert("上传成功", `流程组「${activeGroup.name}」已上传到共享空间`); void refreshNodeGroups() }
                                    else void showAlert("上传失败", r.error ?? "未知错误")
                                  }}>
                                  <Upload className="h-3 w-3" />上传
                                </button>
                              )}
                              {nodeGroups.length > 1 && (
                                <button type="button" className="text-danger hover:text-danger-soft" onClick={handleGroupDelete}>删除组</button>
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
                                className={`w-full rounded-md border border-dashed px-3 py-2 text-xs transition ${hubConfigured ? "border-line text-accent hover:bg-raised" : "border-line text-fg-muted hover:bg-raised hover:text-fg-2"}`}
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
                <h3 className="text-sm font-medium text-fg-2">外观</h3>
                <div className="flex gap-2">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => void handleThemeChange(opt.v)}
                      className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${theme === opt.v ? "border-blue-500 bg-blue-500/10 font-medium text-fg" : "border-line text-fg-3 hover:border-line-strong"}`}
                    >
                      <opt.icon size={15} />{opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-fg-muted">切换后立即生效；「跟随系统」随 Windows 的深浅色设置变化。</p>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-fg-2">启动</h3>
                <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-medium">开机自启</p>
                    <p className="text-xs text-fg-muted">系统登录后自动启动 LK Harness；应用启动后自动拉起 Daemon 并连接消息通道</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoLaunch}
                    onClick={handleAutoLaunchToggle}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${autoLaunch ? "bg-green-500" : "bg-stronger"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${autoLaunch ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </button>
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-fg-2">关闭主窗口</h3>
                <p className="text-xs text-fg-faint">点击窗口右上角关闭时的行为（可从系统托盘再次打开窗口）。</p>
                <div className="space-y-2">
                  {([
                    { v: "ask" as const, t: "每次询问", d: "弹窗选择最小化到托盘或退出应用" },
                    { v: "minimize" as const, t: "总是最小化到托盘", d: "直接隐藏窗口，不弹窗" },
                    { v: "quit" as const, t: "总是退出应用", d: "关闭窗口并退出（含 Daemon、托盘）" },
                  ]).map((opt) => (
                    <label
                      key={opt.v}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${closeWindowAction === opt.v ? "border-blue-500 bg-blue-500/10" : "border-line hover:border-line-strong"}`}
                    >
                      <input
                        type="radio"
                        name="closeWindowAction"
                        checked={closeWindowAction === opt.v}
                        onChange={() => setCloseWindowAction(opt.v)}
                        className="mt-1 rounded-full border-line-strong"
                      />
                      <div>
                        <p className="text-sm font-medium">{opt.t}</p>
                        <p className="text-xs text-fg-muted">{opt.d}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-fg-2">配置迁移</h3>
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
              <p className="text-xs text-fg-muted">关闭窗口相关选项保存后立即生效。其余设置自动保存，部分项需重启 Daemon 后生效。</p>
            </>)}

            {/* ═══ Proxy ═══ */}
            {tab === "proxy" && (<>
              <section className="space-y-4">
                <h3 className="text-sm font-medium text-fg-2">代理设置</h3>
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">HTTP / HTTPS 代理</label>
                  <input type="text" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://127.0.0.1:1080" className={inputCls} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">NO_PROXY</label>
                  <input type="text" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} placeholder="localhost,127.0.0.1,feishu.cn,weixin.qq.com" className={inputCls} />
                </div>
              </section>
            </>)}

            {/* ═══ Mobile ═══ */}
            {tab === "mobile" && <MobilePairPanel />}

            {/* ═══ Toolbox ═══ */}
            {tab === "toolbox" && <ToolboxPanel />}

            {/* ═══ Setup Guide ═══ */}
            {tab === "setup" && (<>
              <section className="space-y-4">
                <h3 className="text-sm font-medium text-fg-2">新手引导</h3>
                <div className="rounded-lg border border-line p-4 space-y-3">
                  <p className="text-sm text-fg-3">从头走一遍三步引导：接入 AI → 选消息通道（飞书 / 微信 / 应用内，飞书和微信可顺便绑定自己）→ 装工具。已有配置会自动带入，不会被清空。</p>
                  <button
                    onClick={() => onReenterWizard?.()}
                    className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
                  >
                    <BookOpen size={15} />重新进入引导
                  </button>
                  <p className="text-xs text-fg-faint">以下为飞书手动建应用时需要的权限与事件配置参考。</p>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-fg-2">应用权限</h3>
                  <div className="flex items-center gap-2">
                    {firstFeishuAppId.trim() && (
                      <a href={`https://open.feishu.cn/app/${firstFeishuAppId.trim()}/auth`} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-fg-3 transition hover:bg-raised hover:text-accent">
                        <ExternalLink size={12} />前往设置权限
                      </a>
                    )}
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(FEISHU_SCOPES_JSON)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-fg-3 transition hover:bg-raised hover:text-fg"
                    >
                      <Copy size={12} />复制权限 JSON
                    </button>
                  </div>
                </div>
                <div className="rounded-lg border border-line-subtle divide-y divide-line-subtle">
                  {REQUIRED_FEISHU_SCOPES.map((p) => (
                    <div key={p.scope} className="flex items-center justify-between px-3 py-2">
                      <code className="text-xs text-accent">{p.scope}</code>
                      <span className="text-xs text-fg-muted">{p.desc}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-fg-2">事件订阅</h3>
                  {firstFeishuAppId.trim() && (
                    <a href={`https://open.feishu.cn/app/${firstFeishuAppId.trim()}/event`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-fg-3 transition hover:bg-raised hover:text-accent">
                      <ExternalLink size={12} />前往设置事件订阅
                    </a>
                  )}
                </div>
                <div className="rounded-lg border border-line-subtle divide-y divide-line-subtle">
                  {FEISHU_EVENT_SUBSCRIPTIONS.map((e) => (
                    <div key={e.event} className="px-3 py-2 flex items-center justify-between">
                      <code className="text-xs text-accent">{e.event}</code>
                      <span className="text-xs text-fg-muted">{e.desc}</span>
                    </div>
                  ))}
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-fg-2">读取用户发给机器人的单聊消息</span>
                    <span className="text-xs text-success">需开通</span>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-fg-2">获取群组中用户@机器人消息</span>
                    <span className="text-xs text-success">需开通</span>
                  </div>
                  <div className="px-3 py-2 text-xs text-fg-muted space-y-1">
                    <div>订阅方式：<span className="text-fg-2">应用身份</span></div>
                    <div>回调类型：<span className="text-fg-2">长连接（WebSocket）</span></div>
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-fg-2">回调订阅</h3>
                  {firstFeishuAppId.trim() && (
                    <a href={`https://open.feishu.cn/app/${firstFeishuAppId.trim()}/event?tab=callback`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-fg-3 transition hover:bg-raised hover:text-accent">
                      <ExternalLink size={12} />前往设置回调订阅
                    </a>
                  )}
                </div>
                <div className="rounded-lg border border-line-subtle divide-y divide-line-subtle">
                  <div className="px-3 py-2 flex items-center justify-between">
                    <code className="text-xs text-accent">card.action.trigger</code>
                    <span className="text-xs text-fg-muted">卡片回传交互</span>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-fg-2">用户点击卡片按钮（选项 / 指令）时回调</span>
                    <span className="text-xs text-success">需订阅</span>
                  </div>
                  <div className="px-3 py-2 text-xs text-fg-muted space-y-1">
                    <div>订阅方式：<span className="text-fg-2">应用身份</span></div>
                    <div>回调类型：<span className="text-fg-2">长连接（WebSocket）</span></div>
                    <div className="text-fg-faint">不订阅时按钮点击无响应，send_question / 指令按钮不可用</div>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium text-fg-2">参考文档</h3>
                <div className="flex flex-wrap gap-2">
                  <a href="https://github.com/lk-eternal/lk-harness" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-3 transition hover:bg-raised hover:text-accent">
                    <ExternalLink size={12} />项目 GitHub
                  </a>
                </div>
              </section>
            </>)}

            {tab === "about" && (<>
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-fg-2">应用更新</h3>
                <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-medium">启动时自动提示升级</p>
                    <p className="text-xs text-fg-muted">关闭后不再弹窗打扰；仍可在下方手动「检查更新」</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoUpgradePrompt}
                    onClick={() => void handleAutoUpgradePromptToggle()}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${autoUpgradePrompt ? "bg-green-500" : "bg-stronger"}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${autoUpgradePrompt ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </button>
                </div>
                <p className="text-xs text-fg-faint">
                  当前 <span className="font-mono text-fg-3">v{appVersion || "…"}</span>
                  ，可检查是否有新版本。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={updateBusy || updateDownloading}
                    onClick={() => void handleCheckUpdate()}
                    className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-raised/50 px-4 py-2 text-sm transition hover:border-blue-500 hover:bg-raised disabled:opacity-50"
                  >
                    {updateBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                    检查更新
                  </button>
                  {updateCheck?.status === "available" && (
                    <button
                      type="button"
                      disabled={updateBusy || updateDownloading}
                      onClick={() => void handleApplyUpdate()}
                      className="inline-flex items-center gap-2 rounded-lg border border-blue-500 bg-blue-500/15 px-4 py-2 text-sm text-accent-bright transition hover:bg-blue-500/25 disabled:opacity-50"
                    >
                      立即更新
                    </button>
                  )}
                  {updateCheck?.status === "ready" && (
                    <button
                      type="button"
                      disabled={updateBusy}
                      onClick={() => void handleApplyUpdate()}
                      className="inline-flex items-center gap-2 rounded-lg border border-green-500 bg-green-500/15 px-4 py-2 text-sm text-success-bright transition hover:bg-green-500/25 disabled:opacity-50"
                    >
                      立即安装
                    </button>
                  )}
                </div>
                {(updateCheck?.status === "available" || updateCheck?.status === "ready") && updateCheck.releaseNotes && (
                  <div className="rounded-lg border border-line bg-surface/50 px-3 py-2">
                    <p className="mb-1.5 text-xs font-medium text-fg-2">更新内容</p>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg-3">{updateCheck.releaseNotes}</p>
                  </div>
                )}
                {updateMsg && (
                  <div className="space-y-2">
                    <p className="whitespace-pre-wrap rounded-lg border border-line bg-surface/50 px-3 py-2 text-xs text-fg-3">{updateMsg}</p>
                    {updateDownloading && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
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
                <h3 className="text-sm font-medium text-fg-2">项目信息</h3>
                <a
                  href="https://github.com/lk-eternal/lk-harness"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-raised/50 px-4 py-2 text-sm text-fg-2 transition hover:border-blue-500 hover:bg-raised hover:text-accent"
                >
                  <Github size={16} />
                  GitHub 仓库
                  <ExternalLink size={12} className="text-fg-muted" />
                </a>
              </section>
            </>)}

            </>)}

          </div>
        </div>
      </div>

      {/* ═══ Project Node Edit Modal ═══ */}
      {nodeEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-full max-w-lg flex-col rounded-xl border border-line bg-surface shadow-2xl" style={{ maxHeight: "80vh" }}>
            <div className="flex items-center justify-between border-b border-line-subtle px-6 py-4">
              <h3 className="text-sm font-semibold text-fg-soft">{nodeEditing.index < 0 ? "添加节点" : `编辑节点 · ${nodeEditing.label || nodeEditing.id}`}</h3>
              <button onClick={() => setNodeEditing(null)} className="text-fg-muted hover:text-fg"><X size={16} /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
              <div className="flex gap-3">
                <div className="flex-1"><label className="mb-1 block text-xs text-fg-muted">节点 id（/p 命令）</label>
                  <input type="text" value={nodeEditing.id}
                    onChange={(e) => setNodeEditing({ ...nodeEditing, id: e.target.value.trim() })}
                    className={inputCls} placeholder="如 test-report" /></div>
                <div className="flex-1"><label className="mb-1 block text-xs text-fg-muted">按钮名称</label>
                  <input type="text" value={nodeEditing.label}
                    onChange={(e) => setNodeEditing({ ...nodeEditing, label: e.target.value })}
                    className={inputCls} placeholder="如 测试报告" /></div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs text-fg-muted">节点提示词（告诉 AI 该节点做什么、产出标准）</label>
                  {(nodeEditing.defaultPrompt ?? "").trim() !== "" && (nodeEditing.prompt ?? "").trim() !== "" && (
                    <button type="button" className="text-xs text-accent hover:text-accent-soft"
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
                  <p className="mt-1 text-[10px] text-fg-muted">当前使用内置默认模板（上方内容即模板全文，编辑即覆盖）</p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-line-subtle px-6 py-4">
              <div>
                {nodeEditing.index >= 0 && hubConfigured && activeGroup && (
                  <button
                    type="button"
                    className="mr-2 inline-flex items-center gap-1 rounded-md px-4 py-1.5 text-xs text-accent transition hover:bg-raised"
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
                    className="rounded-md px-4 py-1.5 text-xs text-danger transition hover:bg-raised"
                  >删除节点</button>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setNodeEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-fg-3 transition hover:bg-raised hover:text-fg">取消</button>
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
          <div className="flex w-full max-w-sm flex-col rounded-xl border border-line bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-line-subtle px-6 py-4">
              <h3 className="text-sm font-semibold text-fg-soft">{groupEditing.index < 0 ? "新增流程组" : "编辑流程组"}</h3>
              <button onClick={() => setGroupEditing(null)} className="text-fg-muted hover:text-fg"><X size={16} /></button>
            </div>
            <div className="space-y-3 px-6 py-4">
              <div><label className="mb-1 block text-xs text-fg-muted">组 id</label>
                <input type="text" value={groupEditing.id} disabled={groupEditing.index >= 0}
                  onChange={(e) => setGroupEditing({ ...groupEditing, id: e.target.value.trim() })}
                  className={`${inputCls} ${groupEditing.index >= 0 ? "opacity-60" : ""}`} placeholder="如 design" /></div>
              <div><label className="mb-1 block text-xs text-fg-muted">组名</label>
                <input type="text" value={groupEditing.name}
                  onChange={(e) => setGroupEditing({ ...groupEditing, name: e.target.value })}
                  className={inputCls} placeholder="如 设计" /></div>
            </div>
            <div className="flex justify-end gap-2 border-t border-line-subtle px-6 py-4">
              <button onClick={() => setGroupEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-fg-3 transition hover:bg-raised hover:text-fg">取消</button>
              <button onClick={handleGroupSave} disabled={!groupEditing.id.trim() || !groupEditing.name.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
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
