import { useState, useEffect, useCallback, useRef } from "react"
import {
  Plus, Loader2, CheckCircle2, ShieldAlert, Eye, EyeOff, Trash2,
  LogIn, MessageSquare, Bird, FolderOpen, ExternalLink,
} from "lucide-react"
import SearchableSelect from "./SearchableSelect"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL_FLAT, PANEL_FOOTER } from "./panel-layout"
import PanelAddMenu from "./PanelAddMenu"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { modelSlug } from "../model-utils"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
const sectionCls = "mt-5 space-y-3 border-t border-gray-800 pt-5 pb-5"

function newLocalChannelId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `ch_${hex}`
}

function emptyChannel(type: "feishu" | "wechat", defaultName: string): ChannelConfig {
  return {
    id: newLocalChannelId(),
    name: defaultName,
    enabled: true,
    type,
    agentResourceId: "",
    model: "auto",
    modelParams: "",
    othersModel: "",
    othersModelParams: "",
    mainUserEnabled: false,
    mainUserChatId: "",
    allowOthers: false,
    digitalIdentity: "",
    workspaceDir: "",
    keepSession: true,
    persistentPoll: true,
    showThinking: true,
  }
}

interface ModelOption { id: string; label: string; params: string }

export default function ChannelPanel() {
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [resources, setResources] = useState<AgentResource[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, ChannelStatusInfo>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ChannelConfig | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNewChannel, setIsNewChannel] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()

  const reload = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    // 旧迁移通道可能缺少通道级字段，展示时兜底
    setChannels((cfg.channels ?? []).map((c) => ({
      ...c,
      allowOthers: c.allowOthers ?? cfg.allowOthers ?? false,
      digitalIdentity: c.digitalIdentity ?? cfg.digitalIdentity ?? "",
    })))
    setResources(cfg.agentResources ?? [])
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
    if (isDirty && !(await showConfirm("未保存", "当前通道有未保存的修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    openDraft(c, false)
  }

  const openAdd = (type: "feishu" | "wechat") => {
    setShowAddMenu(false)
    const count = channels.filter((c) => c.type === type).length
    const base = type === "feishu" ? "飞书" : "微信"
    openDraft(emptyChannel(type, count > 0 ? `${base} ${count + 1}` : base), true)
  }

  const handleCancel = async () => {
    if (isDirty && !(await showConfirm("未保存", "放弃未保存的修改？", "放弃", "继续编辑"))) return
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

  const persistDraft = async (c: ChannelConfig) => {
    const exists = channels.some((x) => x.id === c.id)
    const updated = exists ? channels.map((x) => x.id === c.id ? c : x) : [...channels, c]
    await persistChannels(updated)
    setSavedSnapshot(JSON.stringify(c))
  }

  const handleSave = async (next: ChannelConfig) => {
    if (next.mainUserEnabled && !next.workspaceDir?.trim()) {
      void showAlert("提示", "请设置主用户工作目录")
      return
    }
    await persistDraft(next)
    markSaved()
    openDraft(next, false)
    setIsNewChannel(false)
  }

  const handleDeleteCurrent = async () => {
    if (!draft || isNewChannel) return
    if (!await showConfirm("删除确认", `确定删除通道「${draft.name}」吗？`)) return
    const next = channels.filter((x) => x.id !== draft.id)
    await persistChannels(next)
    setSelectedId(null)
    setDraft(null)
    setIsNewChannel(false)
  }

  return (
    <>
      <div className={PANEL_ROOT}>
        {/* 左侧通道列表（固定，独立滚动） */}
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_LIST}>
            {channels.map((c) => {
              const st = statusMap[c.id]
              const active = selectedId === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void selectChannel(c)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ${active ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}
                >
                  {c.type === "feishu" ? <Bird size={14} className="shrink-0 text-blue-400" /> : <MessageSquare size={14} className="shrink-0 text-green-400" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{c.name}</p>
                    <p className="truncate text-[10px] text-gray-600">{st?.connected ? "已连接" : c.enabled ? "未连接" : "已停用"}</p>
                  </div>
                </button>
              )
            })}
            <div className="relative pt-1" ref={addMenuRef}>
              <button
                type="button"
                onClick={() => setShowAddMenu(!showAddMenu)}
                className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-700 py-2 text-xs text-gray-500 transition hover:border-gray-600 hover:bg-gray-800/40 hover:text-gray-300"
              >
                <Plus size={14} />添加
              </button>
              <PanelAddMenu open={showAddMenu} anchorRef={addMenuRef} onClose={() => setShowAddMenu(false)}>
                <button type="button" onClick={() => openAdd("feishu")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800"><Bird size={12} className="text-blue-400" />飞书</button>
                <button type="button" onClick={() => openAdd("wechat")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800"><MessageSquare size={12} className="text-green-400" />微信</button>
              </PanelAddMenu>
            </div>
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
                onSaveDraft={persistDraft}
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
                        className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 transition hover:bg-red-950/30"
                      ><Trash2 size={13} />删除</button>
                      <button
                        type="button"
                        onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                        className={`rounded-md px-2.5 py-1.5 text-xs transition ${draft.enabled ? "text-green-400 hover:bg-gray-800" : "text-gray-500 hover:bg-gray-800"}`}
                      >{draft.enabled ? "已启用" : "已停用"}</button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave(draft)} disabled={!draft.name.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择通道</div>
          )}
        </div>
      </div>
      {ModalPortal}
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
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
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

  const resource = resources.find((r) => r.id === draft.agentResourceId)

  const modelOptLabel = (id?: string, params?: string) =>
    modelOptions.find((o) => o.id === id && o.params === (params ?? ""))?.label
    || modelSlug(id, params)

  // 随 Agent 资源（及凭据）变化加载对应模型列表；取消过时请求避免错序覆盖
  useEffect(() => {
    if (!resource) {
      setModelOptions([])
      setLoadingModels(false)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoadingModels(true)
      try {
        if (resource.type === "sdk") {
          if (!resource.apiKey?.trim()) {
            if (!cancelled) setModelOptions([])
            return
          }
          const r = await window.electronAPI.listSdkModels(resource.apiKey.trim(), draft.model, draft.modelParams)
          if (cancelled) return
          if (r.ok && r.models.length > 0) setModelOptions(r.models)
          else setModelOptions([])
        } else if (resource.type === "llm-builtin" || resource.type === "llm-custom") {
          const r = await window.electronAPI.listLlmModels(resource, draft.model, draft.modelParams)
          if (cancelled) return
          if (r.ok && r.models.length > 0) setModelOptions(r.models.map((m) => ({ id: m.id, label: m.label, params: "" })))
          else setModelOptions([])
        } else {
          const r = await window.electronAPI.listModels()
          if (cancelled) return
          if (r.ok && r.models.length > 0) setModelOptions(r.models.map((m) => ({ ...m, label: m.id, params: "" })))
          else setModelOptions([])
        }
      } finally {
        if (!cancelled) setLoadingModels(false)
      }
    }
    setModelOptions([])
    void load()
    return () => { cancelled = true }
  }, [resource, draft.model, draft.modelParams])

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
    set({ mainUserChatId: "" })
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

  const modelKey = (id: string, params: string) => id + (params ? "\0" + params : "")
  const parseModelKey = (key: string): { id: string; params: string } => {
    const sep = key.indexOf("\0")
    return sep >= 0 ? { id: key.slice(0, sep), params: key.slice(sep + 1) } : { id: key, params: "" }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className={PANEL_SCROLL_FLAT}>
          {/* 名称 */}
          <div>
            <label className="mb-1 block text-xs text-gray-500">通道名称</label>
            <input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder={draft.type === "feishu" ? "飞书" : "微信"} />
          </div>

          {/* ── 凭据 ── */}
          {draft.type === "feishu" ? (
            <section className={sectionCls}>
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-gray-400">飞书凭据</h4>
                <div className="flex items-center gap-2">
                  <a href={draft.larkAppId?.trim() ? `https://open.feishu.cn/app/${draft.larkAppId.trim()}` : "https://open.feishu.cn/app"}
                    target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400">
                    <ExternalLink size={11} />开发者后台
                  </a>
                  <button type="button" onClick={openRegisterForm} disabled={feishuQrStatus === "loading" || feishuQrStatus === "wait" || registerForm !== null}
                    className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2 py-1 text-xs text-blue-300 hover:bg-blue-600/20 disabled:opacity-50">
                    <LogIn size={11} />一键创建应用
                  </button>
                </div>
              </div>
              {registerForm && (
                <div className="space-y-2 rounded-lg border border-blue-800/40 bg-blue-950/20 p-3">
                  <p className="text-xs font-medium text-blue-200">新应用信息（创建页将预填，扫码后可修改）</p>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">应用名称（群内机器人显示名）</label>
                    <input type="text" value={registerForm.name} onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })} className={inputCls} placeholder="如：排课助手" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">应用描述</label>
                    <input type="text" value={registerForm.desc} onChange={(e) => setRegisterForm({ ...registerForm, desc: e.target.value })} className={inputCls} placeholder="如：排课领域知识问答助手" />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => setRegisterForm(null)} className="rounded-md px-3 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                    <button onClick={() => void startFeishuRegister(registerForm)} disabled={!registerForm.name.trim()} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40">开始扫码创建</button>
                  </div>
                </div>
              )}
              {(feishuQrStatus === "loading" || (feishuQrStatus === "wait" && feishuQrUrl)) && (
                <div className="flex flex-col items-center gap-2 py-3">
                  {feishuQrStatus === "loading"
                    ? <Loader2 size={22} className="animate-spin text-blue-400" />
                    : <img src={feishuQrUrl} alt="Feishu QR" className="h-40 w-40 rounded bg-white p-1" />}
                  <p className="text-xs text-gray-400">{feishuQrStatus === "loading" ? "正在生成二维码..." : "请使用飞书扫码创建应用，完成后凭据将自动回填"}</p>
                  <div className="flex items-center gap-3">
                    <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400"
                      title="已创建成功但未自动回填时，可到开发者平台复制凭据手动填入">
                      <ExternalLink size={11} />开发者平台
                    </a>
                    <button onClick={async () => { await window.electronAPI.feishuRegisterAppCancel(); setFeishuQrStatus("idle"); setFeishuQrUrl("") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                  </div>
                </div>
              )}
              {feishuQrStatus === "error" && (
                <p className="text-xs text-red-400">
                  {feishuQrMsg} <button onClick={openRegisterForm} className="text-blue-400 hover:underline">重试</button>
                  <span className="text-gray-500"> · 若飞书侧已创建成功，可到</span>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">开发者平台</a>
                  <span className="text-gray-500">复制凭据手动填入</span>
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="mb-1 block text-xs text-gray-500">App ID</label><input type="text" value={draft.larkAppId ?? ""} onChange={(e) => set({ larkAppId: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-gray-500">App Secret</label>
                  <div className="relative">
                    <input type={showSecret ? "text" : "password"} value={draft.larkAppSecret ?? ""} onChange={(e) => set({ larkAppSecret: e.target.value })} className={inputCls + " pr-9"} />
                    <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showSecret ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                  </div>
                </div>
              </div>
              {appInfoState.checking && <p className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 size={11} className="animate-spin" />正在识别应用...</p>}
              {!appInfoState.checking && draft.larkBotName && <p className="flex items-center gap-1.5 text-xs text-green-400"><CheckCircle2 size={12} />已识别应用：{draft.larkBotName}</p>}
              {!appInfoState.checking && appInfoState.error && <p className="flex items-center gap-1.5 text-xs text-red-400"><ShieldAlert size={12} />{appInfoState.error}</p>}
            </section>
          ) : (
            <section className={sectionCls}>
              <h4 className="text-xs font-medium text-gray-400">微信账号</h4>
              {draft.wechatToken && wechatQrStatus === "idle" ? (
                <div className="flex items-center gap-3 rounded-lg border border-gray-700 px-3 py-2">
                  <CheckCircle2 size={14} className="text-green-400" />
                  <span className="flex-1 text-xs text-gray-300">已获取 Token{draft.wechatAccountId && <span className="ml-1 font-mono text-gray-500">{draft.wechatAccountId}</span>}</span>
                  <button type="button" onClick={() => void startWechatQrLogin()} className="text-xs text-gray-500 hover:text-blue-400">重新扫码</button>
                </div>
              ) : (
                <div className="space-y-2">
                  {wechatQrStatus === "loading" && (
                    <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
                      <Loader2 size={13} className="animate-spin" />正在获取二维码...
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); wechatQrBusy.current = false; setWechatQrStatus("idle") }} className="text-gray-500 hover:text-red-400">取消</button>
                    </div>
                  )}
                  {(wechatQrStatus === "wait" || wechatQrStatus === "scaned") && wechatQrUrl && (
                    <div className="flex flex-col items-center gap-2 py-2">
                      <div className="rounded-lg bg-white p-2"><img src={wechatQrUrl} alt="WeChat QR" className="h-40 w-40" /></div>
                      <p className="text-xs text-gray-400">{wechatQrStatus === "scaned" ? "✅ 已扫描，请在手机上确认" : "请使用手机微信扫码"}</p>
                      <button onClick={async () => { await window.electronAPI.wechatQrLoginCancel(); wechatQrBusy.current = false; setWechatQrStatus("idle") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                    </div>
                  )}
                  {wechatQrStatus === "error" && <p className="text-xs text-red-400">{wechatQrMsg} <button onClick={() => void startWechatQrLogin()} className="text-blue-400 hover:underline">重试</button></p>}
                  {wechatQrStatus === "idle" && (
                    <button onClick={() => void startWechatQrLogin()} className="flex items-center gap-2 rounded-md border border-gray-600 px-3 py-2 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400">
                      <LogIn size={13} />扫码绑定ClawBot
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── Agent 资源与模型 ── */}
          <section className={sectionCls}>
            <h4 className="text-xs font-medium text-gray-400">Agent 资源与模型</h4>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Agent 资源</label>
              <select
                value={draft.agentResourceId}
                onChange={(e) => {
                  const agentResourceId = e.target.value
                  if (agentResourceId === draft.agentResourceId) return
                  set({ agentResourceId, model: "auto", modelParams: "", othersModel: "", othersModelParams: "" })
                }}
                className={inputCls}
              >
                {resources.map((r) => <option key={r.id} value={r.id}>{r.name}{r.type === "sdk" && r.email ? ` (${r.email})` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">主模型</label>
              {loadingModels
                ? <div className={inputCls + " flex cursor-not-allowed items-center gap-2 text-gray-500"}><Loader2 size={13} className="animate-spin" />模型列表加载中...</div>
                : modelOptions.length > 0
                  ? <SearchableSelect
                      value={modelKey(draft.model, draft.modelParams)}
                      onChange={(key) => { const { id, params } = parseModelKey(key); set({ model: id, modelParams: params }) }}
                      options={modelOptions.map((o) => ({ id: modelKey(o.id, o.params), label: o.label }))}
                      placeholder="选择模型..."
                      fallbackLabel={modelOptLabel(draft.model, draft.modelParams)}
                    />
                  : <input type="text" value={modelOptLabel(draft.model, draft.modelParams)} onChange={(e) => set({ model: e.target.value, modelParams: "" })} placeholder="auto" className={inputCls} />}
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">其他人模型</label>
              {loadingModels
                ? <div className={inputCls + " flex cursor-not-allowed items-center gap-2 text-gray-500"}><Loader2 size={13} className="animate-spin" />模型列表加载中...</div>
                : modelOptions.length > 0
                  ? <SearchableSelect
                      value={draft.othersModel ? modelKey(draft.othersModel, draft.othersModelParams) : ""}
                      onChange={(key) => { if (!key) { set({ othersModel: "", othersModelParams: "" }); return } const { id, params } = parseModelKey(key); set({ othersModel: id, othersModelParams: params }) }}
                      options={[{ id: "", label: "跟随主模型" }, ...modelOptions.map((o) => ({ id: modelKey(o.id, o.params), label: o.label }))]}
                      placeholder="跟随主模型"
                      fallbackLabel={modelOptLabel(draft.othersModel, draft.othersModelParams)}
                    />
                  : <input type="text" value={modelOptLabel(draft.othersModel, draft.othersModelParams)} onChange={(e) => set({ othersModel: e.target.value, othersModelParams: "" })} placeholder="留空则跟随主模型" className={inputCls} />}
            </div>
          </section>

          {/* ── 会话保活模式 ── */}
          <section className={sectionCls}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-gray-400">保留会话</h4>
              <button onClick={() => set({ keepSession: !(draft.keepSession ?? true) })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.keepSession ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.keepSession ?? true) ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {(draft.keepSession ?? true) && (
              <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                <p className="text-xs text-gray-400">保持长连接</p>
                <button onClick={() => set({ persistentPoll: !(draft.persistentPoll ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.persistentPoll ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.persistentPoll ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {draft.type === "feishu" && (
              <div className="flex items-center justify-between border-t border-gray-800 pt-3">
                <p className="text-xs text-gray-400">展示思考过程</p>
                <button onClick={() => set({ showThinking: !(draft.showThinking ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.showThinking ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.showThinking ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
            )}
            {draft.type === "feishu" && (draft.showThinking ?? true) && (
              <>
              <div className="flex items-center justify-between border-t border-gray-800 pt-3 pl-2">
                <p className="text-xs text-gray-400">思考/工具块保留数</p>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.streamKeepPerKind ?? 5}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10)
                    set({ streamKeepPerKind: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5 })
                  }}
                  className="w-16 rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-center text-sm outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center justify-between border-t border-gray-800 pt-3 pl-2">
                <p className="text-xs text-gray-400">回复后隐藏思考</p>
                <button onClick={() => set({ hideThinkingOnFinish: !(draft.hideThinkingOnFinish ?? true) })}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition ${(draft.hideThinkingOnFinish ?? true) ? "bg-blue-600" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${(draft.hideThinkingOnFinish ?? true) ? "left-[18px]" : "left-0.5"}`} />
                </button>
              </div>
              </>
            )}
          </section>

          {/* ── 主用户 ── */}
          <section className={sectionCls}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-gray-400">主用户</h4>
              <button onClick={() => set({ mainUserEnabled: !draft.mainUserEnabled })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.mainUserEnabled ? "bg-blue-600" : "bg-gray-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${draft.mainUserEnabled ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {draft.mainUserEnabled && (
              <>
                <div className="flex items-center gap-3 rounded-lg border border-gray-700 px-3 py-2.5">
                  {binding
                    ? <>
                        <Loader2 size={14} className="animate-spin text-blue-400" />
                        <span className="flex-1 text-xs text-blue-300">请在{draft.type === "feishu" ? "飞书" : "微信"}私聊中向机器人发一条消息…</span>
                        <button type="button" onClick={() => void cancelBind()} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                      </>
                    : draft.mainUserChatId
                      ? <>
                          <CheckCircle2 size={14} className="text-green-400" />
                          <span className="flex-1 truncate text-xs text-gray-300">已绑定</span>
                          <button type="button" onClick={() => void handleBind()} className="text-xs text-gray-500 hover:text-blue-400">重新绑定</button>
                          <button type="button" onClick={() => void handleUnbind()} className="text-xs text-gray-500 hover:text-red-400">解绑</button>
                          <button type="button" onClick={() => void handleTest()} disabled={testing} className="text-xs text-gray-500 hover:text-green-400 disabled:opacity-50">{testing ? "…" : "测试"}</button>
                        </>
                      : <>
                          <ShieldAlert size={14} className="text-yellow-500" />
                          <span className="flex-1 text-xs text-gray-500">未绑定</span>
                          <button type="button" onClick={() => void handleBind()} disabled={!credOk} className="rounded-md border border-gray-600 px-2.5 py-1 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">绑定</button>
                        </>}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">工作目录</label>
                  <div className="flex items-center gap-2">
                    <div onClick={() => void selectWorkDir()} className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 transition hover:border-blue-500">
                      <FolderOpen size={14} className="text-blue-400" />
                      <span className="truncate text-xs">{draft.workspaceDir || "点击选择…"}</span>
                    </div>
                    {draft.workspaceDir && <button onClick={() => set({ workspaceDir: "" })} className="text-xs text-gray-500 hover:text-red-400">清除</button>}
                  </div>
                </div>
              </>
            )}
          </section>

          {/* ── 其他人 ── */}
          <section className={sectionCls}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium text-gray-400">允许其他人使用</h4>
              <button onClick={() => set({ allowOthers: !draft.allowOthers })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${draft.allowOthers ? "bg-blue-600" : "bg-gray-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${draft.allowOthers ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            {draft.allowOthers && (
              <div>
                <label className="mb-1 block text-xs text-gray-500">对外身份规则</label>
                <textarea value={draft.digitalIdentity} onChange={(e) => set({ digitalIdentity: e.target.value })} rows={4} placeholder="角色与行为规范…" className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none" />
              </div>
            )}
          </section>
        </div>
    </div>
  )
}
