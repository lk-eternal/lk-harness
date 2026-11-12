import { useState, useEffect, useRef, useCallback } from "react"
import {
  ArrowLeft,
  FolderOpen,
  CheckCircle2,
  Loader2,
  Settings as SettingsIcon,
  Network,
  Blocks,
  FileCode2,
  Timer,
  Sparkles,
  Bot,
  Download,
  Wrench,
  BookOpen,
  ExternalLink,
  Copy,
  Info,
  Github,
  MessageSquare,
  Smartphone,
} from "lucide-react"
import ToolboxPanel from "../components/ToolboxPanel"
import AgentPanel from "../components/AgentPanel"
import ChannelPanel from "../components/ChannelPanel"
import MobilePairPanel from "../components/MobilePairPanel"
import TaskPanel from "../components/TaskPanel"
import McpPanel from "../components/McpPanel"
import RulePanel from "../components/RulePanel"
import SkillPanel from "../components/SkillPanel"
import ProjectsTab from "../components/project/ProjectsTab"
import { projectsJumpFor, splitSettingsTarget, type ProjectsJump } from "../components/project/projects-nav"
import { PANEL_FRAME } from "../components/panel-layout"
import TitleBar from "../components/TitleBar"
import useInlineModal from "../components/useInlineModal"
import ConfigMigratePanel from "../components/ConfigMigratePanel"
import { REQUIRED_FEISHU_SCOPES, FEISHU_SCOPES_JSON, FEISHU_EVENT_SUBSCRIPTIONS } from "../constants"
import { THEME_OPTIONS, type Theme } from "../theme-options"
import { silentReadyMessage } from "../../shared/silent-update"

interface Props { onBack: () => void; initialTab?: string; onTabConsumed?: () => void; onReenterWizard?: () => void }

type Tab = "general" | "channel" | "mobile" | "proxy" | "agent" | "mcp" | "rules" | "tasks" | "skills" | "projects" | "toolbox" | "setup" | "about"
type CloseWindowAction = "ask" | "minimize" | "quit"

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
  // initialTab 可以带子页（"projects:templates"），冒号前是一级标签
  const [tab, setTab] = useState<Tab>((splitSettingsTarget(initialTab).tab as Tab) || "general")
  const [projectsJump, setProjectsJump] = useState<ProjectsJump | undefined>(() => projectsJumpFor(splitSettingsTarget(initialTab)))
  const clearProjectsJump = useCallback(() => setProjectsJump(undefined), [])

  useEffect(() => {
    if (initialTab) {
      const target = splitSettingsTarget(initialTab)
      setTab(target.tab as Tab)
      setProjectsJump(projectsJumpFor(target))
      onTabConsumed?.()
    }
  }, [initialTab, onTabConsumed])

  const [proxy, setProxy] = useState("")
  const [noProxy, setNoProxy] = useState("localhost,127.0.0.1,feishu.cn,weixin.qq.com")
  const [closeWindowAction, setCloseWindowAction] = useState<CloseWindowAction>("ask")
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [theme, setTheme] = useState<Theme>("system")
  const [autoUpgradePrompt, setAutoUpgradePrompt] = useState(true)
  /** 静默更新（仅 Windows 显示）：后台自动下载，退出应用时自动安装，不弹窗、不出安装向导 */
  const [silentUpdate, setSilentUpdate] = useState(false)
  const silentUpdateRef = useRef(false)
  /** 帮助引导页飞书控制台链接用 */
  const [firstFeishuAppId, setFirstFeishuAppId] = useState("")
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()

  const [appVersion, setAppVersion] = useState("")
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<Awaited<ReturnType<typeof window.electronAPI.checkAppUpdate>> | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  /** 自动更新失败时给的手动下载直链 */
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState<string | null>(null)
  const [updateDownloadPct, setUpdateDownloadPct] = useState<number | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const updateDownloadingRef = useRef(false)

  const [saved, setSaved] = useState(false)

  const loaded = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void window.electronAPI.getAppVersion().then(setAppVersion)
  }, [])


  useEffect(() => {
    updateDownloadingRef.current = updateDownloading
  }, [updateDownloading])

  useEffect(() => {
    silentUpdateRef.current = silentUpdate
  }, [silentUpdate])

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
        setUpdateMsg(s.silent ? silentReadyMessage(s.version) : `新版本 v${s.version} 已下载，可立即安装。`)
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
        setUpdateMsg(silentUpdateRef.current ? silentReadyMessage(r.latestVersion) : `新版本 v${r.latestVersion} 已下载，可立即安装。`)
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
        setSilentUpdate(config.silentUpdate === true)
      })
    }
  }, [tab])

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

  const handleCheckUpdate = async () => {
    setUpdateBusy(true)
    setUpdateMsg(null)
    setUpdateDownloadUrl(null)
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
        setUpdateMsg(silentUpdateRef.current ? silentReadyMessage(r.latestVersion) : `新版本 v${r.latestVersion} 已下载，可立即安装。`)
      }
    } finally {
      setUpdateBusy(false)
    }
  }

  const handleApplyUpdate = async () => {
    setUpdateBusy(true)
    setUpdateMsg("正在连接更新服务器…")
    setUpdateDownloadUrl(null)
    try {
      const res = await window.electronAPI.applyAppUpdate()
      if (res.ok) {
        setUpdateMsg(res.message ?? "已触发更新流程。")
        setUpdateCheck(null)
      } else {
        setUpdateDownloading(false)
        setUpdateDownloadPct(null)
        setUpdateMsg(res.error ?? "更新失败")
        setUpdateDownloadUrl(res.downloadUrl ?? null)
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

  const handleSilentUpdateToggle = async () => {
    const next = !silentUpdate
    setSilentUpdate(next)
    await window.electronAPI.saveConfig({ silentUpdate: next })
    // 刚打开：马上查一次，有新版本就开始后台下载（不用等下一个 6 小时的周期）
    if (next) void window.electronAPI.checkAppUpdate()
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

            {tab === "projects" && <ProjectsTab jump={projectsJump} onJumpConsumed={clearProjectsJump} />}

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
                {window.electronAPI?.platform === "win32" && (
                  <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
                    <div className="min-w-0 pr-3">
                      <p className="text-sm font-medium">静默更新</p>
                      <p className="text-xs text-fg-muted">有新版本时在后台自动下载，不弹窗；退出应用时自动安装，不出现安装向导。开启后不再弹出「启动时自动提示升级」</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={silentUpdate}
                      onClick={() => void handleSilentUpdateToggle()}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${silentUpdate ? "bg-green-500" : "bg-stronger"}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${silentUpdate ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                    </button>
                  </div>
                )}
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
                    {updateDownloadUrl && (
                      <a
                        href={updateDownloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
                      >
                        <Download size={13} />下载安装包
                      </a>
                    )}
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

      {ModalPortal}
    </div>
  )
}
