import { useState, useEffect, useCallback, useRef } from "react"
import {
  Plus, Loader2, CheckCircle2, ShieldAlert, Eye, EyeOff, Trash2,
  LogIn, MessageSquare, Bird, FolderOpen, ExternalLink, MonitorSmartphone,
} from "lucide-react"
import { CHANNEL_TYPE_LABELS, type ChannelType } from "../../shared/channel-types"
import { holdBackModelEdits, type ChannelModelImpact } from "../../shared/channel-model-impact"
import { saveChannelWithImpact, type ImpactChoice } from "../../shared/channel-save-flow"
import { emptyChannel } from "../channel-defaults"
import ChannelModelImpactDialog from "./ChannelModelImpactDialog"
import ModelPicker from "./chat/ModelPicker"
import { useModelFavorites } from "../hooks/useModelFavorites"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_ADD_BAR, PANEL_ADD_BTN, PANEL_MAIN, PANEL_SCROLL_FLAT, PANEL_FOOTER } from "./panel-layout"
import { useScrollActiveIntoView } from "./panel-scroll"
import { useOpenFirstOnce } from "./panel-default"
import PanelAddMenu from "./PanelAddMenu"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"
const sectionCls = "mt-5 space-y-3 border-t border-line-subtle pt-5 pb-5"
/** tab 内首个分组：去顶部隔线，保留间隙 */
const sectionFirstCls = "mt-5 space-y-3 pt-5 pb-5"

