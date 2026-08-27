import { useState, useEffect, useRef } from "react"
import {
  FolderOpen, KeyRound, Bird, UserCheck, Wrench, CheckCircle2, Circle,
  Loader2, ExternalLink, ShieldCheck, ShieldAlert, LogIn, Download, ArrowRight,
  Terminal, Cloud, Globe,
} from "lucide-react"
import ConfigMigratePanel from "./ConfigMigratePanel"
import useInlineModal from "./useInlineModal"
import { BUILTIN_LLM_PROVIDERS, builtinProviderLabel } from "../../shared/agent-providers"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

function newId(prefix: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${prefix}_${hex}`
}

interface Props {
  open: boolean
  /** completed=true 表示全部走完；false 表示中途跳过（两者都会写 setupComplete） */
  onClose: (completed: boolean) => void
}

const STEPS = [
  { icon: FolderOpen, label: "选工作文件夹" },
  { icon: KeyRound, label: "接入 AI" },
  { icon: Bird, label: "连上飞书" },
  { icon: UserCheck, label: "绑定你自己" },
  { icon: Wrench, label: "装点工具" },
]

export default function SetupWizard({ open, onClose }: Props) {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const [step, setStep] = useState(0)
  const [maxStep, setMaxStep] = useState(0)

  const [wsDir, setWsDir] = useState("")
  type AgentMode = "cli" | "sdk" | "llm-builtin" | "llm-custom"
  const [agentMode, setAgentMode] = useState<AgentMode>("llm-builtin")
  const [agentResourceId, setAgentResourceId] = useState("cli")
  const [agentConfigured, setAgentConfigured] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [llmProviderId, setLlmProviderId] = useState("deepseek")
  const [llmBaseUrl, setLlmBaseUrl] = useState("")
  const [cliLoggedIn, setCliLoggedIn] = useState<boolean | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyErr, setVerifyErr] = useState("")
  const [sdkSaved, setSdkSaved] = useState(false)
  const [channelId, setChannelId] = useState("")
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [botName, setBotName] = useState("")
  const [chanErr, setChanErr] = useState("")
  const [chanChecking, setChanChecking] = useState(false)
  const [qrUrl, setQrUrl] = useState("")
  const [qrState, setQrState] = useState<"idle" | "loading" | "wait">("idle")
  const [binding, setBinding] = useState(false)
  const [bindDone, setBindDone] = useState(false)
  const [bindErr, setBindErr] = useState("")
  const [toolStatus, setToolStatus] = useState<{ larkCli: { installed: boolean }; meegle: { installed: boolean }; nodeOk?: boolean; nodeVersion?: string } | null>(null)
  const [toolBusy, setToolBusy] = useState("")
  const [toolErr, setToolErr] = useState("")

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const goto = (s: number) => { setStep(s); setMaxStep((m) => Math.max(m, s)) }
  /** 完成当前步后短暂展示成功态再进下一步，让用户看清发生了什么 */
  const autoNext = (s: number) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = setTimeout(() => goto(s), 700)
  }

  useEffect(() => {
    if (!open) return
    setStep(0)
    setMaxStep(0)
    void window.electronAPI.getConfig().then((cfg) => {
      setWsDir(cfg.workspaceDir ?? "")
      const feishu = (cfg.channels ?? []).find((c) => c.type === "feishu")
      if (feishu) {
        setChannelId(feishu.id)
        setAppId(feishu.larkAppId ?? "")
        setAppSecret(feishu.larkAppSecret ?? "")
        if (feishu.mainUserEnabled && feishu.mainUserChatId) setBindDone(true)
      }
      const sdk = (cfg.agentResources ?? []).find((r) => r.type === "sdk" && r.apiKey?.trim())
      const llm = (cfg.agentResources ?? []).find((r) => (r.type === "llm-builtin" || r.type === "llm-custom") && r.apiKey?.trim())
      if (llm) {
        setAgentMode(llm.type === "llm-custom" ? "llm-custom" : "llm-builtin")
        setAgentResourceId(llm.id)
        setApiKey(llm.apiKey ?? "")
        if (llm.type === "llm-builtin") setLlmProviderId(llm.providerId ?? "deepseek")
        if (llm.type === "llm-custom") setLlmBaseUrl(llm.baseUrl ?? "")
        setAgentConfigured(true)
      } else if (sdk) {
        setAgentMode("sdk")
        setAgentResourceId(sdk.id)
        setApiKey(sdk.apiKey ?? "")
        setSdkSaved(true)
        setAgentConfigured(true)
      } else {
        setAgentMode("llm-builtin")
        setAgentResourceId("cli")
      }
      void window.electronAPI.checkCliLogin({ forceRefresh: false }).then((login) => {
        setCliLoggedIn(login.loggedIn ?? false)
      }).catch(() => setCliLoggedIn(null))
    })
    const unsub = window.electronAPI.onFeishuSetupQrCode((url) => { setQrUrl(url); setQrState("wait") })
    return () => unsub()
  }, [open])

  useEffect(() => {
    if (open && step === 4 && !toolStatus) {
      void window.electronAPI.getToolboxStatus().then(setToolStatus).catch(() => {})
    }
  }, [open, step, toolStatus])

  if (!open) return null

  const pickDir = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    setWsDir(dir)
    autoNext(1)
  }

  const saveAgentResources = async (list: AgentResource[]) => {
    await window.electronAPI.saveConfig({ agentResources: list })
  }

  const verifyAndSaveAgent = async () => {
    setVerifying(true)
    setVerifyErr("")
    try {
      const cfg = await window.electronAPI.getConfig()
      const existing = cfg.agentResources ?? []
      const keepOthers = existing.filter((r) => r.type !== "cli" && r.type !== "sdk" && r.type !== "llm-builtin" && r.type !== "llm-custom")
      const cliRes = existing.find((r) => r.type === "cli") ?? { id: "cli", type: "cli" as const, name: "Cursor CLI" }

      if (agentMode === "cli") {
        const cliOk = await window.electronAPI.checkCli()
        if (!cliOk) { setVerifyErr("未检测到 Cursor CLI"); return }
        const login = await window.electronAPI.checkCliLogin({ forceRefresh: true })
        if (!login.loggedIn) {
          await window.electronAPI.loginCli()
          const again = await window.electronAPI.checkCliLogin({ forceRefresh: true })
          if (!again.loggedIn) { setVerifyErr("CLI 仍未登录"); return }
        }
        await saveAgentResources([cliRes, ...keepOthers])
        setAgentResourceId("cli")
        setAgentConfigured(true)
        autoNext(2)
        return
      }

      if (agentMode === "sdk") {
        if (!apiKey.trim()) return
        const r = await window.electronAPI.checkSdkApiKey(apiKey.trim())
        if (!r.ok) { setVerifyErr(r.error ?? "Key 无效"); return }
        const sdkList = existing.filter((x) => x.type === "sdk")
        const hit = sdkList.find((x) => x.apiKey === apiKey.trim())
        const entry = hit ?? { id: newId("sdk"), type: "sdk" as const, name: `Cursor SDK ${sdkList.length + 1}`, apiKey: apiKey.trim(), email: r.email }
        await saveAgentResources([cliRes, ...(hit ? sdkList : [...sdkList, entry]), ...keepOthers])
        setAgentResourceId(entry.id)
        setSdkSaved(true)
        setAgentConfigured(true)
        autoNext(2)
        return
      }

      if (agentMode === "llm-custom") {
        if (!apiKey.trim() || !llmBaseUrl.trim()) { setVerifyErr("请填写 Base URL 和 API Key"); return }
        const draft: AgentResource = { id: newId("llm"), type: "llm-custom", name: "自定义网关", baseUrl: llmBaseUrl.trim(), apiKey: apiKey.trim() }
        const r = await window.electronAPI.verifyLlmResource(draft)
        if (!r.ok) { setVerifyErr(r.error ?? "验证失败"); return }
        await saveAgentResources([cliRes, draft, ...keepOthers])
        setAgentResourceId(draft.id)
        setAgentConfigured(true)
        autoNext(2)
        return
      }

      if (!apiKey.trim()) return
      const draft: AgentResource = { id: newId("llm"), type: "llm-builtin", name: builtinProviderLabel(llmProviderId), providerId: llmProviderId, apiKey: apiKey.trim() }
      const r = await window.electronAPI.verifyLlmResource(draft)
      if (!r.ok) { setVerifyErr(r.error ?? "验证失败"); return }
      await saveAgentResources([cliRes, draft, ...keepOthers])
      setAgentResourceId(draft.id)
      setAgentConfigured(true)
      autoNext(2)
    } finally {
      setVerifying(false)
    }
  }

  const verifyAndSaveKey = async () => {
    setAgentMode("sdk")
    await verifyAndSaveAgent()
  }

  const saveChannel = async (id: string, secret: string, quickCreated: boolean) => {
    setChanChecking(true)
    setChanErr("")
    try {
      const info = await window.electronAPI.fetchFeishuAppInfo(id.trim(), secret.trim())
      if (!info.ok) { setChanErr(info.error ?? "凭据无效，请检查 App ID / Secret"); return }
      setBotName(info.name ?? "")
      const cfg = await window.electronAPI.getConfig()
      const channels = cfg.channels ?? []
      const agentRes = (cfg.agentResources ?? []).find((r) => r.id === agentResourceId)
        ?? (cfg.agentResources ?? []).find((r) => (r.type === "sdk" || r.type === "llm-builtin" || r.type === "llm-custom") && (r.apiKey?.trim() || r.type === "cli"))
      const existing = channels.find((c) => c.id === channelId) ?? channels.find((c) => c.type === "feishu")
      const chan = {
        ...(existing ?? {
          id: newId("ch"), name: info.name || "飞书机器人", enabled: true, type: "feishu" as const,
          model: "auto", modelParams: "", othersModel: "", othersModelParams: "",
          mainUserEnabled: false, mainUserChatId: "", allowOthers: false, digitalIdentity: "",
          workspaceDir: wsDir.trim(), keepSession: true, persistentPoll: true, showThinking: true,
        }),
        larkAppId: id.trim(), larkAppSecret: secret.trim(), larkBotName: info.name,
        larkAppQuickCreated: quickCreated, enabled: true,
        agentResourceId: agentRes?.id ?? agentResourceId ?? "cli",
        ...(wsDir.trim() ? { workspaceDir: wsDir.trim() } : {}),
      }
      setChannelId(chan.id)
      const nextChannels = channels.some((c) => c.id === chan.id) ? channels.map((c) => c.id === chan.id ? chan : c) : [...channels, chan]
      await window.electronAPI.saveConfig({ channels: nextChannels })
      autoNext(3)
    } finally {
      setChanChecking(false)
    }
  }

  const quickCreate = async () => {
    setQrState("loading")
    setChanErr("")
    const r = await window.electronAPI.feishuRegisterApp({ name: "LK Harness", desc: "IM Agent 协作助手" })
    setQrState("idle")
    setQrUrl("")
    if (r.ok && r.appId && r.appSecret) {
      setAppId(r.appId)
      setAppSecret(r.appSecret)
      await saveChannel(r.appId, r.appSecret, true)
    } else if (r.error && r.error !== "cancelled") {
      setChanErr(r.error)
    }
  }

  const startBind = async () => {
    if (!channelId) { setBindErr("请先完成上一步（连上飞书）"); return }
    setBinding(true)
    setBindErr("")
    try {
      const r = await window.electronAPI.startChannelBind(channelId)
      if (r.ok && r.chatId) {
        setBindDone(true)
        autoNext(4)
      } else if (r.error && r.error !== "cancelled") {
        setBindErr(r.error)
      }
    } finally {
      setBinding(false)
    }
  }

  const cancelBind = async () => {
    await window.electronAPI.cancelChannelBind(channelId)
    setBinding(false)
  }

  const installTool = async (key: "larkCli" | "meegle") => {
    setToolBusy(key)
    setToolErr("")
    try {
      const r = await window.electronAPI.installToolboxTool(key)
      if (!r.ok) setToolErr(r.error || "安装失败")
      setToolStatus(await window.electronAPI.getToolboxStatus())
    } catch (e: any) {
      setToolErr(e?.message || "安装失败")
    } finally {
      setToolBusy("")
    }
  }

  const finish = async (completed: boolean) => {
    await window.electronAPI.saveConfig({ setupComplete: true })
    onClose(completed)
  }

  const stepDone = [!!wsDir, agentConfigured, !!botName, bindDone, false]

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-950">
      <div className="flex items-center justify-between border-b border-gray-800 px-8 py-4">
        <div className="flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s.label} className="flex items-center">
              <button
                onClick={() => { if (i <= maxStep) setStep(i) }}
                disabled={i > maxStep}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
                  i === step ? "bg-blue-600/20 text-blue-300"
                  : stepDone[i] ? "text-green-400 hover:bg-gray-800"
                  : i <= maxStep ? "text-gray-400 hover:bg-gray-800" : "text-gray-700"}`}
              >
                {stepDone[i] ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                {i + 1}. {s.label}
              </button>
              {i < STEPS.length - 1 && <div className="mx-0.5 h-px w-4 bg-gray-800" />}
            </div>
          ))}
        </div>
        <button onClick={() => void finish(false)} className="text-xs text-gray-600 transition hover:text-gray-300">
          跳过引导
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-900/80 p-8 shadow-2xl">

          {step === 0 && (<>
            <h2 className="text-lg font-semibold text-gray-100">第 1 步：选一个工作文件夹</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              AI 收到你的消息后，就在这个文件夹里干活——读写文件、跑命令。
              一般选你的代码项目文件夹。以后随时可以在首页一键切换。
            </p>
            <div className="mt-6 flex items-center gap-3">
              <button onClick={() => void pickDir()} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500">
                <FolderOpen size={15} />选择文件夹
              </button>
              {wsDir && <span className="flex min-w-0 items-center gap-1 text-xs text-green-400"><CheckCircle2 size={13} className="shrink-0" /><span className="truncate" title={wsDir}>{wsDir}</span></span>}
            </div>
            {wsDir && (
              <button onClick={() => goto(1)} className="mt-6 flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
                下一步 <ArrowRight size={14} />
              </button>
            )}
            <div className="mt-8 border-t border-gray-800 pt-6">
              <h3 className="text-sm font-medium text-gray-300">已有 Cursor Claw？</h3>
              <p className="mt-1 text-xs text-gray-500">一键迁移通道、Agent、MCP、规则等，成功后可直接进入主页。</p>
              <div className="mt-3">
                <ConfigMigratePanel
                  compact
                  showAlert={showAlert}
                  showConfirm={showConfirm}
                  onMigrateSuccess={() => {
                    void window.electronAPI.saveConfig({ setupComplete: true }).then(() => onClose(true))
                  }}
                />
              </div>
            </div>
          </>)}

          {step === 1 && (<>
            <h2 className="text-lg font-semibold text-gray-100">第 2 步：接入 AI</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              推荐 <span className="text-gray-200">大模型 API</span>（Pi 内嵌，飞书流式体验最佳），也可选 Cursor CLI / SDK。
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {([
                { id: "llm-builtin" as const, icon: Cloud, title: "大模型 API", desc: "DeepSeek / OpenAI 等" },
                { id: "cli" as const, icon: Terminal, title: "Cursor CLI", desc: "本机 Cursor 登录态" },
                { id: "sdk" as const, icon: KeyRound, title: "Cursor SDK", desc: "Cursor API Key" },
                { id: "llm-custom" as const, icon: Globe, title: "自定义网关", desc: "OpenAI 兼容 Base URL" },
              ]).map((opt) => (
                <button key={opt.id} type="button"
                  onClick={() => { setAgentMode(opt.id); setVerifyErr(""); setAgentConfigured(false); setSdkSaved(false) }}
                  className={`rounded-lg border px-3 py-2.5 text-left transition ${agentMode === opt.id ? "border-blue-500 bg-blue-600/10" : "border-gray-800 hover:border-gray-600"}`}>
                  <div className="flex items-center gap-2 text-sm text-gray-200"><opt.icon size={14} />{opt.title}</div>
                  <p className="mt-0.5 text-[11px] text-gray-500">{opt.desc}</p>
                </button>
              ))}
            </div>

            {agentMode === "cli" && (
              <div className="mt-4 space-y-2">
                <p className="text-xs text-gray-500">确认本机 Cursor CLI 已安装并登录。</p>
                <button onClick={() => void verifyAndSaveAgent()} disabled={verifying}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
                  {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {verifying ? "检测中..." : cliLoggedIn ? "已登录，继续" : "检测并登录 CLI"}
                </button>
              </div>
            )}

            {agentMode === "sdk" && (
              <div className="mt-4 space-y-2">
                <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setVerifyErr(""); setSdkSaved(false) }} placeholder="crsr_..." className={inputCls} />
              </div>
            )}

            {agentMode === "llm-builtin" && (
              <div className="mt-4 space-y-2">
                <select value={llmProviderId} onChange={(e) => setLlmProviderId(e.target.value)} className={inputCls}>
                  {BUILTIN_LLM_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setVerifyErr("") }} placeholder="API Key" className={inputCls} />
              </div>
            )}

            {agentMode === "llm-custom" && (
              <div className="mt-4 space-y-2">
                <input type="text" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className={inputCls} />
                <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setVerifyErr("") }} placeholder="API Key" className={inputCls} />
              </div>
            )}

            {agentMode !== "cli" && (
              <div className="mt-4 flex items-center gap-3">
                <button onClick={() => void verifyAndSaveAgent()} disabled={verifying || agentConfigured}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
                  {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                  {verifying ? "验证中..." : agentConfigured ? "已验证" : "验证并继续"}
                </button>
                {agentConfigured && <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={13} />已保存</span>}
                {verifyErr && <span className="flex items-center gap-1 text-xs text-red-400"><ShieldAlert size={13} />{verifyErr}</span>}
              </div>
            )}
            {agentMode === "cli" && verifyErr && <p className="mt-2 text-xs text-red-400">{verifyErr}</p>}
            {agentConfigured && (
              <button onClick={() => goto(2)} className="mt-6 flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
                下一步 <ArrowRight size={14} />
              </button>
            )}
          </>)}

          {step === 2 && (<>
            <h2 className="text-lg font-semibold text-gray-100">第 3 步：连上飞书</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              创建一个飞书机器人并接进来。之后你在飞书里给它发消息，就是在指挥你电脑上的 AI。
              推荐用「一键创建」：扫个码，应用自动建好、凭据自动填回来。
            </p>
            <div className="mt-6 space-y-4">
              {qrState === "idle" && (
                <button onClick={() => void quickCreate()} disabled={chanChecking}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
                  <LogIn size={15} />一键创建飞书应用
                </button>
              )}
              {qrState !== "idle" && (
                <div className="flex flex-col items-center gap-2 py-2">
                  {qrState === "loading" && !qrUrl
                    ? <Loader2 size={22} className="animate-spin text-blue-400" />
                    : <img src={qrUrl} alt="Feishu QR" className="h-40 w-40 rounded bg-white p-1" />}
                  <p className="text-xs text-gray-400">用飞书 App 扫码创建，完成后凭据自动回填</p>
                  <button onClick={async () => { await window.electronAPI.feishuRegisterAppCancel(); setQrState("idle"); setQrUrl("") }} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                </div>
              )}
              <div className="space-y-2 rounded-lg border border-gray-800 p-3">
                <p className="text-xs text-gray-500">已有飞书应用？直接填凭据（<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">开发者后台</a>可查）：</p>
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID (cli_...)" className={inputCls} />
                  <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="App Secret" className={inputCls} />
                </div>
                <button onClick={() => void saveChannel(appId, appSecret, false)} disabled={chanChecking || !appId.trim() || !appSecret.trim()}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                  {chanChecking ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  {chanChecking ? "校验中..." : "校验并继续"}
                </button>
              </div>
              {botName && <p className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={13} />已连接机器人「{botName}」</p>}
              {chanErr && <p className="text-xs text-red-400">{chanErr}</p>}
            </div>
            {botName && (
              <button onClick={() => goto(3)} className="mt-6 flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
                下一步 <ArrowRight size={14} />
              </button>
            )}
          </>)}

          {step === 3 && (<>
            <h2 className="text-lg font-semibold text-gray-100">第 4 步：绑定你自己（推荐）</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              让机器人认识你：点「开始绑定」，然后<span className="text-gray-200">打开飞书，私聊给机器人随便发一句话</span>（比如你好）。
            </p>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              绑定后：你私聊它 = 直接指挥第 1 步选的那个文件夹里的 AI，聊天记忆一直保留。
              不绑定：所有人的消息都只能在临时文件夹里处理，碰不到你的项目。
            </p>
            <div className="mt-6 flex items-center gap-3">
              {!binding && !bindDone && (
                <button onClick={() => void startBind()} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500">
                  <UserCheck size={15} />开始绑定
                </button>
              )}
              {binding && (
                <span className="flex items-center gap-2 text-sm text-blue-300">
                  <Loader2 size={15} className="animate-spin" />
                  等待中——现在去飞书私聊机器人发一句话...
                  <button onClick={() => void cancelBind()} className="text-xs text-gray-500 hover:text-red-400">取消</button>
                </span>
              )}
              {bindDone && <span className="flex items-center gap-1 text-sm text-green-400"><CheckCircle2 size={15} />绑定成功！</span>}
            </div>
            {bindErr && <p className="mt-3 text-xs text-red-400">{bindErr}</p>}
            <div className="mt-6 flex items-center gap-4">
              {bindDone
                ? <button onClick={() => goto(4)} className="flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">下一步 <ArrowRight size={14} /></button>
                : <button onClick={() => goto(4)} className="text-sm text-gray-500 hover:text-gray-300">暂不绑定，跳过</button>}
            </div>
          </>)}

          {step === 4 && (<>
            <h2 className="text-lg font-semibold text-gray-100">第 5 步：装点工具（可选）</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              给 AI 装上飞书的手脚：装完并登录后，AI 能帮你读写飞书文档、查日历、管理飞书项目。
              也可以以后在 设置 → 工具箱 里随时安装。
            </p>
            <p className="mt-2 rounded-lg border border-amber-800/40 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
              一键安装需要本机已装 <span className="font-medium text-amber-100">Node.js</span>
              （<a href="https://nodejs.org" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">nodejs.org</a>
              ，安装时勾选 Add to PATH）。新电脑若未安装，点安装会失败并在下方提示原因。
              {toolStatus && toolStatus.nodeOk === false && <span className="mt-1 block text-red-300">当前未检测到 Node.js。</span>}
              {toolStatus?.nodeOk && toolStatus.nodeVersion && <span className="mt-1 block text-green-400/80">已检测到 Node v{toolStatus.nodeVersion}</span>}
            </p>
            <div className="mt-6 space-y-3">
              {(["larkCli", "meegle"] as const).map((key) => {
                const meta = key === "larkCli" ? { label: "飞书（lark-cli）", desc: "文档 / 日历 / 消息 / 表格" } : { label: "飞书项目（meegle）", desc: "飞书项目（Meegle）管理" }
                const st = key === "larkCli" ? toolStatus?.larkCli : toolStatus?.meegle
                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border border-gray-800 px-4 py-3">
                    <div>
                      <p className="text-sm text-gray-200">{meta.label}</p>
                      <p className="text-xs text-gray-600">{meta.desc}</p>
                    </div>
                    {!toolStatus ? <Loader2 size={13} className="animate-spin text-gray-500" />
                      : st?.installed ? <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 size={13} />已安装</span>
                      : (
                        <button onClick={() => void installTool(key)} disabled={!!toolBusy}
                          className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2.5 py-1 text-xs text-blue-300 hover:bg-blue-600/20 disabled:opacity-50">
                          {toolBusy === key ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                          {toolBusy === key ? "安装中..." : "一键安装"}
                        </button>
                      )}
                  </div>
                )
              })}
            </div>
            {toolErr && <p className="mt-3 text-xs leading-relaxed text-red-400">{toolErr}</p>}
            <button onClick={() => void finish(true)} className="mt-8 flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-green-500">
              <CheckCircle2 size={15} />完成，开始使用
            </button>
          </>)}

        </div>
      </div>
      {ModalPortal}
    </div>
  )
}
