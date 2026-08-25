import { useState, useEffect, useCallback } from "react"
import { Plus, Trash2, Loader2, LogIn, Terminal, Wrench } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER, mcpEntryKey } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"
const MCP_TEMPLATE = JSON.stringify({ "my-mcp-server": { command: "npx", args: ["-y", "@some/mcp-server"] } }, null, 2)

interface McpEditForm { json: string; jsonError?: string }

type McpTool = { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }

function mcpToolTip(t: McpTool): string {
  const lines = [
    t.description,
    ...(t.params ?? []).map((p) => `${p.required ? "* " : ""}${p.name}${p.type ? `: ${p.type}` : ""}${p.description ? ` — ${p.description}` : ""}`),
  ].filter(Boolean)
  return lines.length ? lines.join("\n") : t.name
}

export default function McpPanel() {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [mcpLoading, setMcpLoading] = useState<Record<string, boolean>>({})
  const [mcpStatus, setMcpStatus] = useState<Record<string, string>>({})
  const [mcpTools, setMcpTools] = useState<Record<string, { loading: boolean; tools: McpTool[]; error?: string }>>({})
  const [mcpLoginPending, setMcpLoginPending] = useState<Record<string, boolean>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<McpEditForm | null>(null)
  const [originalName, setOriginalName] = useState<string | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)

  const reload = useCallback(async (force = false) => {
    const list = await window.electronAPI.getMcpServers()
    setServers(list.map((s) => ({ ...s, enabled: s.enabled ?? true })))
    setMcpStatus(Object.fromEntries(list.map((s) => [s.name, s.enabled !== false ? "ready" : "disabled"])))

    void Promise.all([
      window.electronAPI.getMcpEnabledMap(force),
      window.electronAPI.getMcpStatusMap(force),
    ]).then(([enabled, status]) => {
      setServers((prev) => prev.map((s) => ({ ...s, enabled: enabled[s.name] ?? s.enabled })))
      setMcpStatus(status)
    })
  }, [])

  const loadTools = useCallback((s: McpServerEntry, force = false) => {
    const key = mcpEntryKey(s.source, s.name)
    setMcpTools((p) => ({ ...p, [key]: { loading: true, tools: p[key]?.tools ?? [] } }))
    window.electronAPI.getMcpTools(s.name, force).then((res) => {
      setMcpTools((p) => ({ ...p, [key]: { loading: false, tools: res.tools, error: res.ok ? undefined : res.error } }))
    })
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const unsub = window.electronAPI.onMcpLoginComplete(({ serverName, ok }) => {
      if (ok) setServers((prev) => prev.map((s) => s.name === serverName ? { ...s, authenticated: true } : s))
    })
    return () => unsub()
  }, [])

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const openDraft = (s: McpServerEntry | null, form: McpEditForm, asNew: boolean) => {
    setSelectedKey(s ? mcpEntryKey("global", s.name) : null)
    setDraft(form)
    setOriginalName(s?.name ?? null)
    setSavedSnapshot(JSON.stringify(form))
    setIsNew(asNew)
  }

  const selectServer = async (s: McpServerEntry) => {
    if (isDirty && !(await showConfirm("未保存", "当前 MCP 有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    const inner = s.rawConfig ?? {}
    openDraft(s, { json: JSON.stringify({ [s.name]: inner }, null, 2) }, false)
    loadTools(s)
  }

  const openAdd = async () => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，继续新增？", "继续", "取消"))) return
    openDraft(null, { json: MCP_TEMPLATE }, true)
  }

  const handleToggle = async () => {
    if (!currentServer) return
    const { name, enabled } = currentServer
    const next = !enabled
    setServers((prev) => prev.map((s) => mcpEntryKey(s.source, s.name) === selectedKey ? { ...s, enabled: next } : s))
    setMcpLoading((p) => ({ ...p, [selectedKey!]: true }))
    const res = await window.electronAPI.toggleMcp(name, next)
    setMcpLoading((p) => ({ ...p, [selectedKey!]: false }))
    if (!res.ok) {
      setServers((prev) => prev.map((s) => mcpEntryKey(s.source, s.name) === selectedKey ? { ...s, enabled: !next } : s))
      void showAlert("错误", res.output || `MCP ${next ? "启用" : "禁用"}失败`)
    }
  }

  const handleLogin = (name: string) => {
    setMcpLoginPending((p) => ({ ...p, [name]: true }))
    window.electronAPI.loginMcp(name).then((res) => {
      setMcpLoginPending((p) => ({ ...p, [name]: false }))
      if (res.ok) setServers((prev) => prev.map((s) => s.name === name ? { ...s, authenticated: true } : s))
    })
  }

  const handleSave = async () => {
    if (!draft) return
    const setErr = (msg: string) => setDraft({ ...draft, jsonError: msg })
    let raw = draft.json.trim()
    if (raw.startsWith('"') && !raw.startsWith("{")) raw = `{${raw}}`
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(raw) } catch { setErr("JSON 格式无效"); return }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { setErr("JSON 必须是一个对象"); return }
    if ("mcpServers" in parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers !== null) {
      parsed = parsed.mcpServers as Record<string, unknown>
    }
    const keys = Object.keys(parsed)
    if (keys.length !== 1) { setErr("一次只能保存一个 MCP 服务器"); return }
    const name = keys[0]
    const entry = parsed[name]
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) { setErr(`"${name}" 的值必须是一个对象`); return }
    const isNewEntry = !originalName
    if (originalName && originalName !== name) {
      await window.electronAPI.deleteMcpServer(originalName, "global")
    }
    await window.electronAPI.saveMcpServer(name, entry as Record<string, unknown>, "global")
    if (isNewEntry) await window.electronAPI.toggleMcp(name, true)
    markSaved()
    await reload(true)
    const saved = { name, type: ("url" in (entry as object) ? "url" : "command") as "url" | "command", source: "global" as const, rawConfig: entry as Record<string, unknown>, enabled: true, authenticated: false } as McpServerEntry
    openDraft(saved, { json: JSON.stringify({ [name]: entry }, null, 2) }, false)
    loadTools(saved, true)
  }

  const handleDelete = async () => {
    if (!currentServer || isNew) return
    if (!(await showConfirm("删除 MCP", `确定删除「${currentServer.name}」（${currentServer.source === "global" ? "全局" : "项目"}）？`))) return
    await window.electronAPI.deleteMcpServer(currentServer.name, "global")
    await reload()
    setSelectedKey(null)
    setDraft(null)
  }

  const handleCancel = async () => {
    if (isDirty && !(await showConfirm("未保存", "放弃未保存的修改？", "放弃", "取消"))) return
    if (isNew) { setSelectedKey(null); setDraft(null) }
    else setDraft(JSON.parse(savedSnapshot) as McpEditForm)
  }

  const currentServer = selectedKey ? servers.find((s) => mcpEntryKey("global", s.name) === selectedKey) : null
  const toolState = selectedKey ? mcpTools[selectedKey] : undefined

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_LIST}>
            {servers.map((s) => {
              const key = mcpEntryKey("global", s.name)
              const rawStatus = mcpStatus[s.name]
              const isReady = rawStatus === "ready" || rawStatus === "enabled"
              const statusText = s.enabled ? (isReady ? "ready" : rawStatus || "—") : "disabled"
              return (
                <button key={key} type="button" onClick={() => void selectServer(s)}
                  className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left transition ${selectedKey === key ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}>
                  <span className="truncate text-xs font-medium">{s.name}</span>
                  <span className={`truncate text-[10px] text-gray-600`}>{statusText}</span>
                </button>
              )
            })}
            <button type="button" onClick={() => void openAdd()}
              className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-700 py-2 text-xs text-gray-500 hover:border-gray-600 hover:bg-gray-800/40 hover:text-gray-300">
              <Plus size={14} />添加
            </button>
          </div>
        </aside>

        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs text-gray-500">配置 JSON（~/.cursor/mcp.json）</label>
                    <div className="flex items-center gap-2">
                      {currentServer?.type === "url" && currentServer.enabled && !currentServer.authenticated && (
                        mcpLoginPending[currentServer.name]
                          ? <span className="text-xs text-blue-400"><Loader2 size={12} className="inline animate-spin" /> 认证中</span>
                          : <button type="button" onClick={() => handleLogin(currentServer.name)} className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"><LogIn size={12} />授权</button>
                      )}
                    </div>
                  </div>
                  <textarea value={draft.json} onChange={(e) => setDraft({ ...draft, json: e.target.value, jsonError: undefined })}
                    rows={14} spellCheck={false} className={inputCls + " font-mono text-xs leading-relaxed" + (draft.jsonError ? " border-red-500" : "")} />
                  {draft.jsonError && <p className="mt-1 text-xs text-red-400">{draft.jsonError}</p>}
                </div>
                {currentServer && (
                  <div className="rounded-lg border border-gray-800 bg-gray-900/30 px-3 py-2">
                    <p className="mb-1.5 text-xs font-medium text-gray-500">Tools</p>
                    {!toolState ? <p className="text-xs text-gray-500"><Loader2 size={12} className="inline animate-spin" /> 加载中…</p>
                      : toolState.loading ? <p className="text-xs text-gray-500"><Loader2 size={12} className="inline animate-spin" /> 加载中…</p>
                      : toolState.error ? <p className="text-xs text-gray-500">{toolState.error}</p>
                      : toolState.tools.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {toolState.tools.map((t) => (
                            <span key={t.name} title={mcpToolTip(t)} className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-0.5 text-[11px] text-gray-300">
                              <Wrench size={10} className="text-gray-500" />{t.name}
                            </span>
                          ))}
                        </div>
                      ) : <p className="text-xs text-gray-500">无已注册工具</p>}
                  </div>
                )}
              </div>
              <div className={PANEL_FOOTER}>
                <div className="flex items-center gap-2">
                  {!isNew && currentServer && (
                    <>
                      <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>
                      <button type="button" onClick={() => void handleToggle()} disabled={!!mcpLoading[selectedKey!]}
                        className={`rounded-md px-2.5 py-1.5 text-xs transition ${currentServer.enabled ? "text-green-400 hover:bg-gray-800" : "text-gray-500 hover:bg-gray-800"}`}>
                        {currentServer.enabled ? "已启用" : "已停用"}
                      </button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择 MCP</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
