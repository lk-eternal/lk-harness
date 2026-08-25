import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Loader2, RefreshCw, Play, Trash2 } from "lucide-react"
import SearchableSelect from "./SearchableSelect"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"
import { modelSlug } from "../model-utils"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface TaskItem {
  id: string; name: string; cron: string; content: string; enabled: boolean; independent?: boolean
  channelId?: string; model?: string; modelParams?: string; notifyChatId?: string
}

function emptyTask(channels: ChannelConfig[]): TaskItem {
  return {
    id: crypto.randomUUID(), name: "", cron: "", content: "", enabled: true, independent: true,
    channelId: channels.find((c) => c.enabled)?.id ?? channels[0]?.id,
  }
}

export default function TaskPanel() {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [taskChannels, setTaskChannels] = useState<ChannelConfig[]>([])
  const [agentResources, setAgentResources] = useState<AgentResource[]>([])
  const [taskStatuses, setTaskStatuses] = useState<Record<string, { running: boolean }>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<TaskItem | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)
  const [taskCronValid, setTaskCronValid] = useState(true)
  const [taskModelOptions, setTaskModelOptions] = useState<{ id: string; label: string; params: string }[]>([])
  const [loadingTaskModels, setLoadingTaskModels] = useState(false)
  const [cronPreviewRuns, setCronPreviewRuns] = useState<string[] | null>(null)
  const [cronPreviewErr, setCronPreviewErr] = useState<string | null>(null)
  const [cronPreviewLoading, setCronPreviewLoading] = useState(false)
  const cronPreviewReq = useRef(0)

  const reload = useCallback(async () => {
    const [list, cfg, statuses] = await Promise.all([
      window.electronAPI.getScheduledTasks(),
      window.electronAPI.getConfig(),
      window.electronAPI.getScheduledTaskStatus(),
    ])
    setTasks(list)
    setTaskChannels(cfg.channels ?? [])
    setAgentResources(cfg.agentResources ?? [])
    setTaskStatuses(statuses)
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const unsub = window.electronAPI.onScheduledTaskStatus(setTaskStatuses)
    return () => unsub?.()
  }, [])

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const openDraft = (t: TaskItem, asNew: boolean) => {
    setSelectedId(t.id)
    setDraft({ ...t })
    setSavedSnapshot(JSON.stringify(t))
    setIsNew(asNew)
    setTaskCronValid(true)
    setTaskModelOptions([])
  }

  const selectTask = async (t: TaskItem) => {
    if (isDirty && !(await showConfirm("未保存", "当前任务有未保存的修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    openDraft(t, false)
  }

  const fetchTaskModels = async (channelId?: string, silent = false) => {
    const channel = taskChannels.find((c) => c.id === channelId) ?? taskChannels[0]
    const resource = agentResources.find((r) => r.id === channel?.agentResourceId)
    setLoadingTaskModels(true)
    try {
      if (resource?.type === "sdk") {
        const r = await window.electronAPI.listSdkModels(resource.apiKey ?? "")
        if (r.ok && r.models.length > 0) setTaskModelOptions(r.models)
        else if (!r.ok && !silent) void showAlert("错误", r.error || "获取模型列表失败")
      } else {
        const r = await window.electronAPI.listModels()
        if (r.ok && r.models.length > 0) setTaskModelOptions(r.models.map((m) => ({ ...m, label: m.id, params: "" })))
        else if (!r.ok && !silent) void showAlert("错误", r.error || "获取模型列表失败")
      }
    } finally {
      setLoadingTaskModels(false)
    }
  }

  useEffect(() => {
    if (!draft) return
    setTaskModelOptions([])
    void fetchTaskModels(draft.channelId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.channelId])

  useEffect(() => {
    if (!draft) {
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
      setCronPreviewLoading(false)
      return
    }
    const cron = draft.cron.trim()
    if (!cron) {
      setCronPreviewRuns(null)
      setCronPreviewErr(null)
      return
    }
    const req = ++cronPreviewReq.current
    const t = setTimeout(async () => {
      if (req !== cronPreviewReq.current) return
      setCronPreviewLoading(true)
      setCronPreviewErr(null)
      try {
        const r = await window.electronAPI.previewCronNextRuns(cron)
        if (req !== cronPreviewReq.current) return
        if (r.ok) setCronPreviewRuns(r.runs)
        else { setCronPreviewRuns(null); setCronPreviewErr(r.error) }
      } finally {
        if (req === cronPreviewReq.current) setCronPreviewLoading(false)
      }
    }, 320)
    return () => clearTimeout(t)
  }, [draft?.cron, draft?.id])

  const handleSave = async () => {
    if (!draft || !draft.name.trim() || !draft.cron.trim()) return
    const valid = await window.electronAPI.validateCron(draft.cron.trim())
    setTaskCronValid(valid)
    if (!valid) return
    const exists = tasks.find((t) => t.id === draft.id)
    const updated = exists ? tasks.map((t) => t.id === draft.id ? draft : t) : [...tasks, draft]
    await window.electronAPI.saveScheduledTasks(updated)
    setTasks(updated)
    setSavedSnapshot(JSON.stringify(draft))
    setIsNew(false)
    markSaved()
  }

  const handleCancel = async () => {
    if (isDirty && !(await showConfirm("未保存", "放弃未保存的修改？", "放弃", "取消"))) return
    if (isNew) {
      setSelectedId(null)
      setDraft(null)
    } else {
      setDraft(JSON.parse(savedSnapshot) as TaskItem)
    }
  }

  const handleDelete = async () => {
    if (!draft || isNew) return
    if (!(await showConfirm("删除任务", `确定删除「${draft.name}」？`))) return
    const updated = tasks.filter((t) => t.id !== draft.id)
    await window.electronAPI.saveScheduledTasks(updated)
    setTasks(updated)
    setSelectedId(null)
    setDraft(null)
  }

  const handleToggle = async () => {
    if (!draft) return
    const next = { ...draft, enabled: !draft.enabled }
    setDraft(next)
    const updated = tasks.map((t) => t.id === draft.id ? next : t)
    await window.electronAPI.saveScheduledTasks(updated)
    setTasks(updated)
    setSavedSnapshot(JSON.stringify(next))
  }

  const handleTrigger = async () => {
    if (!draft || isNew) return
    await window.electronAPI.triggerScheduledTask(draft.id)
  }

  const openAdd = async () => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，继续新增？", "继续", "取消"))) return
    openDraft(emptyTask(taskChannels), true)
  }

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_LIST}>
            {tasks.map((t) => {
              const active = selectedId === t.id
              const isRunning = !!taskStatuses[t.id]?.running
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void selectTask(t)}
                  className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left text-sm transition ${active ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}
                >
                  <span className={`truncate text-xs font-medium ${t.enabled ? "" : "line-through opacity-60"}`}>{t.name || "未命名"}</span>
                  <span className="truncate font-mono text-[10px] text-gray-600">{t.cron}</span>
                  {isRunning && <span className="mt-0.5 text-[10px] text-green-400">运行中</span>}
                </button>
              )
            })}
            <button
              type="button"
              onClick={openAdd}
              className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-700 py-2 text-xs text-gray-500 transition hover:border-gray-600 hover:bg-gray-800/40 hover:text-gray-300"
            >
              <Plus size={14} />添加
            </button>
          </div>
        </aside>

        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <div><label className="mb-1 block text-xs text-gray-500">任务名称</label>
                  <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="日报推送" /></div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">Cron 表达式</label>
                  <input type="text" value={draft.cron} onChange={(e) => { setDraft({ ...draft, cron: e.target.value }); setTaskCronValid(true) }} className={inputCls + (!taskCronValid ? " border-red-500" : "")} placeholder="0 9 * * 1-5" />
                  {!taskCronValid && <p className="mt-1 text-xs text-red-400">Cron 表达式无效</p>}
                  <div className="mt-2 rounded-lg border border-gray-800 bg-gray-900/80 px-3 py-2">
                    <p className="text-xs font-medium text-gray-500">最近 5 次触发</p>
                    {cronPreviewLoading && <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500"><Loader2 size={12} className="animate-spin" />计算中…</p>}
                    {!cronPreviewLoading && cronPreviewErr && <p className="mt-1 text-xs text-amber-400/90">{cronPreviewErr}</p>}
                    {cronPreviewRuns && cronPreviewRuns.length > 0 && (
                      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 font-mono text-[11px] text-gray-400">
                        {cronPreviewRuns.map((line, i) => <li key={`${line}-${i}`}>{line}</li>)}
                      </ol>
                    )}
                  </div>
                </div>
                <div><label className="mb-1 block text-xs text-gray-500">消息内容</label>
                  <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={6} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="要发送给 Agent 的消息..." /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">消息通道</label>
                    <select value={draft.channelId ?? ""} onChange={(e) => { setDraft({ ...draft, channelId: e.target.value || undefined }); setTaskModelOptions([]) }} className={inputCls}>
                      <option value="">默认</option>
                      {taskChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <label className="text-xs text-gray-500">模型</label>
                      <button onClick={() => void fetchTaskModels(draft.channelId)} disabled={loadingTaskModels} className="text-[10px] text-gray-500 hover:text-white">
                        {loadingTaskModels ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                      </button>
                    </div>
                    {taskModelOptions.length > 0 ? (
                      <SearchableSelect
                        value={draft.model ? draft.model + (draft.modelParams ? "\0" + draft.modelParams : "") : ""}
                        onChange={(key) => {
                          if (!key) { setDraft({ ...draft, model: undefined, modelParams: undefined }); return }
                          const sep = key.indexOf("\0")
                          setDraft(sep >= 0 ? { ...draft, model: key.slice(0, sep), modelParams: key.slice(sep + 1) } : { ...draft, model: key, modelParams: undefined })
                        }}
                        options={[{ id: "", label: "跟随通道主模型" }, ...taskModelOptions.map((o) => ({ id: o.id + (o.params ? "\0" + o.params : ""), label: o.label }))]}
                        placeholder="跟随通道主模型"
                        fallbackLabel={modelSlug(draft.model, draft.modelParams)}
                      />
                    ) : (
                      <input type="text" value={modelSlug(draft.model, draft.modelParams)} onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined, modelParams: undefined })} placeholder="留空跟随通道主模型" className={inputCls} />
                    )}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">结果通知群（可选）</label>
                  <input type="text" value={draft.notifyChatId ?? ""} onChange={(e) => setDraft({ ...draft, notifyChatId: e.target.value.trim() || undefined })} className={inputCls + " font-mono text-xs"} placeholder="群 chat_id" />
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} className="rounded border-gray-600" />启用</label>
                  <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={draft.independent !== false} onChange={(e) => setDraft({ ...draft, independent: e.target.checked })} className="rounded border-gray-600" />独立运行</label>
                </div>
              </div>
              <div className={PANEL_FOOTER}>
                <div className="flex items-center gap-2">
                  {!isNew && (
                    <>
                      <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>
                      <button type="button" onClick={() => void handleTrigger()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-blue-400 hover:bg-blue-600/20"><Play size={13} />立即执行</button>
                      <button type="button" onClick={() => void handleToggle()} className={`rounded-md px-2.5 py-1.5 text-xs ${draft.enabled ? "text-green-400" : "text-gray-500"}`}>{draft.enabled ? "已启用" : "已停用"}</button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave()} disabled={!draft.name.trim() || !draft.cron.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择任务</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
