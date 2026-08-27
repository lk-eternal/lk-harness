import { useState, useEffect, useCallback } from "react"
import {
  Plus, Pencil, Trash2, X, Loader2, ShieldCheck, ShieldAlert, LogIn, RefreshCw, Eye, EyeOff, Terminal, KeyRound, Cloud,
} from "lucide-react"
import useInlineModal from "./useInlineModal"
import { BUILTIN_LLM_PROVIDERS, builtinProviderLabel } from "../../shared/agent-providers"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

function newSdkId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `sdk_${hex}`
}

function newLlmId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `llm_${hex}`
}

function CliStatusPanel() {
  const [status, setStatus] = useState<{ checking: boolean; cliFound?: boolean; loggedIn?: boolean; identity?: string; error?: string }>({ checking: true })
  const [loggingIn, setLoggingIn] = useState(false)

  const refresh = useCallback(async (force = false) => {
    setStatus((s) => ({ ...s, checking: true }))
    try {
      const cliOk = await window.electronAPI.checkCli()
      if (!cliOk) { setStatus({ checking: false, cliFound: false }); return }
      const login = await window.electronAPI.checkCliLogin({ forceRefresh: force })
      setStatus({ checking: false, cliFound: login.cliFound, loggedIn: login.loggedIn, identity: login.identityLine, error: login.error })
    } catch (e) {
      setStatus({ checking: false, error: String(e) })
    }
  }, [])

  useEffect(() => { void refresh(true) }, [refresh])

  const handleReLogin = useCallback(async () => {
    setLoggingIn(true)
    try {
      await window.electronAPI.loginCli()
      await refresh(true)
    } finally {
      setLoggingIn(false)
    }
  }, [refresh])

  if (status.checking) return <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 size={12} className="animate-spin" />检测中...</div>
  if (!status.cliFound) return (
    <div className="rounded-lg border border-yellow-800/50 bg-yellow-900/20 px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-yellow-400"><ShieldAlert size={14} />未检测到 Cursor CLI</div>
      <p className="mt-1 text-xs text-gray-500">请确认已安装 Cursor 并将 CLI 添加到系统 PATH</p>
    </div>
  )
  return (
    <div className={`rounded-lg border px-4 py-3 ${status.loggedIn ? "border-green-800/50 bg-green-900/20" : "border-red-800/50 bg-red-900/20"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Terminal size={14} className="text-gray-400" />
          <span className="font-medium text-gray-200">Cursor CLI</span>
          {status.loggedIn ? <><ShieldCheck size={14} className="text-green-400" /><span className="text-green-400">已登录</span></> : <><ShieldAlert size={14} className="text-red-400" /><span className="text-red-400">未登录</span></>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void handleReLogin()} disabled={loggingIn} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-400 hover:bg-gray-800 disabled:opacity-50">
            {loggingIn ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
            {loggingIn ? "登录中..." : "重新登录"}
          </button>
          <button onClick={() => void refresh(true)} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-800">
            <RefreshCw size={12} />刷新
          </button>
        </div>
      </div>
      {status.identity && <p className="mt-1 text-xs text-gray-400">{status.identity}</p>}
      {status.error && <p className="mt-1 text-xs text-red-400">{status.error}</p>}
    </div>
  )
}

export default function AgentPanel() {
  const [resources, setResources] = useState<AgentResource[]>([])
  const [llmResources, setLlmResources] = useState<AgentResource[]>([])
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [editing, setEditing] = useState<AgentResource | null>(null)
  const [editingLlm, setEditingLlm] = useState<AgentResource | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [isNewLlm, setIsNewLlm] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; email?: string; error?: string } | null>(null)
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()

  const reload = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    const all = cfg.agentResources ?? []
    setResources(all.filter((r) => r.type === "sdk"))
    setLlmResources(all.filter((r) => r.type === "llm-builtin" || r.type === "llm-custom"))
    setChannels(cfg.channels ?? [])
  }, [])

  useEffect(() => { void reload() }, [reload])

  const persistAll = async (sdkList: AgentResource[], llmList: AgentResource[]) => {
    setResources(sdkList)
    setLlmResources(llmList)
    await window.electronAPI.saveConfig({
      agentResources: [{ id: "cli", type: "cli", name: "Cursor CLI" }, ...sdkList, ...llmList],
    })
  }

  const persist = async (sdkList: AgentResource[]) => {
    await persistAll(sdkList, llmResources)
  }

  const persistLlm = async (llmList: AgentResource[]) => {
    await persistAll(resources, llmList)
  }

  const openAdd = () => {
    setEditing({ id: newSdkId(), type: "sdk", name: `SDK Key ${resources.length + 1}`, apiKey: "" })
    setIsNew(true)
    setVerifyResult(null)
  }

  const openEdit = (r: AgentResource) => { setEditing({ ...r }); setIsNew(false); setVerifyResult(null) }

  const openAddLlm = (mode: "llm-builtin" | "llm-custom") => {
    setEditingLlm({
      id: newLlmId(),
      type: mode,
      name: mode === "llm-builtin" ? "DeepSeek" : "自定义网关",
      providerId: "deepseek",
      apiKey: "",
      baseUrl: "",
    })
    setIsNewLlm(true)
    setVerifyResult(null)
  }

  const openEditLlm = (r: AgentResource) => { setEditingLlm({ ...r }); setIsNewLlm(false); setVerifyResult(null) }

  const handleDelete = async (r: AgentResource) => {
    const usedBy = channels.filter((c) => c.agentResourceId === r.id)
    if (usedBy.length > 0) {
      void showAlert("无法删除", `该资源正在被通道使用：${usedBy.map((c) => c.name).join("、")}。请先调整通道的 Agent 资源绑定。`)
      return
    }
    if (!await showConfirm("删除确认", `确定删除「${r.name}」吗？`)) return
    await persist(resources.filter((x) => x.id !== r.id))
  }

  const handleDeleteLlm = async (r: AgentResource) => {
    const usedBy = channels.filter((c) => c.agentResourceId === r.id)
    if (usedBy.length > 0) {
      void showAlert("无法删除", `该资源正在被通道使用：${usedBy.map((c) => c.name).join("、")}。`)
      return
    }
    if (!await showConfirm("删除确认", `确定删除「${r.name}」吗？`)) return
    await persistLlm(llmResources.filter((x) => x.id !== r.id))
  }

  const handleVerify = async () => {
    if (!editing?.apiKey?.trim()) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const r = await window.electronAPI.checkSdkApiKey(editing.apiKey.trim())
      setVerifyResult(r)
      if (r.ok && r.email) setEditing((e) => e ? { ...e, email: r.email } : e)
    } finally {
      setVerifying(false)
    }
  }

  const handleVerifyLlm = async () => {
    if (!editingLlm?.apiKey?.trim()) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const r = await window.electronAPI.verifyLlmResource(editingLlm)
      setVerifyResult(r)
      if (r.ok && r.email) setEditingLlm((e) => e ? { ...e, email: r.email } : e)
    } finally {
      setVerifying(false)
    }
  }

  const handleSave = async () => {
    if (!editing || !editing.name.trim() || !editing.apiKey?.trim()) return
    const next = { ...editing, name: editing.name.trim(), apiKey: editing.apiKey.trim() }
    const exists = resources.some((r) => r.id === next.id)
    await persist(exists ? resources.map((r) => r.id === next.id ? next : r) : [...resources, next])
    setEditing(null)
  }

  const handleSaveLlm = async () => {
    if (!editingLlm || !editingLlm.name.trim() || !editingLlm.apiKey?.trim()) return
    if (editingLlm.type === "llm-custom" && !editingLlm.baseUrl?.trim()) return
    const next = { ...editingLlm, name: editingLlm.name.trim(), apiKey: editingLlm.apiKey.trim() }
    const exists = llmResources.some((r) => r.id === next.id)
    await persistLlm(exists ? llmResources.map((r) => r.id === next.id ? next : r) : [...llmResources, next])
    setEditingLlm(null)
  }

  return (
    <>
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-gray-300">Cursor CLI</h3>
        <p className="text-xs text-gray-600">本机 CLI 登录态，全局唯一；通道可绑定 CLI 作为 Agent 资源。</p>
        <CliStatusPanel />
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300">大模型 API</h3>
          <div className="flex-1" />
          <button onClick={() => openAddLlm("llm-builtin")} className="flex items-center gap-1 rounded-md border border-gray-600 px-2.5 py-1 text-xs text-gray-300 transition hover:border-blue-500"><Cloud size={12} />内置提供商</button>
          <button onClick={() => openAddLlm("llm-custom")} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />自定义网关</button>
        </div>
        <p className="text-xs text-gray-600">Pi 内嵌 Agent，飞书流式体验最佳。通道可分别绑定不同 LLM 资源。</p>
        <div className="space-y-2">
          {llmResources.map((r) => {
            const usedBy = channels.filter((c) => c.agentResourceId === r.id)
            const sub = r.type === "llm-builtin" ? builtinProviderLabel(r.providerId) : (r.baseUrl || "自定义")
            return (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Cloud size={15} className="shrink-0 text-sky-400" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{r.name}</p>
                      <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">{sub}</span>
                      {usedBy.length > 0 && <span className="shrink-0 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">{usedBy.length} 个通道</span>}
                    </div>
                    <p className="truncate font-mono text-xs text-gray-600">{r.apiKey ? `${r.apiKey.slice(0, 8)}...` : "(未配置)"}</p>
                  </div>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-2">
                  <button onClick={() => openEditLlm(r)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                  <button onClick={() => void handleDeleteLlm(r)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                </div>
              </div>
            )
          })}
          {llmResources.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无大模型资源，推荐添加 DeepSeek / OpenAI</p>}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300">Cursor SDK</h3>
          <div className="flex-1" />
          <button onClick={openAdd} className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500"><Plus size={12} />添加 SDK Key</button>
        </div>
        <p className="text-xs text-gray-600">可添加多个 Cursor API Key（不同账号），消息通道可分别绑定。</p>
        <div className="space-y-2">
          {resources.map((r) => {
            const usedBy = channels.filter((c) => c.agentResourceId === r.id)
            return (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-gray-700 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <KeyRound size={15} className="shrink-0 text-purple-400" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{r.name}</p>
                      {r.email && <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500">{r.email}</span>}
                      {usedBy.length > 0 && <span className="shrink-0 rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] text-blue-400">{usedBy.length} 个通道使用中</span>}
                    </div>
                    <p className="truncate font-mono text-xs text-gray-600">{r.apiKey ? `${r.apiKey.slice(0, 10)}...${r.apiKey.slice(-4)}` : "(未配置)"}</p>
                  </div>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-2">
                  <button onClick={() => openEdit(r)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-white"><Pencil size={13} /></button>
                  <button onClick={() => void handleDelete(r)} className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-red-400"><Trash2 size={13} /></button>
                </div>
              </div>
            )
          })}
          {resources.length === 0 && <p className="py-4 text-center text-xs text-gray-600">暂无 SDK Key</p>}
        </div>
      </section>

      {editingLlm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{isNewLlm ? "添加大模型" : "编辑大模型"}</h3>
              <button onClick={() => setEditingLlm(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="space-y-3 px-6 py-4">
              <div>
                <label className="mb-1 block text-xs text-gray-500">名称</label>
                <input type="text" value={editingLlm.name} onChange={(e) => setEditingLlm({ ...editingLlm, name: e.target.value })} className={inputCls} />
              </div>
              {editingLlm.type === "llm-builtin" && (
                <div>
                  <label className="mb-1 block text-xs text-gray-500">提供商</label>
                  <select value={editingLlm.providerId ?? "deepseek"} onChange={(e) => setEditingLlm({ ...editingLlm, providerId: e.target.value, name: builtinProviderLabel(e.target.value) })} className={inputCls}>
                    {BUILTIN_LLM_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              )}
              {editingLlm.type === "llm-custom" && (
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Base URL</label>
                  <input type="text" value={editingLlm.baseUrl ?? ""} onChange={(e) => setEditingLlm({ ...editingLlm, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" className={inputCls} />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs text-gray-500">API Key</label>
                <input type={showKey ? "text" : "password"} value={editingLlm.apiKey ?? ""} onChange={(e) => { setEditingLlm({ ...editingLlm, apiKey: e.target.value }); setVerifyResult(null) }} className={inputCls} />
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => void handleVerifyLlm()} disabled={verifying || !editingLlm.apiKey?.trim()} className="flex items-center gap-1 rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition hover:border-blue-500 disabled:opacity-50">
                  {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  {verifying ? "验证中..." : "验证"}
                </button>
                {verifyResult?.ok && <span className="text-xs text-green-400">有效</span>}
                {verifyResult && !verifyResult.ok && <span className="text-xs text-red-400">{verifyResult.error}</span>}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setEditingLlm(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800">取消</button>
              <button onClick={() => void handleSaveLlm()} disabled={!editingLlm.name.trim() || !editingLlm.apiKey?.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-200">{isNew ? "添加 SDK Key" : "编辑 SDK Key"}</h3>
              <button onClick={() => setEditing(null)} className="text-gray-500 hover:text-white"><X size={16} /></button>
            </div>
            <div className="space-y-3 px-6 py-4">
              <div>
                <label className="mb-1 block text-xs text-gray-500">名称</label>
                <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={inputCls} placeholder="如：个人号 / 工作号" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">API Key</label>
                <div className="relative">
                  <input type={showKey ? "text" : "password"} value={editing.apiKey ?? ""} onChange={(e) => { setEditing({ ...editing, apiKey: e.target.value }); setVerifyResult(null) }} placeholder="crsr_..." className={inputCls + " pr-9"} />
                  <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
                <p className="mt-1.5 text-xs text-gray-500">
                  还没有 Key？前往{" "}
                  <a href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Cursor Dashboard</a>
                  {" "}创建一个（登录后点 Create API Key，复制以 crsr_ 开头的字符串填到这里）。
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => void handleVerify()} disabled={verifying || !editing.apiKey?.trim()} className="flex items-center gap-1 rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                  {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  {verifying ? "验证中..." : "验证"}
                </button>
                {verifyResult?.ok && <span className="flex items-center gap-1 text-xs text-green-400"><ShieldCheck size={13} />有效{verifyResult.email ? ` (${verifyResult.email})` : ""}</span>}
                {verifyResult && !verifyResult.ok && <span className="flex items-center gap-1 text-xs text-red-400"><ShieldAlert size={13} />{verifyResult.error}</span>}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-800 px-6 py-4">
              <button onClick={() => setEditing(null)} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
              <button onClick={() => void handleSave()} disabled={!editing.name.trim() || !editing.apiKey?.trim()} className="rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </div>
        </div>
      )}
      {ModalPortal}
    </>
  )
}