export default function ChannelPanel() {
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [channelsReady, setChannelsReady] = useState(false)
  const [resources, setResources] = useState<AgentResource[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, ChannelStatusInfo>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ChannelConfig | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNewChannel, setIsNewChannel] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const { showAlert, showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  /** 保存时「其他人的默认模型要变了」的确认框；resolve 之前保存流程一直停在这里 */
  const [impactAsk, setImpactAsk] = useState<{ channelName: string; impact: ChannelModelImpact; resolve: (c: ImpactChoice | null) => void } | null>(null)

  const reload = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    // 旧迁移通道可能缺少通道级字段，展示时兜底
    setChannels((cfg.channels ?? []).map((c) => ({
      ...c,
      allowOthers: c.allowOthers ?? cfg.allowOthers ?? false,
      digitalIdentity: c.digitalIdentity ?? cfg.digitalIdentity ?? "",
    })))
    setResources(cfg.agentResources ?? [])
    setChannelsReady(true)
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const sync = (s: DaemonStatus) => {
      if (!s.channels) return
      const m: Record<string, ChannelStatusInfo> = {}
      for (const c of s.channels) m[c.id] = c
      setStatusMap(m)
    }
    window.electronAPI.getDaemonStatus().then(sync)
    const unsub = window.electronAPI.onDaemonStatus(sync)
    return () => unsub()
  }, [])

  const persistChannels = async (next: ChannelConfig[]) => {
    setChannels(next)
    await window.electronAPI.saveConfig({ channels: next })
  }

  const handleToggle = async (id: string) => {
    await persistChannels(channels.map((c) => c.id === id ? { ...c, enabled: !c.enabled } : c))
  }

  const handleDelete = async (c: ChannelConfig) => {
    if (!await showConfirm("删除确认", `确定删除通道「${c.name}」吗？该通道的消息将不再接收。`)) return
    await persistChannels(channels.filter((x) => x.id !== c.id))
  }

  const openDraft = (c: ChannelConfig, isNew: boolean) => {
    setSelectedId(c.id)
    setDraft({ ...c })
    setSavedSnapshot(JSON.stringify(c))
    setIsNewChannel(isNew)
  }

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const selectChannel = async (c: ChannelConfig) => {
    if (!(await guardUnsaved("保存并切换"))) return
    openDraft(c, false)
  }

  const openAdd = async (type: ChannelType) => {
    if (!(await guardUnsaved("保存并继续"))) return
    setShowAddMenu(false)
    const count = channels.filter((c) => c.type === type).length
    const base = CHANNEL_TYPE_LABELS[type]
    openDraft(emptyChannel(type, count > 0 ? `${base} ${count + 1}` : base), true)
  }

  const handleCancel = async () => {
    if (!(await guardUnsaved("保存", "放弃"))) return
    if (isNewChannel) {
      setSelectedId(null)
      setDraft(null)
      setIsNewChannel(false)
      return
    }
    const saved = channels.find((c) => c.id === selectedId)
    if (saved) openDraft(saved, false)
    else { setSelectedId(null); setDraft(null) }
  }

  /**
   * 落库。withModels = 点「保存」时才带上模型相关的改动；绑定 / 测试这类「先落库」的途径不带
   * （已存在的通道里，模型字段保持已保存的值，这样模型改动没法绕过保存时的影响提示；界面上仍显示未保存）。
   */
  const persistDraft = async (c: ChannelConfig, withModels = false) => {
    const saved = channels.find((x) => x.id === c.id)
    const toSave = saved && !withModels ? holdBackModelEdits(c, saved) : c
    const updated = saved ? channels.map((x) => x.id === c.id ? toSave : x) : [...channels, toSave]
    await persistChannels(updated)
    setSavedSnapshot(JSON.stringify(toSave))
  }

  const handleSave = async (next: ChannelConfig) => {
    if (next.allowOthers) {
      const effOthers = next.othersAgentResourceId?.trim() || next.agentResourceId
      if (effOthers !== next.agentResourceId && !next.othersModel?.trim()) {
        void showAlert("提示", "其他人资源与主用户不同，请先为其他人选择模型（不可跟随）")
        return false
      }
    }
    // 保存前问一句其他人的默认模型会不会变、已有会话怎么处理；清除 → 保存 → 停止的顺序和失败处理见 saveChannelWithImpact
    const r = await saveChannelWithImpact(
      next.id,
      next,
      {
        preview: (id, draft) => window.electronAPI.previewChannelModelImpact(id, draft),
        ask: (impact) => new Promise<ImpactChoice | null>((resolve) => setImpactAsk({ channelName: next.name, impact, resolve })),
        clear: (id) => window.electronAPI.clearOthersModelOverrides(id),
        stop: (id) => window.electronAPI.stopOthersFollowingDefault(id),
      },
      async () => {
        await persistDraft(next, true)
        markSaved()
        openDraft(next, false)
        setIsNewChannel(false)
      },
    )
    if (!r.saved) return false
    if (r.lines.length > 0) void showAlert("设置已保存", r.lines.join("\n"))
    return true
  }

  /** 未保存守卫：保存并继续 / 丢弃 / 取消 */
  const guardUnsaved = async (saveLabel: string, discardLabel = "丢弃") => {
    if (!isDirty || !draft) return true
    const choice = await showUnsavedChoice("未保存", "当前通道有未保存的修改，怎么办？", { save: saveLabel, discard: discardLabel })
    if (choice === "cancel") return false
    if (choice === "save") return handleSave(draft)
    return true
  }

  /** 删除通道后清理规则生效范围中的死目标（targets 为空即不生效，不回退；失败不阻断删通道） */
  const pruneRuleTargets = async (channelId: string) => {
    try {
      const rs = await window.electronAPI.getHarnessRules()
      for (const r of rs ?? []) {
        if (r.scope?.mode !== "custom" || !(r.scope.targets ?? []).some((t) => t.channelId === channelId)) continue
        const targets = (r.scope.targets ?? []).filter((t) => t.channelId !== channelId)
        await window.electronAPI.saveHarnessRule(r.id, r.name, r.content, r.enabled, { mode: "custom", targets })
      }
    } catch { /* ignore */ }
  }

  const handleDeleteCurrent = async () => {
    if (!draft || isNewChannel) return
    if (!await showConfirm("删除确认", `确定删除通道「${draft.name}」吗？`)) return
    const deletedId = draft.id
    const next = channels.filter((x) => x.id !== deletedId)
    await persistChannels(next)
    void pruneRuleTargets(deletedId)
    setSelectedId(null)
    setDraft(null)
    setIsNewChannel(false)
  }

  const listRef = useRef<HTMLDivElement>(null)
  useScrollActiveIntoView(listRef, selectedId, channels.length)
  useOpenFirstOnce(channelsReady, channels, selectedId !== null || draft !== null, (c) => openDraft(c, false))

  return (
    <>
      <div className={PANEL_ROOT}>
        {/* 左侧通道列表（固定，独立滚动）；「添加」在列表外面，列表再长也看得见 */}
        <aside className={PANEL_ASIDE}>
          <div className={`relative ${PANEL_ADD_BAR}`} ref={addMenuRef}>
            <button
              type="button"
              onClick={() => setShowAddMenu(!showAddMenu)}
              className={PANEL_ADD_BTN}
            >
              <Plus size={14} />添加
            </button>
            <PanelAddMenu open={showAddMenu} anchorRef={addMenuRef} onClose={() => setShowAddMenu(false)}>
              <button type="button" onClick={() => openAdd("feishu")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-raised"><Bird size={12} className="text-accent" />飞书</button>
              <button type="button" onClick={() => openAdd("wechat")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-raised"><MessageSquare size={12} className="text-success" />微信</button>
              <button type="button" onClick={() => openAdd("app")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-2 hover:bg-raised"><MonitorSmartphone size={12} className="text-purple" />应用内对话</button>
            </PanelAddMenu>
          </div>
          <div ref={listRef} className={PANEL_LIST}>
            {channels.map((c) => {
              const st = statusMap[c.id]
              const active = selectedId === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void selectChannel(c)}
                  aria-current={active ? "true" : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ${active ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}
                >
                  {c.type === "feishu"
                    ? <Bird size={14} className="shrink-0 text-accent" />
                    : c.type === "wechat"
                      ? <MessageSquare size={14} className="shrink-0 text-success" />
                      : <MonitorSmartphone size={14} className="shrink-0 text-purple" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{c.name}</p>
                    <p className="truncate text-[10px] text-fg-faint">{st?.connected ? "已连接" : c.enabled ? "未连接" : "已停用"}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        {/* 右侧编辑区（独立滚动） */}
        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <ChannelDetailForm
                channel={draft}
                isNew={isNewChannel}
                resources={resources}
                onChange={setDraft}
                onSaveDraft={(c) => persistDraft(c)}
                showAlert={showAlert}
                showConfirm={showConfirm}
              />
              <div className={PANEL_FOOTER}>
                <div className="flex items-center gap-2">
                  {!isNewChannel && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleDeleteCurrent()}
                        className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger-tint/30"
                      ><Trash2 size={13} />删除</button>
                      <button
                        type="button"
                        onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                        className={`rounded-md px-2.5 py-1.5 text-xs transition ${draft.enabled ? "text-success hover:bg-raised" : "text-fg-muted hover:bg-raised"}`}
                      >{draft.enabled ? "已启用" : "已停用"}</button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-fg-3 transition hover:bg-raised hover:text-fg">取消</button>
                  <button onClick={() => void handleSave(draft)} disabled={!draft.name.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">← 选择通道</div>
          )}
        </div>
      </div>
      {ModalPortal}
      {impactAsk && (
        <ChannelModelImpactDialog
          channelName={impactAsk.channelName}
          impact={impactAsk.impact}
          onDone={(choice) => {
            impactAsk.resolve(choice)
            setImpactAsk(null)
          }}
        />
      )}
    </>
  )
}

// ── 通道详情表单（内嵌于二级导航右侧） ──────────────────────

interface DetailProps {
  channel: ChannelConfig
  isNew: boolean
  resources: AgentResource[]
  onChange: (c: ChannelConfig) => void
  /** 保存但不校验（绑定主用户前需先落库） */
  onSaveDraft: (c: ChannelConfig) => Promise<void>
  showAlert: (title: string, message: string) => Promise<void>
  showConfirm: (title: string, message: string, okLabel?: string, cancelLabel?: string) => Promise<boolean>
}

/** 通道名仍是默认占位（"飞书"/"飞书 2"…）时允许用解析出的应用名自动覆盖 */
function isDefaultChannelName(name: string): boolean {
  return !name.trim() || /^飞书( \d+)?$/.test(name.trim()) || /^微信( \d+)?$/.test(name.trim())
}

function ChannelDetailForm({ channel, isNew, resources, onChange, onSaveDraft, showAlert, showConfirm }: DetailProps) {
  const draft = channel
  const set = (p: Partial<ChannelConfig>) => onChange({ ...draft, ...p })
  const [showSecret, setShowSecret] = useState(false)
  const [appInfoState, setAppInfoState] = useState<{ checking: boolean; error?: string }>({ checking: false })
  const [binding, setBinding] = useState(false)
  const [testing, setTesting] = useState(false)
  // 飞书一键创建
  const [feishuQrUrl, setFeishuQrUrl] = useState("")
  const [feishuQrStatus, setFeishuQrStatus] = useState<"idle" | "loading" | "wait" | "error">("idle")
  const [feishuQrMsg, setFeishuQrMsg] = useState("")
  const [registerForm, setRegisterForm] = useState<{ name: string; desc: string } | null>(null)
  // 微信扫码
  const [wechatQrUrl, setWechatQrUrl] = useState("")
  const [wechatQrStatus, setWechatQrStatus] = useState<"idle" | "loading" | "wait" | "scaned" | "error">("idle")
  const [wechatQrMsg, setWechatQrMsg] = useState("")
  const wechatQrBusy = useRef(false)

  const [activeTab, setActiveTab] = useState<"main" | "others">("main")
  const othersResourceId = draft.othersAgentResourceId?.trim() || draft.agentResourceId
  /** 其他人模型"跟随"仅同源时成立 */
  const sameResource = othersResourceId === draft.agentResourceId
  const { quickModels, favorites, refresh: refreshModels, toggleFavorite } = useModelFavorites()

  // 飞书一键创建应用
  useEffect(() => {
    const unsub1 = window.electronAPI.onFeishuSetupQrCode((url) => { setFeishuQrUrl(url); setFeishuQrStatus("wait") })
    const unsub2 = window.electronAPI.onFeishuSetupStatus(() => {})
    return () => { unsub1(); unsub2() }
  }, [])

  // 凭据齐全时自动解析应用名（防抖），默认通道名自动替换为应用名
  const appId = draft.type === "feishu" ? (draft.larkAppId?.trim() ?? "") : ""
  const appSecret = draft.type === "feishu" ? (draft.larkAppSecret?.trim() ?? "") : ""
  useEffect(() => {
    if (!appId || !appSecret) { setAppInfoState({ checking: false }); return }
    let cancelled = false
    const t = setTimeout(async () => {
      setAppInfoState({ checking: true })
      const r = await window.electronAPI.fetchFeishuAppInfo(appId, appSecret)
      if (cancelled) return
      if (r.ok && r.name) {
        setAppInfoState({ checking: false })
        onChange({
          ...draft,
          larkBotName: r.name,
          name: isDefaultChannelName(draft.name) ? r.name! : draft.name,
        })
      } else {
        setAppInfoState({ checking: false, error: r.error })
        onChange({ ...draft, larkBotName: "" })
      }
    }, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [appId, appSecret])

  const openRegisterForm = () => {
    setRegisterForm({
      name: !isDefaultChannelName(draft.name) ? draft.name.trim() : "LK Harness",
      desc: "IM Agent 协作助手",
    })
  }

  const startFeishuRegister = async (preset: { name: string; desc: string }) => {
    setRegisterForm(null)
    setFeishuQrStatus("loading"); setFeishuQrUrl(""); setFeishuQrMsg("")
    const r = await window.electronAPI.feishuRegisterApp(preset)
    if (r.ok && r.appId && r.appSecret) {
      set({ larkAppId: r.appId, larkAppSecret: r.appSecret, larkAppQuickCreated: true })
      setFeishuQrStatus("idle"); setFeishuQrUrl("")
    } else if (r.error === "cancelled") {
      setFeishuQrStatus("idle"); setFeishuQrUrl("")
    } else {
      setFeishuQrStatus("error"); setFeishuQrMsg(r.error ?? "创建失败")
    }
  }

  // 微信扫码获取 Token
  useEffect(() => {
    const unsub1 = window.electronAPI.onWechatSetupQrCode((url) => { setWechatQrUrl(url); setWechatQrStatus("wait") })
    const unsub2 = window.electronAPI.onWechatSetupStatus((status) => { if (status === "scaned") setWechatQrStatus("scaned") })
    return () => { unsub1(); unsub2() }
  }, [])

  const startWechatQrLogin = async () => {
    if (wechatQrBusy.current) return
    wechatQrBusy.current = true
    setWechatQrStatus("loading"); setWechatQrUrl(""); setWechatQrMsg("")
    try {
      const r = await window.electronAPI.wechatQrLogin()
      wechatQrBusy.current = false
      if (r.ok && r.botToken) {
        set({ wechatToken: r.botToken, wechatAccountId: r.accountId ?? "" })
        setWechatQrStatus("idle"); setWechatQrUrl("")
      } else if (r.error === "cancelled") {
        setWechatQrStatus("idle"); setWechatQrUrl("")
      } else {
        setWechatQrStatus("error"); setWechatQrMsg(r.error ?? "登录失败")
      }
    } catch (e: unknown) {
      wechatQrBusy.current = false
      setWechatQrStatus("error"); setWechatQrMsg(e instanceof Error ? e.message : String(e))
    }
  }

  // 主用户绑定
  const handleBind = async () => {
    const credOk = draft.type === "feishu" ? !!(draft.larkAppId?.trim() && draft.larkAppSecret?.trim()) : !!draft.wechatToken?.trim()
    if (!credOk) { void showAlert("提示", draft.type === "feishu" ? "请先填写飞书凭据" : "请先扫码获取微信 Token"); return }
    setBinding(true)
    try {
      // 先落库，保证主进程读到最新通道配置
      await onSaveDraft({ ...draft, mainUserEnabled: true })
      const r = await window.electronAPI.startChannelBind(draft.id)
      if (r.ok && r.chatId) {
        const next = { ...draft, mainUserEnabled: true, mainUserChatId: r.chatId }
        onChange(next)
        await onSaveDraft(next)
      } else if (r.error && r.error !== "cancelled") {
        void showAlert("绑定失败", r.error)
      }
    } finally {
      setBinding(false)
    }
  }

  const cancelBind = async () => {
    await window.electronAPI.cancelChannelBind(draft.id)
    setBinding(false)
  }

  const handleUnbind = async () => {
    if (!await showConfirm("解绑确认", "确定解除该通道的主用户绑定吗？解绑后该通道私聊将按\"其他人\"模式处理。")) return
    // 真解绑走主进程（清开关+推 daemon），只清草稿 chatId 等于没解（门只看开关）
    await window.electronAPI.unbindChannel(channel.id)
    const next = { ...draft, mainUserEnabled: false, mainUserChatId: "" }
    onChange(next)
    await onSaveDraft(next)
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      await onSaveDraft(draft)
      const r = await window.electronAPI.testBind(draft.id)
      if (r.ok) void showAlert("成功", "测试消息已发送")
      else void showAlert("错误", r.error || "测试失败")
    } finally {
      setTesting(false)
    }
  }

  const selectWorkDir = async () => {
    const d = await window.electronAPI.selectDirectory()
    if (d) set({ workspaceDir: d })
  }

  const credOk = draft.type === "feishu" ? !!(draft.larkAppId?.trim() && draft.larkAppSecret?.trim()) : !!draft.wechatToken?.trim()
  /** 已绑定 = 开关开且有 chatId；旧暂停态视为未绑定，点绑定即覆盖自愈 */
  const bound = draft.mainUserEnabled && !!draft.mainUserChatId
  /** 带"思考/工具流式卡片"的通道（飞书、应用内对话）才有思考展示相关设置 */
  const hasStreamCard = draft.type === "feishu" || draft.type === "app"

  const workDirField = (
    <div>
      <label className="mb-1 block text-xs text-fg-muted">工作目录</label>
      <div className="flex items-center gap-2">
        <div onClick={() => void selectWorkDir()} className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 transition hover:border-blue-500">
          <FolderOpen size={14} className="text-accent" />
          <span className="truncate text-xs">{draft.workspaceDir || "点击选择…"}</span>
        </div>
        {draft.workspaceDir && <button onClick={() => set({ workspaceDir: "" })} className="text-xs text-fg-muted hover:text-danger">清除</button>}
      </div>
    </div>
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className={PANEL_SCROLL_FLAT}>
          {/* 名称 */}
          <div>
            <label className="mb-1 block text-xs text-fg-muted">通道名称</label>
            <input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={CHANNEL_TYPE_LABELS[draft.type]} />
          </div>

          {/* ── 凭据 ── */}
          {draft.type === "feishu" ? (
            <section className={sectionCls}>
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-fg-3">飞书凭据</h4>
                <div className="flex items-center gap-2">
                  <a href={draft.larkAppId?.trim() ? `https://open.feishu.cn/app/${draft.larkAppId.trim()}` : "https://open.feishu.cn/app"}
                    target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-fg-muted hover:text-accent">
                    <ExternalLink size={11} />开发者后台
                  </a>
                  <button type="button" onClick={openRegisterForm} disabled={feishuQrStatus === "loading" || feishuQrStatus === "wait" || registerForm !== null}
                    className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2 py-1 text-xs text-accent-soft hover:bg-blue-600/20 disabled:opacity-50">
                    <LogIn size={11} />一键创建应用
                  </button>
                </div>
              </div>
              {registerForm && (
                <div className="space-y-2 rounded-lg border border-blue-800/40 bg-accent-tint/20 p-3">
                  <p className="text-xs font-medium text-accent-bright">新应用信息（创建页将预填，扫码后可修改）</p>
                  <div>
                    <label className="mb-1 block text-xs text-fg-muted">应用名称（群内机器人显示名）</label>
                    <input type="text" value={registerForm.name} onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })} className={inputCls} placeholder="如：排课助手" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-fg-muted">应用描述</label>
                    <input type="text" value={registerForm.desc} onChange={(e) => setRegisterForm({ ...registerForm, desc: e.target.value })} className={inputCls} placeholder="如：排课领域知识问答助手" />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => setRegisterForm(null)} className="rounded-md px-3 py-1 text-xs text-fg-3 hover:bg-raised hover:text-fg">取消</button>
                    <button onClick={() => void startFeishuRegister(registerForm)} disabled={!registerForm.name.trim()} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40">开始扫码创建</button>
                  </div>
                </div>
              )}
              {(feishuQrStatus === "loading" || (feishuQrStatus === "wait" && feishuQrUrl)) && (
                <div className="flex flex-col items-center gap-2 py-3">
                  {feishuQrStatus === "loading"
                    ? <Loader2 size={22} className="animate-spin text-accent" />
                    : <img src={feishuQrUrl} alt="Feishu QR" className="h-40 w-40 rounded bg-white p-1" />}
                  <p className="text-xs text-fg-3">{feishuQrStatus === "loading" ? "正在生成二维码..." : "请使用飞书扫码创建应用，完成后凭据将自动回填"}</p>
                  <div className="flex items-center gap-3">
                    <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-fg-muted hover:text-accent"
                      title="已创建成功但未自动回填时，可到开发者平台复制凭据手动填入">
                      <ExternalLink size={11} />开发者平台
                    </a>
                    <button onClick={async () => { await window.electronAPI.feishuRegisterAppCancel(); setFeishuQrStatus("idle"); setFeishuQrUrl("") }} className="text-xs text-fg-muted hover:text-danger">取消</button>
                  </div>
                </div>
              )}
              {feishuQrStatus === "error" && (
                <p className="text-xs text-danger">
                  {feishuQrMsg} <button onClick={openRegisterForm} className="text-accent hover:underline">重试</button>
                  <span className="text-fg-muted"> · 若飞书侧已创建成功，可到</span>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="text-accent hover:underline">开发者平台</a>
                  <span className="text-fg-muted">复制凭据手动填入</span>
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="mb-1 block text-xs text-fg-muted">App ID</label><input type="text" value={draft.larkAppId ?? ""} onChange={(e) => set({ larkAppId: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-fg-muted">App Secret</label>
                  <div className="relative">
                    <input type={showSecret ? "text" : "password"} value={draft.larkAppSecret ?? ""} onChange={(e) => set({ larkAppSecret: e.target.value })} className={inputCls + " pr-9"} />
                    <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg-2">{showSecret ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                  </div>
                </div>
              </div>
              {appInfoState.checking && <p className="flex items-center gap-1.5 text-xs text-fg-muted"><Loader2 size={11} className="animate-spin" />正在识别应用...</p>}
              {!appInfoState.checking && draft.larkBotName && <p className="flex items-center gap-1.5 text-xs text-success"><CheckCircle2 size={12} />已识别应用：{draft.larkBotName}</p>}
              {!appInfoState.checking && appInfoState.error && <p className="flex items-center gap-1.5 text-xs text-danger"><ShieldAlert size={12} />{appInfoState.error}</p>}
            </section>
          ) : draft.type === "wechat" ? (
            <section className={sectionCls}>
              <h4 className="text-xs font-medium text-fg-3">微信账号</h4>
              {draft.wechatToken && wechatQrStatus === "idle" ? (
                <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <CheckCircle2 size={14} className="text-success" />
                  <span className="flex-1 text-xs text-fg-2">已获取 Token{draft.wechatAccountId && <span className="ml-1 font-mono text-fg-muted">{draft.wechatAccountId}</span>}</span>
                  <button type="button" onClick={() => void startWechatQrLogin()} className="text-xs text-fg-muted hover:text-accent">重新扫码</button>
                </div>
              ) : (
                <div className="space-y-2">
                  {wechatQrStatus === "loading" && (
                    <div className="flex items-center gap-2 py-2 text-xs text-fg-3">
                      <Loader2 size={13} className="animate-spin" />正在获取二维码...
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); wechatQrBusy.current = false; setWechatQrStatus("idle") }} className="text-fg-muted hover:text-danger">取消</button>
                    </div>
                  )}
                  {(wechatQrStatus === "wait" || wechatQrStatus === "scaned") && wechatQrUrl && (
                    <div className="flex flex-col items-center gap-2 py-2">
                      <div className="rounded-lg bg-white p-2"><img src={wechatQrUrl} alt="WeChat QR" className="h-40 w-40" /></div>
                      <p className="text-xs text-fg-3">{wechatQrStatus === "scaned" ? "✅ 已扫描，请在手机上确认" : "请使用手机微信扫码"}</p>
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); wechatQrBusy.current = false; setWechatQrStatus("idle") }} className="text-xs text-fg-muted hover:text-danger">取消</button>
                    </div>
                  )}
                  {wechatQrStatus === "error" && <p className="text-xs text-danger">{wechatQrMsg} <button onClick={() => void startWechatQrLogin()} className="text-accent hover:underline">重试</button></p>}
                  {wechatQrStatus === "idle" && (
                    <button onClick={() => void startWechatQrLogin()} className="flex items-center gap-2 rounded-md border border-line-strong px-3 py-2 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent">
                      <LogIn size={13} />扫码绑定ClawBot
                    </button>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section className={sectionCls}>
              <h4 className="text-xs font-medium text-fg-3">应用内对话</h4>
              <p className="text-xs leading-relaxed text-fg-muted">
                在本应用的「对话」页与 Agent 交流，消息不经过飞书/微信。仅本机可用，无需凭据与绑定。
                对话内容仍会发送给所选模型服务商，并保存在本机的会话记录中。
              </p>
            </section>
          )}

          {/* ── 人群 Tab：主用户 | 其他用户（同草稿，切换不丢未保存；应用内对话只有主用户） ── */}
          {draft.type !== "app" && (
          <div className="mt-5 flex gap-1 border-b border-line-subtle">
            {(["main", "others"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTab(t)}
                className={`rounded-t-md px-4 py-2 text-xs font-medium transition ${activeTab === t ? "bg-raised text-fg" : "text-fg-muted hover:text-fg-2"}`}
              >{t === "main" ? "主用户" : "其他用户"}</button>
            ))}
          </div>
          )}

          {/* ── 应用内对话：仅需工作目录（固定本机主用户，无绑定流程） ── */}
          {draft.type === "app" && (
          <section className={sectionFirstCls}>
            <h4 className="text-xs font-medium text-fg-3">主工作目录</h4>
            {workDirField}
          </section>
          )}

          {/* ── 主用户：绑定与工作目录（依赖前置） ── */}
          {activeTab === "main" && draft.type !== "app" && (
          <section className={sectionFirstCls}>
            <h4 className="text-xs font-medium text-fg-3">绑定主用户</h4>
            <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                  {binding
                    ? <>
                        <Loader2 size={14} className="animate-spin text-accent" />
                        <span className="flex-1 text-xs text-accent-soft">请在{draft.type === "feishu" ? "飞书" : "微信"}私聊中向机器人发一条消息…</span>
                        <button type="button" onClick={() => void cancelBind()} className="text-xs text-fg-muted hover:text-danger">取消</button>
                      </>
                    : bound
                      ? <>
                          <CheckCircle2 size={14} className="text-success" />
                          <span className="flex-1 truncate text-xs text-fg-2">已绑定</span>
                          <button type="button" onClick={() => void handleBind()} className="text-xs text-fg-muted hover:text-accent">重新绑定</button>
                          <button type="button" onClick={() => void handleUnbind()} className="text-xs text-fg-muted hover:text-danger">解绑</button>
                          <button type="button" onClick={() => void handleTest()} disabled={testing} className="text-xs text-fg-muted hover:text-success disabled:opacity-50">{testing ? "…" : "测试"}</button>
                        </>
                      : <>
                          <ShieldAlert size={14} className="text-yellow-500" />
                          <span className="flex-1 text-xs text-fg-muted">未绑定</span>
                          <button type="button" onClick={() => void handleBind()} disabled={!credOk} className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent disabled:opacity-50">绑定</button>
                        </>}
                </div>
            {(draft.mainUserEnabled || draft.mainUserChatId) && workDirField}
          </section>
          )}

          {/* ── Agent 资源与模型（主用户） ── */}
          {activeTab === "main" && (
          <section className={sectionCls}>
            <h4 className="text-xs font-medium text-fg-3">Agent 资源与模型</h4>
            <ModelPicker
              variant="field"
              placement="down"
              portal
              resources={resources}
              currentResourceId={draft.agentResourceId}
              currentModel={draft.agentResourceId ? draft.model : ""}
              currentParams={draft.modelParams}
              autoLabel="自动（auto）"
              allowManual
              quickModels={quickModels}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onOpen={() => void refreshModels()}
              placeholder="选择供应商 / 模型"
              onSelect={(c) => set({ agentResourceId: c.resourceId, model: c.model || "auto", modelParams: c.modelParams ?? "" })}
            />
          </section>
          )}

          {/* ── 会话保活模式（主用户 / 其他人独立配置） ── */}
          {activeTab === "main" && (
          <section className={sectionCls}>
            <div className="flex items-center justify-between">
              <p className="text-xs text-fg-3">保留会话</p>
              <button onClick={() => set({ keepSessionMain: !(draft.keepSessionMain ?? true) })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.keepSessionMain ?? true) ? "bg-blue-600" : "bg-stronger"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.keepSessionMain ?? true) ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {(draft.keepSessionMain ?? true) && (
              <div className="flex items-center justify-between border-t border-line-subtle pt-3">
                <p className="text-xs text-fg-3">保持长连接</p>
                <button onClick={() => set({ persistentPollMain: !(draft.persistentPollMain ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.persistentPollMain ?? true) ? "bg-blue-600" : "bg-stronger"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.persistentPollMain ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {hasStreamCard && (
              <div className="flex items-center justify-between border-t border-line-subtle pt-3">
                <p className="text-xs text-fg-3">展示思考过程</p>
                <button onClick={() => set({ showThinkingMain: !(draft.showThinkingMain ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.showThinkingMain ?? true) ? "bg-blue-600" : "bg-stronger"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.showThinkingMain ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {draft.type === "feishu" && (draft.showThinkingMain ?? true) && (
              <>
              <div className="flex items-center justify-between border-t border-line-subtle pt-3 pl-2">
                <p className="text-xs text-fg-3" title="一组连续的思考/工具或一个单独的块算一段，更早的整段一起隐藏">思考/工具保留段数</p>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.streamKeepPerKindMain ?? 5}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10)
                    set({ streamKeepPerKindMain: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5 })
                  }}
                  className="w-16 rounded-lg border border-line bg-surface px-2 py-1 text-center text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center justify-between border-t border-line-subtle pt-3 pl-2">
                <p className="text-xs text-fg-3">回复后隐藏思考</p>
                <button onClick={() => set({ hideThinkingOnFinishMain: !(draft.hideThinkingOnFinishMain ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.hideThinkingOnFinishMain ?? true) ? "bg-blue-600" : "bg-stronger"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.hideThinkingOnFinishMain ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
              </>
            )}
          </section>
          )}

          {/* ── 其他用户：总开关前置 ── */}
          {activeTab === "others" && (
          <section className={sectionFirstCls}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-fg-3">允许其他人使用</h4>
              <button onClick={() => set({ allowOthers: !draft.allowOthers })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.allowOthers ? "bg-blue-600" : "bg-stronger"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${draft.allowOthers ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {!draft.allowOthers && (
              <p className="text-xs text-fg-faint">开启后可配置其他人的资源、模型与会话。</p>
            )}
          </section>
          )}

          {activeTab === "others" && draft.allowOthers && (
          <section className={sectionCls}>
            <h4 className="text-xs font-medium text-fg-3">Agent 资源与模型</h4>
            <ModelPicker
              variant="field"
              placement="down"
              portal
              resources={resources}
              currentResourceId={draft.othersAgentResourceId ?? ""}
              currentModel={draft.othersModel}
              currentParams={draft.othersModelParams}
              followProvider="跟随主用户"
              followResourceId={draft.agentResourceId}
              followModel="跟随主模型"
              allowManual
              quickModels={quickModels}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onOpen={() => void refreshModels()}
              placeholder="选择供应商 / 模型"
              onSelect={(c) => set({ othersAgentResourceId: c.resourceId, othersModel: c.model, othersModelParams: c.modelParams ?? "" })}
            />
            {!sameResource && !draft.othersModel?.trim() && (
              <p className="text-xs text-yellow-500">其他人资源与主用户不同，请显式选择模型（不可跟随）。</p>
            )}
          </section>
          )}

          {activeTab === "others" && draft.allowOthers && (
          <section className={sectionCls}>
            <div className="flex items-center justify-between">
              <p className="text-xs text-fg-3">保留会话</p>
              <button onClick={() => set({ keepSessionOthers: !(draft.keepSessionOthers ?? true) })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.keepSessionOthers ?? true) ? "bg-blue-600" : "bg-stronger"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.keepSessionOthers ?? true) ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {(draft.keepSessionOthers ?? true) && (
              <div className="flex items-center justify-between border-t border-line-subtle pt-3">
                <p className="text-xs text-fg-3">保持长连接</p>
                <button onClick={() => set({ persistentPollOthers: !(draft.persistentPollOthers ?? false) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.persistentPollOthers ?? false) ? "bg-blue-600" : "bg-stronger"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.persistentPollOthers ?? false) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {draft.type === "feishu" && (
              <div className="flex items-center justify-between border-t border-line-subtle pt-3">
                <p className="text-xs text-fg-3">展示思考过程</p>
                <button onClick={() => set({ showThinkingOthers: !(draft.showThinkingOthers ?? false) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.showThinkingOthers ?? false) ? "bg-blue-600" : "bg-stronger"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.showThinkingOthers ?? false) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {draft.type === "feishu" && (draft.showThinkingOthers ?? false) && (
              <>
              <div className="flex items-center justify-between border-t border-line-subtle pt-3 pl-2">
                <p className="text-xs text-fg-3" title="一组连续的思考/工具或一个单独的块算一段，更早的整段一起隐藏">思考/工具保留段数</p>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.streamKeepPerKindOthers ?? 5}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10)
                    set({ streamKeepPerKindOthers: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5 })
                  }}
                  className="w-16 rounded-lg border border-line bg-surface px-2 py-1 text-center text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center justify-between border-t border-line-subtle pt-3 pl-2">
                <p className="text-xs text-fg-3">回复后隐藏思考</p>
                <button onClick={() => set({ hideThinkingOnFinishOthers: !(draft.hideThinkingOnFinishOthers ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.hideThinkingOnFinishOthers ?? true) ? "bg-blue-600" : "bg-stronger"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.hideThinkingOnFinishOthers ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
              </>
            )}
          </section>
          )}

          {activeTab === "main" && <ChannelRulesView channelId={draft.id} audience="main" title="适用规则" />}

          {activeTab === "others" && draft.allowOthers && <ChannelRulesView channelId={draft.id} audience="others" title="适用规则" />}
        </div>
    </div>
  )
}

// ── 通道适用规则（只读）：mode 主用户默认全量；custom 按本通道×人群匹配───

function ruleAppliesLocal(
  scope: { mode?: string; targets?: { channelId: string; audiences?: string[] }[] } | undefined,
  channelId: string,
  audience: "main" | "others",
): boolean {
  if (!scope || scope.mode !== "custom") return audience === "main"
  return (scope.targets ?? []).some((t) => t.channelId === channelId && (t.audiences ?? []).includes(audience))
}

function ChannelRulesView({ channelId, audience, title }: { channelId: string; audience: "main" | "others"; title: string }) {
  const [rules, setRules] = useState<{ id: string; enabled: boolean; content: string; scope?: { mode?: string; targets?: { channelId: string; audiences?: string[] }[] } }[]>([])
  useEffect(() => {
    void window.electronAPI.getHarnessRules().then((rs) => setRules(rs ?? []))
  }, [channelId])
  const list = rules.filter((r) => r.enabled && ruleAppliesLocal(r.scope, channelId, audience))
  return (
    <section className={sectionCls}>
      <h4 className="text-xs font-medium text-fg-3">{title}（{list.length}）</h4>
      {list.length === 0
        ? <p className="text-xs text-fg-faint">无</p>
        : <div className="flex flex-wrap gap-1.5">{list.map((r) => (
          <span key={r.id} title={r.content || r.id} className="max-w-full cursor-default truncate rounded-md bg-raised/70 px-2 py-1 text-xs text-fg-2">{r.id}</span>
        ))}</div>}
    </section>
  )
}
