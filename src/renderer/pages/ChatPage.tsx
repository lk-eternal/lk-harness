import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { ChevronDown, FolderOpen, Loader2, MessageCircle, MoreHorizontal, Plus, Trash2 } from "lucide-react"
import TitleBar from "../components/TitleBar"
import TitleBrand from "../components/TitleBrand"
import TitleActions from "../components/TitleActions"
import PageTabs, { type MainPage } from "../components/PageTabs"
import useInlineModal from "../components/useInlineModal"
import ChatItemList from "../components/chat/ChatItemList"
import Composer from "../components/chat/Composer"
import { sameChatSession, useAppChatItems } from "../components/chat/useAppChatItems"
import { appChatSessionId } from "../../shared/app-chat-types"
import { APP_CHANNEL_CHAT_ID, makeChatKey, workspaceDirFromSessionKey } from "../../shared/channel-types"
import { modelSlug } from "../model-utils"
import { formatTimeAgo } from "../time-ago"

type Tree = Awaited<ReturnType<typeof window.electronAPI.listDashboardTree>>
type ChatTab = Tree["channels"][number]["mainTabs"][number]
type QuickModel = { model: string; modelParams?: string; label?: string; resourceId?: string }

interface AppChannelView {
  channelId: string
  name: string
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

function dirName(dir: string | undefined): string | undefined {
  return dir?.split(/[\\/]/).filter(Boolean).pop()
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 菜单打开时，点到容器外面就关闭 */
function useOutsideClose(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open, ref, close])
}

