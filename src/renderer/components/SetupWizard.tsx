import { useState, useEffect, useRef } from "react"
import {
  KeyRound, MessageSquare, Wrench, CheckCircle2, Circle,
  Loader2, ExternalLink, ShieldCheck, ShieldAlert, Download, ArrowRight,
  Cloud, Globe,
} from "lucide-react"
import ChannelStep from "./ChannelStep"
import ConfigMigratePanel from "./ConfigMigratePanel"
import useInlineModal from "./useInlineModal"
import { BUILTIN_LLM_PROVIDERS, builtinProviderLabel } from "../../shared/agent-providers"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"

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
  { icon: KeyRound, label: "接入 AI" },
  { icon: MessageSquare, label: "消息通道" },
  { icon: Wrench, label: "装点工具" },
]

export default function SetupWizard({ open, onClose }: Props) {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const [step, setStep] = useState(0)
  const [maxStep, setMaxStep] = useState(0)

  type AgentMode = "sdk" | "llm-builtin" | "llm-custom"
  const [agentMode, setAgentMode] = useState<AgentMode>("sdk")
  const [agentResourceId, setAgentResourceId] = useState("")
  const [agentConfigured, setAgentConfigured] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [llmProviderId, setLlmProviderId] = useState("deepseek")
  const [llmBaseUrl, setLlmBaseUrl] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [verifyErr, setVerifyErr] = useState("")
  const [sdkSaved, setSdkSaved] = useState(false)
  const [channelsDone, setChannelsDone] = useState(false)
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
      setChannelsDone((cfg.channels ?? []).length > 0)
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
        setAgentMode("sdk")
        setAgentResourceId("")
      }
    })
  }, [open])

  useEffect(() => {
    if (open && step === 2 && !toolStatus) {
      void window.electronAPI.getToolboxStatus().then(setToolStatus).catch(() => {})
    }
  }, [open, step, toolStatus])

  if (!open) return null

  const saveAgentResources = async (list: AgentResource[]) => {
    await window.electronAPI.saveConfig({ agentResources: list })
  }

  const verifyAndSaveAgent = async () => {
    setVerifying(true)
    setVerifyErr("")
    try {
      const cfg = await window.electronAPI.getConfig()
      const existing = cfg.agentResources ?? []
      const keepOthers = existing.filter((r) => r.type === "sdk" || r.type === "llm-builtin" || r.type === "llm-custom")

      if (agentMode === "sdk") {
        if (!apiKey.trim()) return
        const r = await window.electronAPI.checkSdkApiKey(apiKey.trim())
        if (!r.ok) { setVerifyErr(r.error ?? "Key 无效"); return }
        const sdkList = existing.filter((x) => x.type === "sdk")
        const hit = sdkList.find((x) => x.apiKey === apiKey.trim())
        const entry = hit ?? { id: newId("sdk"), type: "sdk" as const, name: `Cursor SDK ${sdkList.length + 1}`, apiKey: apiKey.trim(), email: r.email }
        await saveAgentResources([...(hit ? sdkList : [...sdkList, entry]), ...keepOthers])
        setAgentResourceId(entry.id)
        setSdkSaved(true)
        setAgentConfigured(true)
        autoNext(1)
        return
      }

      if (agentMode === "llm-custom") {
        if (!apiKey.trim() || !llmBaseUrl.trim()) { setVerifyErr("请填写 Base URL 和 API Key"); return }
        const draft: AgentResource = { id: newId("llm"), type: "llm-custom", name: "自定义网关", baseUrl: llmBaseUrl.trim(), apiKey: apiKey.trim() }
        const r = await window.electronAPI.verifyLlmResource(draft)
        if (!r.ok) { setVerifyErr(r.error ?? "验证失败"); return }
        await saveAgentResources([draft, ...keepOthers])
        setAgentResourceId(draft.id)
        setAgentConfigured(true)
        autoNext(1)
        return
      }

      if (!apiKey.trim()) return
      const draft: AgentResource = { id: newId("llm"), type: "llm-builtin", name: builtinProviderLabel(llmProviderId), providerId: llmProviderId, apiKey: apiKey.trim() }
      const r = await window.electronAPI.verifyLlmResource(draft)
      if (!r.ok) { setVerifyErr(r.error ?? "验证失败"); return }
      await saveAgentResources([draft, ...keepOthers])
      setAgentResourceId(draft.id)
      setAgentConfigured(true)
      autoNext(1)
    } finally {
      setVerifying(false)
    }
  }

  const verifyAndSaveKey = async () => {
    setAgentMode("sdk")
    await verifyAndSaveAgent()
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

  const stepDone = [agentConfigured, channelsDone, false]
  const anyToolInstalled = !!(toolStatus?.larkCli.installed || toolStatus?.meegle.installed)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page">
      <div className="flex items-center justify-between border-b border-line-subtle px-8 py-4">
        <div className="flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s.label} className="flex items-center">
              <button
                onClick={() => { if (i <= maxStep) setStep(i) }}
                disabled={i > maxStep}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
                  i === step ? "bg-blue-600/20 text-accent-soft"
                  : stepDone[i] ? "text-success hover:bg-raised"
                  : i <= maxStep ? "text-fg-3 hover:bg-raised" : "text-fg-ghost"}`}
              >
                {stepDone[i] ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                {i + 1}. {s.label}
              </button>
              {i < STEPS.length - 1 && <div className="mx-0.5 h-px w-4 bg-raised" />}
            </div>
          ))}
        </div>
        <button onClick={() => void finish(false)} className="text-xs text-fg-faint transition hover:text-fg-2">
          跳过引导
        </button>
      </div>

      <div className="flex flex-1 overflow-y-auto p-8">
        <div className="m-auto w-full max-w-lg rounded-2xl border border-line-subtle bg-surface/80 p-8 shadow-2xl">

          {step === 0 && (<>
            <h2 className="text-lg font-semibold text-fg">第 1 步：接入 AI</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-3">
              推荐 <span className="text-fg-soft">Cursor SDK</span> 或 <span className="text-fg-soft">大模型 API</span>。
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {([
                { id: "sdk" as const, icon: KeyRound, title: "Cursor SDK", desc: "Cursor API Key（推荐）" },
                { id: "llm-builtin" as const, icon: Cloud, title: "大模型 API", desc: "DeepSeek / OpenAI 等" },
                { id: "llm-custom" as const, icon: Globe, title: "自定义网关", desc: "OpenAI 兼容 Base URL" },
              ]).map((opt) => (
                <button key={opt.id} type="button"
                  onClick={() => { setAgentMode(opt.id); setVerifyErr(""); setAgentConfigured(false); setSdkSaved(false) }}
                  className={`rounded-lg border px-3 py-2.5 text-left transition ${agentMode === opt.id ? "border-blue-500 bg-blue-600/10" : "border-line-subtle hover:border-line-strong"}`}>
                  <div className="flex items-center gap-2 text-sm text-fg-soft"><opt.icon size={14} />{opt.title}</div>
                  <p className="mt-0.5 text-[11px] text-fg-muted">{opt.desc}</p>
                </button>
              ))}
            </div>

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

            <div className="mt-4 flex items-center gap-3">
              <button onClick={() => void verifyAndSaveAgent()} disabled={verifying || agentConfigured}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50">
                {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                {verifying ? "验证中..." : agentConfigured ? "已验证" : "验证并继续"}
              </button>
              {agentConfigured && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={13} />已保存</span>}
              {verifyErr && <span className="flex items-center gap-1 text-xs text-danger"><ShieldAlert size={13} />{verifyErr}</span>}
            </div>
            {agentConfigured && (
              <button onClick={() => goto(1)} className="mt-6 flex items-center gap-1 text-sm text-accent hover:text-accent-soft">
                下一步 <ArrowRight size={14} />
              </button>
            )}
            <div className="mt-8 border-t border-line-subtle pt-6">
              <ConfigMigratePanel
                variant="wizard"
                showAlert={showAlert}
                showConfirm={showConfirm}
                onMigrateSuccess={() => {
                  void window.electronAPI.saveConfig({ setupComplete: true }).then(() => onClose(true))
                }}
              />
            </div>
          </>)}

          <div className={step === 1 ? undefined : "hidden"}>
            <ChannelStep agentResourceId={agentResourceId} onNext={() => { setChannelsDone(true); goto(2) }} />
          </div>

          {step === 2 && (<>
            <h2 className="text-lg font-semibold text-fg">第 3 步：装点工具（可选）</h2>
            <p className="mt-2 text-sm leading-relaxed text-fg-3">
              给 AI 装上飞书的手脚：装完并登录后，AI 能帮你读写飞书文档、查日历、管理飞书项目。
              也可以以后在 设置 → 工具箱 里随时安装。
            </p>
            <p className="mt-2 rounded-lg border border-warning-line/40 bg-warning-tint/30 px-3 py-2 text-xs leading-relaxed text-warning-bright/90">
              一键安装需要本机已装 <span className="font-medium text-warning-bright">Node.js</span>
              （<a href="https://nodejs.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">nodejs.org</a>
              ，安装时勾选 Add to PATH）。新电脑若未安装，点安装会失败并在下方提示原因。
              {toolStatus && toolStatus.nodeOk === false && <span className="mt-1 block text-danger-soft">当前未检测到 Node.js。</span>}
              {toolStatus?.nodeOk && toolStatus.nodeVersion && <span className="mt-1 block text-success/80">已检测到 Node v{toolStatus.nodeVersion}</span>}
            </p>
            <div className="mt-6 space-y-3">
              {(["larkCli", "meegle"] as const).map((key) => {
                const meta = key === "larkCli" ? { label: "飞书（lark-cli）", desc: "文档 / 日历 / 消息 / 表格" } : { label: "飞书项目（meegle）", desc: "飞书项目（Meegle）管理" }
                const st = key === "larkCli" ? toolStatus?.larkCli : toolStatus?.meegle
                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border border-line-subtle px-4 py-3">
                    <div>
                      <p className="text-sm text-fg-soft">{meta.label}</p>
                      <p className="text-xs text-fg-faint">{meta.desc}</p>
                    </div>
                    {!toolStatus ? <Loader2 size={13} className="animate-spin text-fg-muted" />
                      : st?.installed ? <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={13} />已安装</span>
                      : (
                        <button onClick={() => void installTool(key)} disabled={!!toolBusy}
                          className="flex items-center gap-1 rounded-md border border-blue-600/50 bg-blue-600/10 px-2.5 py-1 text-xs text-accent-soft hover:bg-blue-600/20 disabled:opacity-50">
                          {toolBusy === key ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                          {toolBusy === key ? "安装中..." : "一键安装"}
                        </button>
                      )}
                  </div>
                )
              })}
            </div>
            {toolErr && <p className="mt-3 text-xs leading-relaxed text-danger">{toolErr}</p>}
            <button onClick={() => void finish(true)} className="mt-8 flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-green-500">
              <CheckCircle2 size={15} />{anyToolInstalled ? "完成，开始使用" : "跳过，开始使用"}
            </button>
          </>)}

        </div>
      </div>
      {ModalPortal}
    </div>
  )
}
