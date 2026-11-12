import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, FolderKanban, Loader2, MessageCircle, MoreHorizontal, PanelLeft, PanelRight, Pin, PinOff, Plus, Smartphone, Trash2 } from "lucide-react"
import TitleBar from "../components/TitleBar"
import TitleBrand from "../components/TitleBrand"
import TitleActions from "../components/TitleActions"
import PageTabs, { type MainPage } from "../components/PageTabs"
import SessionTitle from "../components/SessionTitle"
import useInlineModal from "../components/useInlineModal"
import ChatItemList from "../components/chat/ChatItemList"
import Composer from "../components/chat/Composer"
import { composerDraftKey, discardComposerDraft } from "../components/chat/composer-drafts"
import QueuedStrip from "../components/chat/QueuedStrip"
import PreviewPanel from "../components/preview/PreviewPanel"
import { PreviewContext, usePreviewController } from "../components/preview/PreviewContext"
import { sendNowOutcome, type SendNowOutcome } from "../components/chat/queued-strip-text"
import SessionSchedules from "../components/chat/SessionSchedules"
import DirPicker from "../components/chat/DirPicker"
import BranchPicker from "../components/chat/BranchPicker"
import NewProjectDialog from "../components/project/NewProjectDialog"
import { PROJECT_TEMPLATES_TARGET } from "../components/project/projects-nav"
import ProjectBar from "../components/project/ProjectBar"
import ModelPicker, { type ModelChoice } from "../components/chat/ModelPicker"
import { useModelFavorites } from "../hooks/useModelFavorites"
import { sameChatSession, useAppChatItems } from "../components/chat/useAppChatItems"
import { useSessionActivity } from "../components/chat/useSessionActivity"
import { useReplyNotify } from "../components/chat/useReplyNotify"
import { countUnreadElsewhere, emptySessionHint, sidebarToggleTitle, useSidebarCollapsed } from "../components/chat/sidebar-state"
import { useScrollActiveIntoView } from "../components/panel-scroll"
import { usePinnedSessions } from "../components/chat/pinned-sessions"
import useOutsideClose from "../hooks/useOutsideClose"
import { appChatSessionDir, appChatSessionId, appChatSessionName, canRebindSessionDir, chatDirOptions, chatStreamItems, isQueuedUserItem, planDirChoice, sameChatDir, visibleChatTabs } from "../../shared/app-chat-types"
import { hideDeletedTabs, markSessionDeleted, type DeletedSessions } from "../../shared/deleted-sessions"
import { canSwitchBranch, sharedSessionCount } from "../../shared/git-branch"
import { CHANNEL_TYPE_LABELS, workspaceDirFromSessionKey, type AgentResource } from "../../shared/channel-types"
import { describeAppChannelIssue, ensureAppChannel, planAppChannel, type AppChannelIssue, type EnsureAppChannelIO } from "../../shared/app-channel-ensure"
import { emptyChannel } from "../channel-defaults"
import { notifyChannelsChanged } from "../channel-events"
import { projectIdOfSessionKey, type ProjectCreateResult } from "../../shared/project-app-types"
import { isTempChatWorkspace, tempWorkspaceCreatedAt } from "../../shared/temp-workspace"
import { modelSlug } from "../model-utils"
import { formatTimeAgo } from "../time-ago"

type Tree = Awaited<ReturnType<typeof window.electronAPI.listDashboardTree>>
type ChatTab = Tree["channels"][number]["mainTabs"][number]

interface AppChannelView {
  channelId: string
  name: string
  /** 通道默认供应商；会话没有单独指定时用它 */
  agentResourceId?: string
  tabs: ChatTab[]
  activeKey?: string
}

interface Props {
  /** 当前是否为可见页面（可见时才轮询刷新） */
  active: boolean
  /** 标题栏页面切换 */
  onSwitchPage: (page: MainPage) => void
  /** 打开设置页，可指定初始 Tab */
  onSettings: (tab?: string) => void
}

const REFRESH_MS = 8000

/**
 * 没有「应用内对话」通道时自动建一个（见 shared/app-channel-ensure.ts）。
 * 走设置页同一个保存入口：通道的启动、热更新都在保存里处理；供应商留空，跟随默认供应商。
 */
const appChannelIO: EnsureAppChannelIO = {
  loadChannels: async () => (await window.electronAPI.getConfig()).channels ?? [],
  saveChannels: async (channels) => {
    const r = await window.electronAPI.saveConfig({ channels })
    if (!r.ok) throw new Error("保存配置失败")
  },
  newChannel: () => emptyChannel("app", CHANNEL_TYPE_LABELS.app),
}

/** 刚建好、还没发过消息的临时会话：会话在首条消息发出时才建立，在此之前只存在于界面里 */
interface DraftSession {
  channelId: string
  sessionKey: string
}

function isTempTab(t: ChatTab): boolean {
  return isTempChatWorkspace(workspaceDirFromSessionKey(t.sessionKey))
}