export default function ChatPage({ active, onSwitchPage, onSettings }: Props) {
  const [views, setViews] = useState<AppChannelView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [treeError, setTreeError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [quickModels, setQuickModels] = useState<QuickModel[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [usageBytes, setUsageBytes] = useState<number | null>(null)
  const [actionError, setActionError] = useState("")
  const [titles, setTitles] = useState<Record<string, string>>({})
  /** 会话最近一条记录的时间，键为 appChatSessionId；now 随每次刷新更新，用来算「多久前」 */
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  const [now, setNow] = useState(() => Date.now())
  const busyRef = useRef(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const viewsRef = useRef<AppChannelView[]>([])
  viewsRef.current = views
  const { showConfirm, ModalPortal } = useInlineModal()

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const [cfg, tree] = await Promise.all([
        window.electronAPI.getConfig(),
        window.electronAPI.listDashboardTree(),
      ])
      const appNames = new Map((cfg.channels ?? []).filter((c) => c.type === "app" && c.enabled !== false).map((c) => [c.id, c.name]))
      const appChannels = tree.channels.filter((c) => appNames.has(c.channelId))
      const active = await window.electronAPI.appChatLastActive(appChannels.flatMap((c) => c.mainTabs.map((t) => t.sessionKey)))
      if (active.ok) setLastActive(active.times ?? {})
      setNow(Date.now())
      setViews(appChannels.map((c) => ({ channelId: c.channelId, name: appNames.get(c.channelId) ?? c.name, tabs: c.mainTabs, activeKey: c.activeKey })))
      setTreeError(tree.ok ? "" : (tree.error ?? "读取会话失败"))
    } catch (e: unknown) {
      setTreeError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setLoaded(true)
    }
  }, [])

  const refreshModels = useCallback(async () => {
    const r = await window.electronAPI.listQuickModels()
    if (r.ok) setQuickModels(r.models)
  }, [])

  // 可见时：立即刷新 + 定时兜底 + 会话进程变化推送
  useEffect(() => {
    if (!active) return
    void refresh()
    void refreshModels()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    const unsub = window.electronAPI.onSessionAgents(() => void refresh())
    return () => { window.clearInterval(timer); unsub() }
  }, [active, refresh, refreshModels])

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

  const closeModelMenu = useCallback(() => setModelMenuOpen(false), [])
  const closeMoreMenu = useCallback(() => setMoreMenuOpen(false), [])
  useOutsideClose(modelMenuOpen, modelMenuRef, closeModelMenu)
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

  const { items, loading, error: historyError } = useAppChatItems(selected)

  const ownerView = views.find((v) => v.tabs.some((t) => sameChatSession(t.sessionKey, selected)))
  const tab = ownerView?.tabs.find((t) => sameChatSession(t.sessionKey, selected))
  const workspaceDir = selected ? workspaceDirFromSessionKey(selected) : undefined
  /** 会话名：摘要标题；还没有时显示目录名（不带「（主）」和分支） */
  const sessionName = (t: ChatTab) => titles[appChatSessionId(t.sessionKey)] ?? dirName(workspaceDirFromSessionKey(t.sessionKey)) ?? t.label
  const activeAt = (t: ChatTab): number | undefined => lastActive[appChatSessionId(t.sessionKey)]
  /** 最近有对话的排前面；没有记录的保持原顺序排在后面 */
  const byRecent = (tabs: ChatTab[]) => [...tabs].sort((a, b) => (activeAt(b) ?? 0) - (activeAt(a) ?? 0))
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

  const deleteSession = async (t: ChatTab) => {
    const effect = t.kind === "main"
      ? "这是主目录会话：会停止 Agent、清除上下文和聊天记录，之后以空会话保留在列表里。"
      : "会停止 Agent、清除上下文和聊天记录，并从常用目录中移除。"
    if (!await showConfirm("删除会话", `确定删除「${sessionName(t)}」吗？\n${effect}`, "删除")) return
    const r = await window.electronAPI.appChatDeleteSession(t.sessionKey)
    if (!r.ok) { setActionError(r.error ?? "删除失败"); return }
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

  /** 停止并清空本会话排队消息，等价于 /x -c */
  const stop = async () => {
    if (!selected) return
    await window.electronAPI.stopSessionAgent(selected, true)
    void refresh()
  }

  const switchModel = async (m: QuickModel) => {
    if (!selected || modelBusy) return
    setModelMenuOpen(false)
    setModelBusy(true)
    try {
      const r = await window.electronAPI.setSessionModel(selected, m.model, m.modelParams, m.resourceId)
      if (!r.ok) setActionError(r.error ?? "切换模型失败")
      await refresh()
    } finally {
      setModelBusy(false)
    }
  }

  /** 新会话 = 选目录并加入该通道的常用目录，会话在首次发送时由 Agent 侧建立 */
  const addSession = async (channelId: string) => {
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const r = await window.electronAPI.addChannelFavoriteWorkspace(channelId, dir)
    if (!r.ok) { setActionError(r.error ?? "添加目录失败"); return }
    await refresh()
    const target = `${appChatSessionId(makeChatKey(channelId, APP_CHANNEL_CHAT_ID))}::${dir.replace(/[\\/]+/g, "/").toLowerCase()}`
    const fresh = (await window.electronAPI.listDashboardTree()).channels
      .find((c) => c.channelId === channelId)?.mainTabs
      .find((t) => appChatSessionId(t.sessionKey) === target)
    if (fresh) setSelected(fresh.sessionKey)
    else setActionError("目录已添加，但会话列表中暂未出现，请稍后刷新")
  }

  // 会话进程在线 ≠ AI 在干活（回复完 Agent 仍挂在 poll 上）：以未收口的回合卡 / 待处理的用户消息为准
  const hasLiveTurn = items.some((it) => it.kind === "assistant" && !it.finished)
  const busy = !!tab?.running && (hasLiveTurn || items[items.length - 1]?.kind === "user")
  const noChannel = loaded && views.length === 0

  return (
    <div className="flex h-screen flex-col">
      <TitleBar center={<PageTabs page="chat" onChange={onSwitchPage} />} actions={<TitleActions onSettings={onSettings} />}>
        <TitleBrand />
      </TitleBar>

      {noChannel ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-fg-muted">
          <p>还没有「应用内对话」通道</p>
          <button type="button" onClick={() => onSettings("channel")} className="rounded-lg bg-blue-600 px-4 py-2 text-xs text-white transition hover:bg-blue-500">去设置里添加</button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：会话列表 */}
          <aside className="flex w-60 shrink-0 flex-col border-r border-line-subtle bg-surface">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
              {views.map((v) => (
                <div key={v.channelId}>
                  {views.length > 1 && <p className="px-2 pb-1 text-[11px] text-fg-faint">{v.name}</p>}
                  <div className="space-y-0.5">
                    {byRecent(v.tabs).map((t) => {
                      const on = sameChatSession(t.sessionKey, selected)
                      const at = activeAt(t)
                      // 项目会话背后是项目本身，删除走 /p del，不在对话页里处理
                      const deletable = !!t.removable && t.kind !== "project"
                      return (
                        <div key={t.sessionKey} className="group/row relative">
                          <button
                            type="button"
                            onClick={() => setSelected(t.sessionKey)}
                            title={workspaceDirFromSessionKey(t.sessionKey) ?? sessionName(t)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition ${on ? "bg-strong/50 font-medium text-fg" : "text-fg-3 hover:bg-strong/25 hover:text-fg-soft"}`}
                          >
                            <MessageCircle size={14} className="shrink-0 text-fg-faint" />
                            <span className="min-w-0 flex-1 truncate">{sessionName(t)}</span>
                            {at !== undefined && (
                              <span className={`shrink-0 text-[11px] font-normal text-fg-faint ${deletable ? "group-hover/row:invisible" : ""}`}>{formatTimeAgo(at, now)}</span>
                            )}
                          </button>
                          {deletable && (
                            <button
                              type="button"
                              onClick={() => void deleteSession(t)}
                              title="删除会话"
                              className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded bg-raised p-1 text-fg-muted transition hover:text-danger group-hover/row:block"
                            ><Trash2 size={13} /></button>
                          )}
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => void addSession(v.channelId)}
                      className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted transition hover:border-line-strong hover:bg-raised/40 hover:text-fg-2"
                    ><Plus size={14} />新会话（选择目录）</button>
                  </div>
                </div>
              ))}
              {treeError && <p className="px-2 text-[11px] text-yellow-500">{treeError}</p>}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-line-subtle px-3 py-2 text-[11px] text-fg-faint">
              <span title="对话记录占用的本机磁盘空间">{usageBytes == null ? "" : `记录 ${fmtBytes(usageBytes)}`}</span>
              <button type="button" onClick={() => void clearAll()} className="transition hover:text-danger">清空全部</button>
            </div>
          </aside>

          {/* 右：对话区 */}
          <section className="flex min-w-0 flex-1 flex-col">
            {selected && tab ? (
              <>
                <div className="flex shrink-0 items-center gap-3 border-b border-line-subtle px-6 py-2">
                  <FolderOpen size={14} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{sessionName(tab)}</p>
                    {workspaceDir && <p className="truncate text-[11px] text-fg-faint" title={workspaceDir}>{workspaceDir}</p>}
                  </div>
                  <div className="relative shrink-0" ref={modelMenuRef}>
                    <button
                      type="button"
                      onClick={() => setModelMenuOpen((o) => !o)}
                      className="inline-flex max-w-[12rem] items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-violet transition hover:border-violet-500"
                      title="切换本会话模型"
                    >
                      {modelBusy && <Loader2 size={10} className="animate-spin" />}
                      <span className="truncate">{modelLabel}</span>
                      <ChevronDown size={10} />
                    </button>
                    {modelMenuOpen && (
                      <div className="absolute right-0 top-full z-20 mt-1 max-h-60 w-56 overflow-auto rounded border border-line bg-page py-1 shadow-lg">
                        {quickModels.length === 0 && <div className="px-2 py-1 text-[11px] text-fg-faint">暂无常用模型（可在首页添加）</div>}
                        {quickModels.map((m) => {
                          const cur = tab.model === m.model && (tab.modelParams ?? "") === (m.modelParams ?? "")
                          return (
                            <button
                              key={`${m.model}\0${m.modelParams ?? ""}\0${m.resourceId ?? ""}`}
                              type="button"
                              onClick={() => void switchModel(m)}
                              className={`block w-full truncate px-2 py-1 text-left text-[11px] hover:bg-violet-tint/50 ${cur ? "text-violet" : "text-fg-2"}`}
                            >{m.label || modelSlug(m.model, m.modelParams)}</button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="relative shrink-0" ref={moreMenuRef}>
                    <button type="button" onClick={() => setMoreMenuOpen((o) => !o)} title="更多" className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-soft"><MoreHorizontal size={15} /></button>
                    {moreMenuOpen && (
                      <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-line bg-page py-1 shadow-lg">
                        <button type="button" onClick={() => void clearSession()} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-danger hover:bg-surface"><Trash2 size={12} />清空本会话记录</button>
                      </div>
                    )}
                  </div>
                </div>

                <ChatItemList key={selected} items={items} loading={loading} busy={busy} onAnswer={(q, o) => void answer(q, o)} onCommand={(c) => void send(c)} />
                {(actionError || historyError) && <p className="shrink-0 px-6 pb-1 text-center text-xs text-danger">{actionError || historyError}</p>}
                <Composer disabled={!selected} busy={busy} onSend={(t, imgs) => void send(t, imgs)} onStop={() => void stop()} onError={setActionError} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">
                {loaded ? "← 选择会话，或新建一个" : "加载中…"}
              </div>
            )}
          </section>
        </div>
      )}
      {ModalPortal}
    </div>
  )
}
