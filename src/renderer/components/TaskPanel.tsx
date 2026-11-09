import { useState, useEffect, useCallback, useRef } from "react"
import { Plus, Loader2, Play, Trash2 } from "lucide-react"
import ModelPicker from "./chat/ModelPicker"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"
import { applyTaskChannel, applyTaskModel, resolveTaskResourceId, taskResourceMissing } from "./task-model"
import { useModelFavorites } from "../hooks/useModelFavorites"
import { isAiTask, resolveTaskNotify, type TaskNotify } from "../../shared/scheduled-task-rules"
import {
  describeAiTaskProgress,
  describeTaskDelivery,
  normalizeTaskDelivery,
  taskAgentTargetLabel,
  validateTaskDelivery,
  type TaskDeliveryCheckEnv,
  type TaskDeliveryLabels,
} from "../../shared/task-delivery"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface ProjectOption { id: string; name: string; status: string }

const NOTIFY_OPTIONS: { value: TaskNotify; label: string }[] = [
  { value: "none", label: "不通知（只执行）" },
  { value: "agent", label: "通知到 Agent 会话" },
  { value: "im", label: "通知到 IM 聊天（飞书 / 微信）" },
]

function emptyTask(channels: ChannelConfig[]): ScheduledTask {
  return {
    id: crypto.randomUUID(), name: "", cron: "", content: "", enabled: true, independent: true,
    notify: "im",
    channelId: channels.find((c) => c.enabled)?.id ?? channels[0]?.id,
  }
}