type TabModel = Pick<ChatTab, "model" | "modelParams" | "resourceId">

/** 把草稿会话补进对应通道的会话列表（服务端已经有同一会话时不重复）；草稿的模型由服务端提供 */
function withDrafts(views: AppChannelView[], drafts: DraftSession[], draftModels: Record<string, TabModel>): AppChannelView[] {
  if (drafts.length === 0) return views
  return views.map((v) => {
    const extra = drafts
      .filter((d) => d.channelId === v.channelId && !v.tabs.some((t) => sameChatSession(t.sessionKey, d.sessionKey)))
      .map((d): ChatTab => ({ sessionKey: d.sessionKey, label: "新会话", kind: "dir", running: false, current: false, removable: true, ...draftModels[d.sessionKey] }))
    return extra.length > 0 ? { ...v, tabs: [...extra, ...v.tabs] } : v
  })
}

function dirName(dir: string | undefined): string | undefined {
  return dir?.split(/[\\/]/).filter(Boolean).pop()
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function ChatPage({ active, onSwitchPage, onSettings }: Props) {
  const [serverViews, setViews] = useState<AppChannelView[]>([])
  const [drafts, setDrafts] = useState<DraftSession[]>([])
  const [draftModels, setDraftModels] = useState<Record<string, TabModel>>({})
  /** 刚给会话选的工作目录：草稿会话不在服务端会话树里，已有的会话要等下一次刷新才带上 boundDir，这里先顶上 */
  const [pickedDirs, setPickedDirs] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(false)
  const [treeError, setTreeError] = useState("")
  /** 没有可用的应用内通道时的原因：被停用 / 自动创建失败（下一次刷新会重试） */
  const [channelIssue, setChannelIssue] = useState<AppChannelIssue | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const { quickModels, favorites, refresh: refreshModels, toggleFavorite } = useModelFavorites()
  const [resources, setResources] = useState<AgentResource[]>([])
  const [modelBusy, setModelBusy] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [usageBytes, setUsageBytes] = useState<number | null>(null)
  const [actionError, setActionError] = useState("")
  /** 「新建项目」对话框：要建在哪个应用内通道下 */
  const [newProjectFor, setNewProjectFor] = useState<string | null>(null)
  /** 刚建好的项目会话：等它出现在会话列表里再切过去（直接选一个列表里还没有的会话，会被「选中项失效」回落掉） */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  /** 会话最近一条记录的时间，键为 appChatSessionId；now 随每次刷新更新，用来算「多久前」 */
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  const [now, setNow] = useState(() => Date.now())
  const busyRef = useRef(false)
  const creatingRef = useRef(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const viewsRef = useRef<AppChannelView[]>([])
  /** 刚删除的会话：删除前发出的那次刷新可能晚返回，带着已删会话盖掉列表，命中这里的先不显示 */
  const deletedRef = useRef<DeletedSessions>(new Map())
  const views = useMemo(() => withDrafts(serverViews, drafts, draftModels), [serverViews, drafts, draftModels])
  viewsRef.current = views
  const { showConfirm, ModalPortal } = useInlineModal()

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const read = () => Promise.all([
        window.electronAPI.getConfig(),
        window.electronAPI.listDashboardTree(),
      ])
      let [cfg, tree] = await read()
      // 一个应用内通道都没有：自动建好再读一遍，用户不用先去设置里添加；已被停用的不动，只提示
      let issue: AppChannelIssue | null = null
      const plan = planAppChannel(cfg.channels)
      if (plan.action === "disabled") issue = { kind: "disabled" }
      if (plan.action === "create") {
        const r = await ensureAppChannel(appChannelIO)
        if (r.status === "created") {
          notifyChannelsChanged()
          const again = await read()
          cfg = again[0]
          tree = again[1]
        } else if (r.status === "failed") {
          issue = { kind: "failed", error: r.error }
        } else if (r.status === "disabled") {
          issue = { kind: "disabled" }
        }
      }
      setChannelIssue(issue)
      const appCfgs = new Map((cfg.channels ?? []).filter((c) => c.type === "app" && c.enabled !== false).map((c) => [c.id, c]))
      const appChannels = tree.channels.filter((c) => appCfgs.has(c.channelId))
      const active = await window.electronAPI.appChatLastActive(appChannels.flatMap((c) => c.mainTabs.map((t) => t.sessionKey)))
      if (active.ok) setLastActive(active.times ?? {})
      setNow(Date.now())
      setResources(cfg.agentResources ?? [])
      setViews(hideDeletedTabs(appChannels.map((c) => ({
        channelId: c.channelId,
        name: appCfgs.get(c.channelId)?.name ?? c.name,
        agentResourceId: appCfgs.get(c.channelId)?.agentResourceId,
        tabs: visibleChatTabs(c.mainTabs),
        activeKey: c.activeKey,
      })), deletedRef.current))
      setTreeError(tree.ok ? "" : (tree.error ?? "读取会话失败"))
    } catch (e: unknown) {
      setTreeError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setLoaded(true)
    }
  }, [])

  // 草稿会话不在服务端会话树里，它的模型单独向服务端读；草稿增减时重读
  const refreshDraftModels = useCallback(async () => {
    setDraftModels(await window.electronAPI.getSessionModels(drafts.map((d) => d.sessionKey)))
  }, [drafts])
  useEffect(() => { void refreshDraftModels() }, [refreshDraftModels])

  // 可见时：立即刷新 + 定时兜底 + 会话进程变化推送
  useEffect(() => {
    if (!active) return
    void refresh()
    void refreshModels()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    const unsub = window.electronAPI.onSessionAgents(() => void refresh())
    return () => { window.clearInterval(timer); unsub() }
  }, [active, refresh, refreshModels])

  // 分支被切换（手机端切的也会推）：马上重读会话列表，列表上的分支才是新的
  useEffect(() => window.electronAPI.onAppChatBranchChanged(() => void refresh()), [refresh])

  // 会话摘要标题：先订阅再拉取，生成完成/清空/删除都会整体推送
  useEffect(() => {
    const unsub = window.electronAPI.onAppChatTitles(setTitles)
    void window.electronAPI.appChatTitles().then(setTitles)
    return unsub
  }, [])

  // 选中项失效（首次进入、会话被删）时回落到通道当前会话或第一个
  useEffect(() => {
    const withTabs = views.filter((v) => v.tabs.length > 0)
    if (withTabs.length === 0) {
      if (selected) setSelected(null)
      return
    }
    const current = withTabs.flatMap((v) => v.tabs).find((t) => sameChatSession(t.sessionKey, selected))
    if (current) return
    const first = withTabs[0]
    const pick = first.tabs.find((t) => sameChatSession(t.sessionKey, first.activeKey)) ?? first.tabs[0]
    setSelected(pick.sessionKey)
  }, [views, selected])

  // 刚建好的项目会话一出现在列表里就切过去；等太久（列表读失败等）就放弃，不霸占用户之后的选择
  useEffect(() => {
    if (!pendingSelect) return
    if (views.some((v) => v.tabs.some((t) => sameChatSession(t.sessionKey, pendingSelect)))) {
      setSelected(pendingSelect)
      setPendingSelect(null)
    }
  }, [views, pendingSelect])
  useEffect(() => {
    if (!pendingSelect) return
    const timer = window.setTimeout(() => setPendingSelect(null), 20000)
    return () => window.clearTimeout(timer)
  }, [pendingSelect])

  // 草稿会话发出第一条消息后，服务端列表里就有了，草稿即可丢弃（否则会话被删后它会冒出来）
  useEffect(() => {
    setDrafts((prev) => {
      const next = prev.filter((d) => !serverViews.some((v) => v.tabs.some((t) => sameChatSession(t.sessionKey, d.sessionKey))))
      return next.length === prev.length ? prev : next
    })
  }, [serverViews])

  const closeMoreMenu = useCallback(() => setMoreMenuOpen(false), [])
  useOutsideClose(moreMenuOpen, moreMenuRef, closeMoreMenu)

  const refreshUsage = useCallback(async () => {
    const sums = await Promise.all(viewsRef.current.map((v) => window.electronAPI.appChatUsage(v.channelId)))
    setUsageBytes(sums.reduce((acc, r) => acc + (r.ok ? (r.bytes ?? 0) : 0), 0))
  }, [])

  useEffect(() => {
    if (!actionError) return
    const t = window.setTimeout(() => setActionError(""), 4000)
    return () => window.clearTimeout(t)
  }, [actionError])

  const preview = usePreviewController(selected)
  const { items: allItems, loading, error: historyError, hasMore, loadingEarlier, loadEarlier } = useAppChatItems(selected)
  /** 排队中的消息（Agent 还没收到）只在输入框上方的暂存区出现，投递后才进聊天流 */
  const items = useMemo(() => chatStreamItems(allItems), [allItems])
  const queuedItems = useMemo(() => allItems.filter(isQueuedUserItem), [allItems])
  const sessionStatus = useSessionActivity(active ? selected : null)
  // 回复完成的系统通知：告诉主进程我正看着哪个会话（看着的不弹）；点了通知就切到那个会话
  useReplyNotify(active ? selected : null, (sessionKey) => {
    onSwitchPage("chat")
    const known = viewsRef.current.flatMap((v) => v.tabs).find((t) => sameChatSession(t.sessionKey, sessionKey))
    // 列表里还没有它（对话页不可见时不刷新）就等刷新出来再切，和刚建好的项目会话是同一条路
    if (known) setSelected(known.sessionKey)
    else setPendingSelect(sessionKey)
  })
  const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed()
  /** 置顶的会话：存在电脑端，和手机端同一份 */
  const pins = usePinnedSessions(setActionError)

  const ownerView = views.find((v) => v.tabs.some((t) => sameChatSession(t.sessionKey, selected)))
  const tab = ownerView?.tabs.find((t) => sameChatSession(t.sessionKey, selected))
  /** 当前会话是项目会话时的项目 id */
  const projectId = tab?.kind === "project" ? projectIdOfSessionKey(tab.sessionKey) : undefined
  /** 用户给会话选的工作目录：服务端带回来的优先，刚选还没刷新到的用本地的 */
  const boundDirOf = (t: ChatTab): string | undefined => t.boundDir ?? pickedDirs[t.sessionKey]
  /** 会话的工作目录；没选过目录的临时会话没有，它自己的临时文件夹对用户不可见 */
  const dirOf = (t: ChatTab): string | undefined => appChatSessionDir(t.sessionKey, boundDirOf(t))
  const workspaceDir = tab ? dirOf(tab) : undefined
  /** 会话名：项目会话叫项目名；其它是摘要标题，还没有时选了目录的显示目录名，没选的临时会话叫「新会话」，其它显示目录名（不带「（主）」和分支） */
  const sessionName = (t: ChatTab) => appChatSessionName(t.sessionKey, titles, t.label, boundDirOf(t)) ?? t.label
  const activeAt = (t: ChatTab): number | undefined => lastActive[appChatSessionId(t.sessionKey)]
  /** 最近有对话的排前面；还没有对话的临时会话按创建时间排，其它没有记录的排在最后 */
  const sortAt = (t: ChatTab) => activeAt(t) ?? tempWorkspaceCreatedAt(workspaceDirFromSessionKey(t.sessionKey)) ?? 0
  const byRecent = (tabs: ChatTab[]) => [...tabs].sort((a, b) => sortAt(b) - sortAt(a))
  /** 置顶的排在最前，其余按最近对话排；两组内部都是最近的在前 */
  const listOrder = (tabs: ChatTab[]) => pins.order(byRecent(tabs))
  /** 目录菜单：这个通道里各会话在用的目录（去重）。目录不是会话的身份，同一个目录可以有多个会话 */
  const dirOptions = chatDirOptions(ownerView?.tabs ?? [], boundDirOf)
  /** 还没开始的临时会话可以直接改它的目录；开始了或目录是会话身份的，选目录只能用该目录新开一个会话 */
  const sessionStarted = !!tab && (activeAt(tab) !== undefined || allItems.length > 0)
  const canRebindDir = !!tab && canRebindSessionDir(tab.sessionKey, sessionStarted)
  /** 分支是工作目录的：用这个目录的会话（含自己）都受切换影响；其中有在回复的，现在就不能切 */
  const branchTabs = (ownerView?.tabs ?? []).filter((t) => t.kind !== "project")
  const branchShared = sharedSessionCount(branchTabs, dirOf, workspaceDir)
  const branchWorking = branchTabs.some((t) => sameChatDir(dirOf(t), workspaceDir) && sessionStatus(t.sessionKey, t.running) === "working")
  const modelLabel = tab?.model
    ? (quickModels.find((m) => m.model === tab.model && (m.modelParams ?? "") === (tab.modelParams ?? ""))?.label || modelSlug(tab.model, tab.modelParams))
    : "默认模型"

  // 用量只在进入页面/切会话/成员变化时重算，不进 8s 轮询
  useEffect(() => {
    if (active && views.length > 0) void refreshUsage()
  }, [active, views.length, selected, refreshUsage])

  const send = async (text: string, images: string[] = []) => {
    if (!selected) return
    const r = await window.electronAPI.appChatSend({ sessionKey: selected, text, ...(images.length > 0 ? { images } : {}) })
    if (!r.ok) setActionError(r.error ?? "发送失败")
    // 发送会拉起/排队会话，稍后刷新运行态与用量
    window.setTimeout(() => { void refresh(); void refreshUsage() }, 600)
  }

  const clearSession = async () => {
    setMoreMenuOpen(false)
    if (!selected || !tab) return
    if (!await showConfirm("清空本会话记录", `确定清空「${sessionName(tab)}」在应用内的对话记录吗？\n只删除本页记录（会话名随之重置），Agent 的会话上下文不受影响。`, "清空")) return
    const r = await window.electronAPI.appChatClear({ sessionKey: selected })
    if (!r.ok) setActionError(r.error ?? "清空失败")
    void refreshUsage()
  }

  const renameSession = async (name: string) => {
    if (!selected) return
    const r = await window.electronAPI.appChatRenameSession(selected, name)
    if (!r.ok) setActionError(r.error ?? "重命名失败")
  }

  const deleteSession = async (t: ChatTab) => {
    // 还没发过消息的草稿会话没有什么可丢的，不再确认
    const isDraft = drafts.some((d) => sameChatSession(d.sessionKey, t.sessionKey))
    const boundDir = boundDirOf(t)
    const effect = isTempTab(t)
      ? boundDir
        ? `会停止 Agent、清除上下文和聊天记录。「${dirName(boundDir) ?? boundDir}」里的文件不会被删除。`
        : "会停止 Agent、清除上下文和聊天记录，并删除这个会话的临时文件夹（其中生成的文件也会一并删除）。"
      : t.kind === "main"
        ? "会停止 Agent、清除上下文和聊天记录，并清除该通道的主目录设置（不删磁盘文件）。"
        : "会停止 Agent、清除上下文和聊天记录，并从常用目录中移除。"
    if (!isDraft && !await showConfirm("删除会话", `确定删除「${sessionName(t)}」吗？\n${effect}`, "删除")) return
    const r = await window.electronAPI.appChatDeleteSession(t.sessionKey)
    if (!r.ok) { setActionError(r.error ?? "删除失败"); return }
    setDrafts((prev) => prev.filter((d) => !sameChatSession(d.sessionKey, t.sessionKey)))
    discardComposerDraft(t.sessionKey)
    // 先从列表里拿掉，再刷新：正在进行中的刷新可能是删除前发出的，晚到时不能让它把会话带回来
    markSessionDeleted(deletedRef.current, t.sessionKey)
    setViews((prev) => hideDeletedTabs(prev, deletedRef.current))
    await refresh()
    void refreshUsage()
  }

  const clearAll = async () => {
    if (!await showConfirm("清空全部对话记录", "确定清空所有应用内会话的对话记录吗？\n只删除本页记录，Agent 的会话上下文不受影响。", "全部清空")) return
    for (const v of views) {
      const r = await window.electronAPI.appChatClear({ channelId: v.channelId })
      if (!r.ok) { setActionError(r.error ?? "清空失败"); break }
    }
    void refreshUsage()
  }

  const answer = async (questionId: string, option: string) => {
    if (!selected) return
    const r = await window.electronAPI.appChatSend({ sessionKey: selected, questionId, option })
    if (!r.ok) setActionError(r.error ?? "提交选择失败")
  }

  /** 暂存区：改排队中的消息；没改成（已被 Agent 收走等）返回 false，让编辑框保持打开 */
  const editQueued = async (id: string, text: string): Promise<boolean> => {
    if (!selected) return false
    const r = await window.electronAPI.appChatQueueEdit(selected, id, text)
    if (!r.ok) setActionError(r.error ?? "修改失败")
    return r.ok
  }

  const removeQueued = async (id: string) => {
    if (!selected) return
    const r = await window.electronAPI.appChatQueueRemove(selected, id)
    if (!r.ok) setActionError(r.error ?? "删除失败")
  }

  /** 暂存区「立即发送」：打断当前回合，排队的消息交给 Agent（一般不用重启 Agent）；返回值用来显示交接提示 */
  const sendQueuedNow = async (): Promise<SendNowOutcome> => {
    if (!selected) return "none"
    const r = await window.electronAPI.sendQueuedNow(selected)
    if (!r.ok) setActionError(r.error ?? "发送失败")
    window.setTimeout(() => { void refresh() }, 600)
    return sendNowOutcome(r)
  }

  /** 停止并清空本会话排队消息，等价于 /x -c */
  const stop = async () => {
    if (!selected) return
    await window.electronAPI.stopSessionAgent(selected, true)
    void refresh()
  }

  const switchModel = async (m: ModelChoice) => {
    if (!selected || modelBusy) return
    setModelBusy(true)
    try {
      const r = await window.electronAPI.setSessionModel(selected, m.model, m.modelParams, m.resourceId)
      if (!r.ok) setActionError(r.error ?? "切换模型失败")
      await refresh()
      await refreshDraftModels()
    } finally {
      setModelBusy(false)
    }
  }

  /** 新会话 = 临时会话：用应用建的临时目录，不用先选目录；已有还没聊过的临时会话就直接用它 */
  const newSession = async (channelId: string) => {
    const idle = views.find((v) => v.channelId === channelId)?.tabs.find((t) => {
      if (!isTempTab(t) || boundDirOf(t) || activeAt(t) !== undefined) return false
      return !(sameChatSession(t.sessionKey, selected) && items.length > 0)
    })
    if (idle) { setSelected(idle.sessionKey); return }
    if (creatingRef.current) return
    creatingRef.current = true
    try {
      const r = await window.electronAPI.appChatNewTempSession(channelId)
      const sessionKey = r.sessionKey
      if (!r.ok || !sessionKey) { setActionError(r.error ?? "新建会话失败"); return }
      setDrafts((prev) => [...prev, { channelId, sessionKey }])
      setSelected(sessionKey)
    } finally {
      creatingRef.current = false
    }
  }

  // 一个会话都没有时（刚走完引导、删掉了最后一个）自动建一个临时会话，对话页不留空白
  const emptyChannelId = loaded && views.length > 0 && views.every((v) => v.tabs.length === 0) ? views[0].channelId : undefined
  useEffect(() => {
    if (emptyChannelId) void newSession(emptyChannelId)
  }, [emptyChannelId])

  /**
   * 给当前会话选工作目录：还没开始的临时会话直接改它的目录；其它会话（已经开始、或目录就是会话身份的）
   * 目录定了不能换，就用这个目录新开一个会话。目录不是会话的身份，已有会话在用同一个目录也照样新开。
   */
  const chooseDir = async (dir: string) => {
    if (!selected || !ownerView) return
    const plan = planDirChoice({ sessionKey: selected, started: sessionStarted, currentDir: workspaceDir, chosen: dir })
    if (plan === "same") return
    if (plan === "rebind") {
      const r = await window.electronAPI.appChatSetSessionDir(selected, dir)
      if (!r.ok) { setActionError(r.error ?? "设置目录失败"); return }
      setPickedDirs((prev) => ({ ...prev, [selected]: dir }))
      void refresh()
      return
    }
    const r = await window.electronAPI.appChatNewTempSession(ownerView.channelId, dir)
    const sessionKey = r.sessionKey
    if (!r.ok || !sessionKey) { setActionError(r.error ?? "新建会话失败"); return }
    setDrafts((prev) => [...prev, { channelId: ownerView.channelId, sessionKey }])
    setPickedDirs((prev) => ({ ...prev, [sessionKey]: dir }))
    setSelected(sessionKey)
  }

  const pickNewDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) await chooseDir(dir)
  }

  /** 项目建好了：关对话框，等会话出现在列表里切过去；建好但有后续提示的（比如进入会话没成功）显示出来 */
  const projectCreated = (r: ProjectCreateResult) => {
    setNewProjectFor(null)
    if (r.warning) setActionError(r.warning)
    if (r.sessionKey) setPendingSelect(r.sessionKey)
    void refresh()
    // 刚进入的会话要等路由登记才进列表，补刷几次，不用等 8 秒的定时刷新
    for (const ms of [600, 1800]) window.setTimeout(() => { void refresh() }, ms)
  }

  /** 项目已在项目栏里删除：和删普通会话一样先把它从列表拿掉，再刷新 */
  const projectDeleted = async (t: ChatTab) => {
    setDrafts((prev) => prev.filter((d) => !sameChatSession(d.sessionKey, t.sessionKey)))
    discardComposerDraft(t.sessionKey)
    markSessionDeleted(deletedRef.current, t.sessionKey)
    setViews((prev) => hideDeletedTabs(prev, deletedRef.current))
    await refresh()
    void refreshUsage()
  }

  // 会话进程在线 ≠ AI 在干活（回复完 Agent 仍挂在 poll 上）：以未收口的回合卡 / 待处理的用户消息为准
  const hasLiveTurn = items.some((it) => it.kind === "assistant" && !it.finished)
  const busy = !!tab?.running && (hasLiveTurn || items[items.length - 1]?.kind === "user")
  const noChannel = loaded && views.length === 0
  const issueText = describeAppChannelIssue(channelIssue)

  // 收起会话栏后看不到别的会话的绿点（有新回复），在开关按钮上补一个
  const unreadElsewhere = countUnreadElsewhere(views.flatMap((v) => v.tabs), (key) => sameChatSession(key, selected), sessionStatus)
  const sidebarToggle = (
    <button
      type="button"
      onClick={toggleSidebar}
      title={sidebarToggleTitle(sidebarCollapsed, unreadElsewhere)}
      aria-label="会话栏"
      aria-expanded={!sidebarCollapsed}
      className={`relative shrink-0 rounded p-1 transition hover:bg-raised hover:text-fg-soft ${sidebarCollapsed ? "text-fg-muted" : "bg-raised text-accent"}`}
    >
      <PanelLeft size={15} />
      {sidebarCollapsed && unreadElsewhere > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success" />}
    </button>
  )

  // 新建会话后选中的是它，列表要滚到它那里；只认选中变化，后台刷新多出几个会话不该把用户正在翻的位置拽回去
  const sidebarListRef = useRef<HTMLDivElement>(null)
  useScrollActiveIntoView(sidebarListRef, selected, 0)

  return (
    <PreviewContext.Provider value={preview.api}>
    <div className="flex h-screen flex-col">
      <TitleBar center={<PageTabs page="chat" onChange={onSwitchPage} />} actions={<TitleActions onSettings={onSettings} active={active} />}>
        <TitleBrand />
      </TitleBar>

      {noChannel ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-fg-muted">
          <p>{issueText.message}</p>
          <button type="button" onClick={() => onSettings("channel")} className="rounded-lg bg-blue-600 px-4 py-2 text-xs text-white transition hover:bg-blue-500">{issueText.settingsLabel}</button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：会话列表（可收起；用 hidden 而不是卸载，展开后列表滚动位置还在） */}
          <aside className={`${sidebarCollapsed ? "hidden" : "flex"} w-60 shrink-0 flex-col border-r border-line-subtle bg-surface`}>
            <div ref={sidebarListRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
              {views.map((v) => (
                <div key={v.channelId}>
                  {/* 新会话 / 新项目在分组顶部，滚动时粘在列表上沿：会话再多也不用滚到底才能新建 */}
                  <div data-sticky-head className="sticky top-0 z-10 bg-surface pb-1.5 pt-2">
                    {views.length > 1 && <p className="px-2 pb-1 text-[11px] text-fg-faint">{v.name}</p>}
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => void newSession(v.channelId)}
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted transition hover:border-line-strong hover:bg-raised/40 hover:text-fg-2"
                      ><Plus size={14} />新会话</button>
                      <button
                        type="button"
                        onClick={() => setNewProjectFor(v.channelId)}
                        title="按一套做事的流程（调研、写作、周报……）建一个项目"
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted transition hover:border-line-strong hover:bg-raised/40 hover:text-fg-2"
                      ><FolderKanban size={13} />新项目</button>
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    {listOrder(v.tabs).map((t) => {
                      const on = sameChatSession(t.sessionKey, selected)
                      const at = activeAt(t)
                      const pinned = pins.isPinned(t.sessionKey)
                      const status = sessionStatus(t.sessionKey, t.running)
                      // 项目会话背后是项目本身，删除走 /p del，不在对话页里处理
                      const deletable = !!t.removable && t.kind !== "project"
                      return (
                        <div key={t.sessionKey} className="group/row relative">
                          <button
                            type="button"
                            onClick={() => setSelected(t.sessionKey)}
                            aria-current={on ? "true" : undefined}
                            title={dirOf(t) ?? sessionName(t)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${on ? "bg-strong/50 font-medium text-fg" : "text-fg-3 hover:bg-strong/25 hover:text-fg-soft"}`}
                          >
                            {status === "working" ? (
                              <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
                            ) : (
                              <span className="relative shrink-0">
                                {t.kind === "project"
                                  ? <FolderKanban size={14} className="text-fg-faint" />
                                  : <MessageCircle size={14} className="text-fg-faint" />}
                                {status === "unread" && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success" />}
                              </span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{sessionName(t)}</span>
                            {pinned && <Pin size={11} aria-label="已置顶" className="shrink-0 text-accent group-hover/row:invisible" />}
                            {at !== undefined && (
                              <span className="shrink-0 text-[11px] font-normal text-fg-faint group-hover/row:invisible">{formatTimeAgo(at, now)}</span>
                            )}
                          </button>
                          <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center rounded bg-raised group-hover/row:flex">
                            <button
                              type="button"
                              onClick={() => pins.toggle(t.sessionKey)}
                              title={pinned ? "取消置顶" : "置顶会话"}
                              aria-label={pinned ? "取消置顶" : "置顶会话"}
                              className="rounded p-1 text-fg-muted transition hover:text-accent"
                            >{pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                            {deletable && (
                              <button
                                type="button"
                                onClick={() => void deleteSession(t)}
                                title="删除会话"
                                className="rounded p-1 text-fg-muted transition hover:text-danger"
                              ><Trash2 size={13} /></button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {treeError && <p className="px-2 text-[11px] text-yellow-500">{treeError}</p>}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-line-subtle px-3 py-2 text-[11px] text-fg-faint">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => onSettings("mobile")}
                  title="手机端扫码配对与远程访问"
                  className="inline-flex items-center gap-1 text-fg-muted transition hover:text-accent"
                >
                  <Smartphone size={12} />手机端
                </button>
                <span title="对话记录占用的本机磁盘空间">{usageBytes == null ? "" : `记录 ${fmtBytes(usageBytes)}`}</span>
              </div>
              <button type="button" onClick={() => void clearAll()} className="transition hover:text-danger">清空全部</button>
            </div>
          </aside>

          {/* 右：对话区 */}
          <section className="flex min-w-0 flex-1 flex-col">
            {selected && tab ? (
              <>
                <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line-subtle px-6">
                  {sidebarToggle}
                  <div className="min-w-0 flex-1">
                    <SessionTitle key={selected} name={sessionName(tab)} onRename={tab.kind === "project" ? undefined : (name) => void renameSession(name)} />
                  </div>
                  <button
                    type="button"
                    onClick={preview.togglePanel}
                    title={preview.state.tabs.length === 0 ? "打开内置浏览器" : preview.state.open ? "收起预览面板" : "展开预览面板"}
                    className={`relative rounded p-1 transition hover:bg-raised hover:text-fg-soft ${preview.state.open ? "bg-raised text-accent" : "text-fg-muted"}`}
                  >
                    <PanelRight size={15} />
                    {preview.state.tabs.length > 0 && !preview.state.open && (
                      <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-blue-600 px-1 text-center text-[9px] leading-[14px] text-white">{preview.state.tabs.length}</span>
                    )}
                  </button>
                  <div className="relative shrink-0" ref={moreMenuRef}>
                    <button type="button" onClick={() => setMoreMenuOpen((o) => !o)} title="更多" className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-soft"><MoreHorizontal size={15} /></button>
                    {moreMenuOpen && (
                      <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded border border-line bg-page py-1 shadow-lg">
                        <p className="px-3 pb-0.5 pt-1 text-[11px] text-fg-faint">点击链接时用</p>
                        {([["internal", "内置浏览器"], ["external", "系统浏览器"]] as const).map(([mode, label]) => (
                          <button key={mode} type="button" onClick={() => { preview.setLinkMode(mode); setMoreMenuOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-surface">
                            <span className="flex w-3 justify-center">{preview.linkMode === mode && <Check size={12} className="text-accent" />}</span>{label}
                          </button>
                        ))}
                        <p className="px-3 pb-1 text-[10px] leading-snug text-fg-faint">按住 Ctrl 点击则用另一个</p>
                        <div className="my-1 border-t border-line-subtle" />
                        <button type="button" onClick={() => void clearSession()} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-danger hover:bg-surface"><Trash2 size={12} />清空本会话记录</button>
                      </div>
                    )}
                  </div>
                </div>

                <ChatItemList key={selected} items={items} loading={loading} hasMore={hasMore} loadingEarlier={loadingEarlier} onLoadEarlier={() => void loadEarlier()} busy={busy} workspaceName={dirName(workspaceDir)} projectName={projectId ? tab.label : undefined} onAnswer={(q, o) => void answer(q, o)} onCommand={(c) => void send(c)} />
                {(actionError || historyError) && <p className="shrink-0 px-6 pb-1 text-center text-xs text-danger">{actionError || historyError}</p>}
                <Composer
                  draftKey={composerDraftKey(selected)}
                  disabled={!selected}
                  busy={busy}
                  top={
                    <>
                      {projectId && ownerView && (
                        <ProjectBar
                          key={projectId}
                          channelId={ownerView.channelId}
                          projectId={projectId}
                          running={!!tab.running}
                          confirm={showConfirm}
                          onStarted={() => { window.setTimeout(() => { void refresh() }, 600) }}
                          onDeleted={() => void projectDeleted(tab)}
                          onError={setActionError}
                        />
                      )}
                      <SessionSchedules sessionKey={selected} active={active} confirm={showConfirm} onOpenSettings={() => onSettings("tasks")} />
                      <QueuedStrip items={queuedItems} onEdit={editQueued} onRemove={removeQueued} onSendNow={sendQueuedNow} />
                    </>
                  }
                  below={!projectId ? (
                    // 目录和分支决定「在哪干活」，放在输入框下方，和输入框里「怎么回答」的模型分开。
                    // 项目会话的目录和分支是项目自己的（项目栏里看），在这里选目录只会另开一个无关的新会话，所以不显示
                    <>
                      <DirPicker
                        currentName={dirName(workspaceDir)}
                        options={dirOptions}
                        isCurrent={(dir) => sameChatDir(dir, workspaceDir)}
                        onSelect={(dir) => void chooseDir(dir)}
                        onPickNew={() => void pickNewDir()}
                        hint={canRebindDir ? "为这个会话选择工作目录，多个会话可以共用同一个目录" : "会话开始后目录不再更换，选择目录会用它新开一个会话"}
                      />
                      {tab.branch && workspaceDir && canSwitchBranch(tab.kind) && (
                        <BranchPicker
                          key={selected}
                          sessionKey={selected}
                          branch={tab.branch}
                          shared={branchShared}
                          working={branchWorking}
                          onSwitched={() => void refresh()}
                          onError={setActionError}
                        />
                      )}
                    </>
                  ) : undefined}
                  footer={
                    <>
                      <ModelPicker
                        resources={resources}
                        currentResourceId={tab.resourceId ?? ownerView?.agentResourceId}
                        currentModel={tab.model}
                        currentParams={tab.modelParams}
                        currentLabel={modelLabel}
                        quickModels={quickModels}
                        favorites={favorites}
                        onToggleFavorite={toggleFavorite}
                        onOpen={() => void refreshModels()}
                        placeholder="默认模型"
                        switching={modelBusy}
                        onSelect={(m) => void switchModel(m)}
                      />
                    </>
                  }
                  onSend={(t, imgs) => void send(t, imgs)}
                  onStop={() => void stop()}
                  onError={setActionError}
                />
              </>
            ) : (
              <>
                {/* 没选中会话时也要有开关：会话栏收起的话，这里是唯一能把它展开的地方 */}
                <div className="flex h-12 shrink-0 items-center border-b border-line-subtle px-6">{sidebarToggle}</div>
                <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">
                  {emptySessionHint(loaded, sidebarCollapsed)}
                </div>
              </>
            )}
          </section>
          <PreviewPanel controller={preview} visible={active} />
        </div>
      )}
      {newProjectFor && (
        <NewProjectDialog
          channelId={newProjectFor}
          onClose={() => setNewProjectFor(null)}
          onCreated={projectCreated}
          // 先关对话框再跳：对话框是盖在对话页上的弹层，留着会让内置浏览器视图一直让位
          onOpenTemplateSettings={() => { setNewProjectFor(null); onSettings(PROJECT_TEMPLATES_TARGET) }}
        />
      )}
      {ModalPortal}
    </div>
    </PreviewContext.Provider>
  )
}
