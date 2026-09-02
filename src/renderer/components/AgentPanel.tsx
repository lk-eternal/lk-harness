import { useState, useEffect, useCallback, useRef } from "react"
import {
  Plus, Trash2, Loader2, ShieldCheck, ShieldAlert, Eye, EyeOff,
  KeyRound, Cloud, Globe,
} from "lucide-react"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"
import PanelAddMenu from "./PanelAddMenu"
import { BUILTIN_LLM_PROVIDERS, builtinProviderLabel } from "../../shared/agent-providers"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

type AddKind = "sdk" | "llm-builtin" | "llm-custom"

function newResourceId(prefix: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${prefix}_${hex}`
}

function resourceIcon(r: AgentResource) {
  if (r.type === "sdk") return <KeyRound size={14} className="shrink-0 text-purple-400" />
  if (r.type === "llm-custom") return <Globe size={14} className="shrink-0 text-amber-400" />
  return <Cloud size={14} className="shrink-0 text-sky-400" />
}

function resourceSubtitle(r: AgentResource): string {
  if (r.type === "sdk") return r.email || "Cursor SDK"
  if (r.type === "llm-custom") return r.baseUrl || "自定义网关"
  return builtinProviderLabel(r.providerId)
}

function emptyResource(kind: AddKind, providerId?: string): AgentResource {
  if (kind === "sdk") {
    const n = 1
    return { id: newResourceId("sdk"), type: "sdk", name: `Cursor SDK ${n}`, apiKey: "" }
  }
  if (kind === "llm-custom") {
    return {
      id: newResourceId("llm"),
      type: "llm-custom",
      name: "自定义网关",
      baseUrl: "",
      apiKey: "",
    }
  }
  const label = builtinProviderLabel(providerId)
  return {
    id: newResourceId("llm"),
    type: "llm-builtin",
    name: label,
    providerId: providerId ?? "openai",
    apiKey: "",
  }
}

function agentDirtyKey(r: AgentResource): string {
  const { email: _e, ...rest } = r
  return JSON.stringify(rest)
}

function AgentModelsList({ draft, refreshKey }: { draft: AgentResource; refreshKey: number }) {
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        if (draft.type === "sdk") {
          if (!draft.apiKey?.trim()) {
            setModels([])
            setError(null)
            return
          }
          const r = await window.electronAPI.listSdkModels(draft.apiKey.trim())
          if (cancelled) return
          if (!r.ok) { setModels([]); setError(r.error ?? "加载失败"); return }
          setModels(r.models.map((m) => ({ id: m.id, label: m.label || m.id })))
          return
        }
        if (draft.type === "llm-builtin" || draft.type === "llm-custom") {
          if (draft.type === "llm-custom" && (!draft.apiKey?.trim() || !draft.baseUrl?.trim())) {
            setModels([])
            setError(null)
            return
          }
          if (draft.type === "llm-builtin" && !draft.apiKey?.trim()) {
            const r = await window.electronAPI.listLlmModels({ ...draft, apiKey: "" })
            if (cancelled) return
            if (r.ok) setModels(r.models.map((m) => ({ id: m.id, label: m.label || m.id })))
            else setModels([])
            return
          }
          const r = await window.electronAPI.listLlmModels(draft)
          if (cancelled) return
          if (!r.ok) { setModels([]); setError(r.error ?? "加载失败"); return }
          setModels(r.models.map((m) => ({ id: m.id, label: m.label || m.id })))
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [draft, refreshKey])

  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">可用模型{models.length > 0 ? ` (${models.length})` : ""}</label>
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-gray-500"><Loader2 size={12} className="animate-spin" />加载中...</div>
      ) : error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : models.length === 0 ? (
        <p className="text-xs text-gray-600">填写凭据后将自动加载；自定义网关需 Base URL + Key。</p>
      ) : (
        <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/50 px-2 py-1.5">
          {models.map((m) => (
            <li key={m.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-gray-300" title={m.label}>{m.label}</span>
              <span className="shrink-0 font-mono text-[10px] text-gray-600">{m.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function AgentPanel() {
  const [resources, setResources] = useState<AgentResource[]>([])
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentResource | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; email?: string; error?: string } | null>(null)
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()

  const reload = useCallback(async () => {
    const cfg = await window.electronAPI.getConfig()
    setResources((cfg.agentResources ?? []).filter((r) => r.type !== "cli"))
    setChannels(cfg.channels ?? [])
  }, [])

  useEffect(() => { void reload() }, [reload])

  const persistAll = async (next: AgentResource[]) => {
    setResources(next)
    await window.electronAPI.saveConfig({ agentResources: next })
  }

  const openDraft = (r: AgentResource, asNew: boolean) => {
    setSelectedId(r.id)
    setDraft({ ...r })
    setSavedSnapshot(JSON.stringify(r))
    setIsNew(asNew)
    setVerifyResult(null)
    setShowKey(false)
  }

  const isDirty = (() => {
    if (!draft) return false
    if (!savedSnapshot) return isNew
    try {
      return agentDirtyKey(draft) !== agentDirtyKey(JSON.parse(savedSnapshot) as AgentResource)
    } catch {
      return true
    }
  })()

  const selectItem = async (id: string) => {
    if (id === selectedId && draft?.id === id) return
    if (isDirty && !(await showConfirm("未保存", "当前有未保存的修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    const r = resources.find((x) => x.id === id)
    if (r) openDraft(r, false)
  }

  const openAdd = (kind: AddKind, providerId?: string) => {
    setShowAddMenu(false)
    const sdkCount = resources.filter((r) => r.type === "sdk").length
    const r = emptyResource(kind, providerId)
    if (kind === "sdk") r.name = `Cursor SDK ${sdkCount + 1}`
    openDraft(r, true)
  }

  const handleDelete = async () => {
    if (!draft) return
    const usedBy = channels.filter((c) => c.agentResourceId === draft.id)
    if (usedBy.length > 0) {
      void showAlert("无法删除", `该资源正在被通道使用：${usedBy.map((c) => c.name).join("、")}。请先调整通道的 Agent 绑定。`)
      return
    }
    if (!await showConfirm("删除确认", `确定删除「${draft.name}」吗？`)) return
    const next = resources.filter((r) => r.id !== draft.id)
    await persistAll(next)
    setSelectedId(null)
    setDraft(null)
    setIsNew(false)
  }

  const handleVerify = async () => {
    if (!draft?.apiKey?.trim()) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      if (draft.type === "sdk") {
        const r = await window.electronAPI.checkSdkApiKey(draft.apiKey.trim())
        setVerifyResult(r)
        if (r.ok && r.email) setDraft((d) => d ? { ...d, email: r.email } : d)
        if (r.ok) setModelsRefreshKey((k) => k + 1)
      } else if (draft.type === "llm-builtin" || draft.type === "llm-custom") {
        const r = await window.electronAPI.verifyLlmResource({ ...draft, apiKey: draft.apiKey.trim() })
        setVerifyResult(r)
        if (r.ok && r.email) setDraft((d) => d ? { ...d, email: r.email } : d)
      } else {
        setVerifyResult({ ok: false, error: "该类型不支持验证" })
      }
    } catch (e) {
      setVerifyResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setVerifying(false)
    }
  }

  const validateDraft = (): string | null => {
    if (!draft) return "无内容"
    if (!draft.name.trim()) return "请填写名称"
    if (draft.type === "sdk" && !draft.apiKey?.trim()) return "请填写 API Key"
    if (draft.type === "llm-builtin" && !draft.apiKey?.trim()) return "请填写 API Key"
    if (draft.type === "llm-custom") {
      if (!draft.baseUrl?.trim()) return "请填写 Base URL"
      if (!draft.apiKey?.trim()) return "请填写 API Key"
    }
    return null
  }

  const handleSave = async () => {
    if (!draft) return
    const err = validateDraft()
    if (err) { void showAlert("无法保存", err); return }
    const normalized: AgentResource = {
      ...draft,
      name: draft.name.trim(),
      apiKey: draft.apiKey?.trim(),
      baseUrl: draft.baseUrl?.trim(),
    }
    const exists = resources.some((r) => r.id === normalized.id)
    const next = exists ? resources.map((r) => r.id === normalized.id ? normalized : r) : [...resources, normalized]
    await persistAll(next)
    setSavedSnapshot(JSON.stringify(normalized))
    setIsNew(false)
    markSaved()
  }

  const usedByCount = draft ? channels.filter((c) => c.agentResourceId === draft.id).length : 0

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_LIST}>
            {resources.map((r) => {
              const active = draft ? draft.id === r.id : selectedId === r.id
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => void selectItem(r.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ${active ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}
                >
                  {resourceIcon(r)}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{r.name}</p>
                    <p className="truncate text-[10px] text-gray-600">{resourceSubtitle(r)}</p>
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
                <button type="button" onClick={() => openAdd("sdk")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
                  <KeyRound size={12} className="text-purple-400" />Cursor SDK
                </button>
                <div className="my-1 border-t border-gray-800" />
                {BUILTIN_LLM_PROVIDERS.map((p) => (
                  <button key={p.id} type="button" onClick={() => openAdd("llm-builtin", p.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
                    <Cloud size={12} className="text-sky-400" />{p.label}
                  </button>
                ))}
                <div className="my-1 border-t border-gray-800" />
                <button type="button" onClick={() => openAdd("llm-custom")} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
                  <Globe size={12} className="text-amber-400" />自定义网关
                </button>
              </PanelAddMenu>
            </div>
          </div>
        </aside>

        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <h3 className="text-sm font-medium text-gray-200">{draft.name || "新 Agent"}</h3>
                {usedByCount > 0 && (
                  <p className="mt-1 text-xs text-blue-400">{usedByCount} 个通道使用中</p>
                )}

                <div className="mt-4 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">名称</label>
                    <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} />
                  </div>

                  {draft.type === "sdk" && (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">API Key</label>
                        <div className="relative">
                          <input type={showKey ? "text" : "password"} value={draft.apiKey ?? ""} onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setVerifyResult(null) }} placeholder="crsr_..." className={inputCls + " pr-9"} />
                          <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                        </div>
                        <p className="mt-1.5 text-xs text-gray-500">
                          还没有 Key？前往{" "}
                          <a href="https://cursor.com/dashboard/api?section=user-keys#user-api-keys" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Cursor Dashboard</a>
                          {" "}创建。
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => void handleVerify()} disabled={verifying || !draft.apiKey?.trim()} className="flex items-center gap-1 rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                          {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                          {verifying ? "验证中..." : "验证"}
                        </button>
                        {verifyResult?.ok && <span className="flex items-center gap-1 text-xs text-green-400"><ShieldCheck size={13} />有效{verifyResult.email ? ` (${verifyResult.email})` : ""}</span>}
                        {verifyResult && !verifyResult.ok && <span className="flex items-center gap-1 text-xs text-red-400"><ShieldAlert size={13} />{verifyResult.error}</span>}
                      </div>
                    </>
                  )}

                  {draft.type === "llm-builtin" && (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">供应商</label>
                        <input type="text" readOnly value={builtinProviderLabel(draft.providerId)} className={inputCls + " text-gray-500"} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">API Key</label>
                        <div className="relative">
                          <input type={showKey ? "text" : "password"} value={draft.apiKey ?? ""} onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setVerifyResult(null) }} className={inputCls + " pr-9"} />
                          <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => void handleVerify()} disabled={verifying || !draft.apiKey?.trim()} className="flex items-center gap-1 rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                          {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                          {verifying ? "验证中..." : "验证"}
                        </button>
                        {verifyResult?.ok && <span className="flex items-center gap-1 text-xs text-green-400"><ShieldCheck size={13} />有效{verifyResult.email ? ` (${verifyResult.email})` : ""}</span>}
                        {verifyResult && !verifyResult.ok && <span className="flex items-center gap-1 text-xs text-red-400"><ShieldAlert size={13} />{verifyResult.error}</span>}
                      </div>
                    </>
                  )}

                  {draft.type === "llm-custom" && (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Base URL</label>
                        <input type="text" value={draft.baseUrl ?? ""} onChange={(e) => { setDraft({ ...draft, baseUrl: e.target.value }); setVerifyResult(null) }} placeholder="https://opencode.ai/zen/v1" className={inputCls} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">API Key</label>
                        <div className="relative">
                          <input type={showKey ? "text" : "password"} value={draft.apiKey ?? ""} onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setVerifyResult(null) }} className={inputCls + " pr-9"} />
                          <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => void handleVerify()} disabled={verifying || !draft.apiKey?.trim() || !draft.baseUrl?.trim()} className="flex items-center gap-1 rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-300 transition hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                          {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                          {verifying ? "验证中..." : "验证"}
                        </button>
                        {verifyResult?.ok && <span className="flex items-center gap-1 text-xs text-green-400"><ShieldCheck size={13} />有效{verifyResult.email ? ` (${verifyResult.email})` : ""}</span>}
                        {verifyResult && !verifyResult.ok && <span className="flex items-center gap-1 text-xs text-red-400"><ShieldAlert size={13} />{verifyResult.error}</span>}
                      </div>
                    </>
                  )}

                  <AgentModelsList draft={draft} refreshKey={modelsRefreshKey} />
                </div>
              </div>
              <div className={PANEL_FOOTER}>
                <div>
                  {!isNew && (
                    <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 transition hover:bg-red-950/30">
                      <Trash2 size={13} />删除
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => { setDraft(null); setSelectedId(null); setIsNew(false) }} className="rounded-md px-4 py-1.5 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-white">取消</button>
                  <button type="button" onClick={() => void handleSave()} className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className={PANEL_SCROLL}>
              <p className="text-sm text-gray-500">从左侧选择 Agent，或点击「添加」新建。</p>
            </div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