export default function TaskPanel() {
  const { showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const { quickModels, favorites, refresh: refreshModels, toggleFavorite } = useModelFavorites()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [taskChannels, setTaskChannels] = useState<ChannelConfig[]>([])
  const [agentResources, setAgentResources] = useState<AgentResource[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [taskStatuses, setTaskStatuses] = useState<Record<string, { running: boolean }>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ScheduledTask | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)
  const [taskCronValid, setTaskCronValid] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [cronPreviewRuns, setCronPreviewRuns] = useState<string[] | null>(null)
  const [cronPreviewErr, setCronPreviewErr] = useState<string | null>(null)
  const [cronPreviewLoading, setCronPreviewLoading] = useState(false)
  const cronPreviewReq = useRef(0)

  const reload = useCallback(async () => {
    const [list, cfg, statuses, projectList] = await Promise.all([
      window.electronAPI.getScheduledTasks(),
      window.electronAPI.getConfig(),
      window.electronAPI.getScheduledTaskStatus(),
      window.electronAPI.listProjects().catch(() => []),
    ])
    setTasks(list)
    setTaskChannels(cfg.channels ?? [])
    setAgentResources(cfg.agentResources ?? [])
    setTaskStatuses(statuses)
    setProjects(projectList.map((p) => ({ id: p.id, name: p.name, status: p.status })))
  }, [])

  useEffect(() => { void reload() }, [reload])

  // AI 会自己建 / 清理排程：界面开着时定期刷新列表（不动正在编辑的草稿）
  useEffect(() => {
    const timer = setInterval(() => { void reload() }, 15_000)
    return () => clearInterval(timer)
  }, [reload])

  useEffect(() => {
    const unsub = window.electronAPI.onScheduledTaskStatus(setTaskStatuses)
    return () => unsub?.()
  }, [])

  useEffect(() => {
    if (!actionNote) return
    const t = setTimeout(() => setActionNote(null), 6000)
    return () => clearTimeout(t)
  }, [actionNote])

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const openDraft = (t: ScheduledTask, asNew: boolean) => {
    setSelectedId(t.id)
    setDraft({ ...t })
    setSavedSnapshot(JSON.stringify(t))
    setIsNew(asNew)
    setTaskCronValid(true)
    setSaveError(null)
    setActionNote(null)
  }

  const selectTask = async (t: ScheduledTask) => {
    if (isDirty) {
      const choice = await showUnsavedChoice("未保存", "当前任务有未保存的修改，怎么办？", { save: "保存并切换" })
      if (choice === "cancel") return
      if (choice === "save" && !(await handleSave())) return
    }
    openDraft(t, false)
  }

  /** 任务所属通道的供应商：选择器里「跟随通道」那一项列的是它家的模型 */
  const draftChannelResourceId = draft ? resolveTaskResourceId(taskChannels, agentResources, draft.channelId) : undefined
  const draftResourceMissing = draft ? taskResourceMissing(draft, agentResources) : false

  /** 所属通道选「默认」= 第一个启用的通道（与 daemon 的取法一致），校验 / 描述按它算 */
  const defaultChannelId = taskChannels.find((c) => c.enabled)?.id ?? taskChannels[0]?.id
  const withEffectiveChannel = <T extends ScheduledTask>(t: T): T => ({ ...t, channelId: t.channelId || defaultChannelId })

  const labels: TaskDeliveryLabels = {
    channelName: (id) => taskChannels.find((c) => c.id === id)?.name,
    projectName: (id) => projects.find((p) => p.id === id)?.name,
  }
  const checkEnv: TaskDeliveryCheckEnv = {
    projectExists: (id) => projects.some((p) => p.id === id),
    channelExists: (id) => taskChannels.some((c) => c.id === id),
    channelMainUserBound: (id) => {
      const c = taskChannels.find((x) => x.id === id)
      return c ? !!(c.mainUserEnabled && c.mainUserChatId?.trim()) : undefined
    },
    channelName: (id) => taskChannels.find((c) => c.id === id)?.name,
  }

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
    if (!draft || !draft.name.trim() || !draft.cron.trim()) return false
    const valid = await window.electronAPI.validateCron(draft.cron.trim())
    setTaskCronValid(valid)
    if (!valid) return false
    // 清掉当前通知方式用不到的字段（切换方式后残留的聊天 ID / 项目绑定不该悄悄生效），再检查结果送不送得到
    const normalized = normalizeTaskDelivery(draft)
    const problem = validateTaskDelivery(withEffectiveChannel(normalized), checkEnv)
    setSaveError(problem ?? null)
    if (problem) return false
    const exists = tasks.find((t) => t.id === normalized.id)
    const updated = exists ? tasks.map((t) => t.id === normalized.id ? normalized : t) : [...tasks, normalized]
    await window.electronAPI.saveScheduledTasks(updated)
    setTasks(updated)
    setDraft(normalized)
    setSavedSnapshot(JSON.stringify(normalized))
    setIsNew(false)
    markSaved()
    return true
  }

  const handleCancel = async () => {
    if (isDirty) {
      const choice = await showUnsavedChoice("未保存", "当前任务有未保存的修改，怎么办？", { save: "保存", discard: "放弃" })
      if (choice === "cancel") return
      if (choice === "save" && !(await handleSave())) return
    }
    if (isNew) {
      setSelectedId(null)
      setDraft(null)
    } else {
      setDraft(JSON.parse(savedSnapshot) as ScheduledTask)
      setSaveError(null)
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
    const r = await window.electronAPI.triggerScheduledTask(draft.id)
    setActionNote(r.ok
      ? { ok: true, text: "已触发，结果按任务的通知方式送达" }
      : { ok: false, text: `触发失败：${r.error ?? "未知原因"}` })
  }

  const handleCancelAi = async () => {
    if (!draft || !isAiTask(draft)) return
    if (!(await showConfirm("取消 AI 排程", `确定取消「${draft.name}」？取消后不会再触发。`))) return
    const r = await window.electronAPI.cancelAiScheduledTask(draft.id)
    if (!r.ok) {
      setActionNote({ ok: false, text: `取消失败：${r.error ?? "未知原因"}` })
      return
    }
    setSelectedId(null)
    setDraft(null)
    await reload()
  }

  const openAdd = async () => {
    if (isDirty) {
      const choice = await showUnsavedChoice("未保存", "当前任务有未保存的修改，怎么办？", { save: "保存并继续" })
      if (choice === "cancel") return
      if (choice === "save" && !(await handleSave())) return
    }
    openDraft(emptyTask(taskChannels), true)
  }

  const independent = draft ? draft.independent !== false : true
  const notifyMode: TaskNotify = draft ? resolveTaskNotify(draft) : "none"
  const needsAgentTarget = !!draft && (!independent || notifyMode === "agent")
  const deliveryHint = draft ? describeTaskDelivery(withEffectiveChannel(draft), labels) : ""
  const ai = draft ? isAiTask(draft) : false

  /** Agent 会话选择：空 = 所属通道的主会话；已完成的项目不再提供（已选的保留，保存时提示它已不可用） */
  const agentTargetSelect = draft && (
    <select
      value={draft.targetProjectId ?? ""}
      onChange={(e) => setDraft({ ...draft, targetProjectId: e.target.value || undefined })}
      className={inputCls}
    >
      <option value="">主会话（所属通道的主用户私聊）</option>
      {draft.targetProjectId && !projects.some((p) => p.id === draft.targetProjectId) && (
        <option value={draft.targetProjectId}>（项目已不存在）</option>
      )}
      {projects
        .filter((p) => p.status !== "done" || p.id === draft.targetProjectId)
        .map((p) => (
          <option key={p.id} value={p.id}>
            项目「{p.name}」的会话{p.status === "paused" ? "（已暂停）" : ""}
          </option>
        ))}
    </select>
  )

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
                  className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left text-sm transition ${active ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}
                >
                  <span className={`truncate text-xs font-medium ${t.enabled ? "" : "line-through opacity-60"}`}>{isAiTask(t) ? "🤖 " : ""}{t.name || "未命名"}</span>
                  <span className="truncate font-mono text-[10px] text-fg-faint">{t.cron}</span>
                  {isRunning && <span className="mt-0.5 text-[10px] text-success">运行中</span>}
                </button>
              )
            })}
            <button
              type="button"
              onClick={openAdd}
              className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted transition hover:border-line-strong hover:bg-raised/40 hover:text-fg-2"
            >
              <Plus size={14} />添加
            </button>
          </div>
        </aside>

        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                {ai && (
                  <div className="rounded-lg border border-line bg-raised/40 px-3 py-2 text-xs leading-relaxed text-fg-3">
                    <p className="font-medium text-fg-2">🤖 AI 给自己排的定时任务</p>
                    <p className="mt-0.5">由 AI 在会话里创建，这里只能查看、立即执行或取消；到次数 / 过期后会自动清理。</p>
                    <p className="mt-0.5 text-fg-muted">
                      来源：{taskAgentTargetLabel(draft, labels)} · {describeAiTaskProgress(draft)}
                    </p>
                  </div>
                )}
                <div><label className="mb-1 block text-xs text-fg-muted">任务名称</label>
                  <input type="text" value={draft.name} readOnly={ai} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="日报推送" /></div>
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">Cron 表达式</label>
                  <input type="text" value={draft.cron} readOnly={ai} onChange={(e) => { setDraft({ ...draft, cron: e.target.value }); setTaskCronValid(true) }} className={inputCls + (!taskCronValid ? " border-red-500" : "")} placeholder="0 9 * * 1-5" />
                  {!taskCronValid && <p className="mt-1 text-xs text-danger">Cron 表达式无效</p>}
                  <div className="mt-2 rounded-lg border border-line-subtle bg-surface/80 px-3 py-2">
                    <p className="text-xs font-medium text-fg-muted">最近 5 次触发</p>
                    {cronPreviewLoading && <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />计算中…</p>}
                    {!cronPreviewLoading && cronPreviewErr && <p className="mt-1 text-xs text-warning/90">{cronPreviewErr}</p>}
                    {cronPreviewRuns && cronPreviewRuns.length > 0 && (
                      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 font-mono text-[11px] text-fg-3">
                        {cronPreviewRuns.map((line, i) => <li key={`${line}-${i}`}>{line}</li>)}
                      </ol>
                    )}
                  </div>
                </div>
                <div><label className="mb-1 block text-xs text-fg-muted">{independent ? "任务内容（给独立 Agent 的指令）" : "消息内容（发给 Agent 会话）"}</label>
                  <textarea value={draft.content} readOnly={ai} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={6} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder={independent ? "要独立 Agent 去做的事，做完让它提交结果…" : "要发送给 Agent 会话的消息..."} /></div>

                {ai ? (
                  <div className="rounded-lg border border-line-subtle bg-surface/80 px-3 py-2 text-xs leading-relaxed text-fg-3">{deliveryHint}</div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1 block text-xs text-fg-muted" title="决定任务用哪个通道的默认供应商 / 模型 / 规则；结果发到哪里在下面单独设置">所属通道</label>
                        <select value={draft.channelId ?? ""} onChange={(e) => setDraft(applyTaskChannel(draft, e.target.value || undefined, taskChannels, agentResources))} className={inputCls}>
                          <option value="">默认</option>
                          {taskChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-fg-muted">模型</label>
                        <ModelPicker
                          variant="field"
                          placement="down"
                          portal
                          resources={agentResources}
                          currentResourceId={draft.resourceId ?? ""}
                          currentModel={draft.model ?? ""}
                          currentParams={draft.modelParams}
                          followProvider="跟随通道"
                          followResourceId={draftChannelResourceId}
                          followModel="跟随通道主模型"
                          allowManual
                          placeholder="选择供应商 / 模型"
                          quickModels={quickModels}
                          favorites={favorites}
                          onToggleFavorite={toggleFavorite}
                          onOpen={() => void refreshModels()}
                          onSelect={(c) => setDraft(applyTaskModel(draft, c))}
                        />
                        {draftResourceMissing && (
                          <p className="mt-1 text-xs text-warning">任务选的供应商已不存在，运行会失败，请重新选择。</p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-3 rounded-lg border border-line-subtle bg-surface/60 px-3 py-3">
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 text-xs text-fg-3"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} className="rounded border-line-strong" />启用</label>
                        <label className="flex items-center gap-2 text-xs text-fg-3" title="勾选：每次由全新 Agent 执行，不占用任何会话的上下文；不勾选：任务内容直接发给一个 Agent 会话，由它自己执行"><input type="checkbox" checked={independent} onChange={(e) => setDraft({ ...draft, independent: e.target.checked })} className="rounded border-line-strong" />独立运行（每次全新 Agent）</label>
                      </div>

                      {independent && (
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted">完成后通知</label>
                          <select value={notifyMode} onChange={(e) => setDraft({ ...draft, notify: e.target.value as TaskNotify })} className={inputCls}>
                            {NOTIFY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      )}

                      {needsAgentTarget && (
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted">{independent ? "结果投给哪个 Agent 会话" : "任务内容发给哪个 Agent 会话"}</label>
                          {agentTargetSelect}
                        </div>
                      )}

                      {independent && notifyMode === "im" && (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="mb-1 block text-xs text-fg-muted">发送通道</label>
                            <select value={draft.notifyChannelId ?? ""} onChange={(e) => setDraft({ ...draft, notifyChannelId: e.target.value || undefined })} className={inputCls}>
                              <option value="">同所属通道{taskChannels.find((c) => c.id === (draft.channelId || defaultChannelId)) ? `（${taskChannels.find((c) => c.id === (draft.channelId || defaultChannelId))!.name}）` : ""}</option>
                              {taskChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          </div>
                          <div>
                            <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
                              <span>飞书群 / 聊天 ID（可选）</span>
                              <span
                                className="cursor-help text-accent/90 underline decoration-dotted underline-offset-2"
                                title="可在飞书会话中(需保证机器人在会话中)点击右上角设置,滚动到最下方,复制会话ID即可"
                              >
                                如何获取?
                              </span>
                            </div>
                            <input
                              type="text"
                              value={draft.notifyChatId ?? ""}
                              onChange={(e) => setDraft({ ...draft, notifyChatId: e.target.value.trim() || undefined })}
                              className={inputCls + " font-mono text-xs"}
                              placeholder="不填 = 发到发送通道绑定的主用户私聊"
                            />
                          </div>
                        </div>
                      )}

                      <p className="text-xs leading-relaxed text-fg-muted">{deliveryHint}</p>
                      {saveError && <p className="text-xs text-danger">{saveError}</p>}
                    </div>
                  </>
                )}
              </div>
              <div className={PANEL_FOOTER}>
                <div className="flex items-center gap-2">
                  {!isNew && ai && (
                    <button type="button" onClick={() => void handleCancelAi()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-danger hover:bg-danger-tint/30"><Trash2 size={13} />取消排程</button>
                  )}
                  {!isNew && !ai && (
                    <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-danger hover:bg-danger-tint/30"><Trash2 size={13} />删除</button>
                  )}
                  {!isNew && (
                    <button type="button" onClick={() => void handleTrigger()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-accent hover:bg-blue-600/20"><Play size={13} />立即执行</button>
                  )}
                  {!isNew && !ai && (
                    <button type="button" onClick={() => void handleToggle()} className={`rounded-md px-2.5 py-1.5 text-xs ${draft.enabled ? "text-success" : "text-fg-muted"}`}>{draft.enabled ? "已启用" : "已停用"}</button>
                  )}
                  {actionNote && <span className={`text-xs ${actionNote.ok ? "text-success" : "text-danger"}`}>{actionNote.text}</span>}
                </div>
                {!ai && (
                  <div className="flex items-center gap-2">
                    <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-fg-3 hover:bg-raised hover:text-fg">取消</button>
                    <button onClick={() => void handleSave()} disabled={!draft.name.trim() || !draft.cron.trim()}
                      className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                      {justSaved ? "已保存" : "保存"}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">← 选择任务</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
