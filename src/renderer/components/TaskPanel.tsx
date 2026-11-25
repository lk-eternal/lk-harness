import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Plus, Loader2, Play, Trash2 } from "lucide-react"
import ModelPicker from "./chat/ModelPicker"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_ADD_BAR, PANEL_ADD_BTN, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"
import { useScrollActiveIntoView } from "./panel-scroll"
import { useOpenFirstOnce } from "./panel-default"
import { applyTaskModel, prefillTaskModel, taskModelProblem, taskResourceMissing } from "./task-model"
import { applyNotifyChannel } from "./task-notify-form"
import { useModelFavorites } from "../hooks/useModelFavorites"
import { isAiTask, taskNotifyChannelId } from "../../shared/scheduled-task-rules"
import {
  describeAiTaskProgress,
  describeTaskDelivery,
  taskAgentTargetLabel,
  toUserNotifyTask,
  validateTaskDelivery,
  type TaskDeliveryCheckEnv,
  type TaskDeliveryLabels,
} from "../../shared/task-delivery"
import { describeLastRun, describeRun, runTone, sortTasksForList, type TaskRunLog } from "../../shared/task-run-log-rules"
import { RUN_TONE_CLASS } from "./run-tone"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-focus"

interface ProjectOption { id: string; name: string; archived: boolean }

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
  const [tasksReady, setTasksReady] = useState(false)
  const [taskChannels, setTaskChannels] = useState<ChannelConfig[]>([])
  const [agentResources, setAgentResources] = useState<AgentResource[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [taskStatuses, setTaskStatuses] = useState<Record<string, { running: boolean }>>({})
  const [taskRuns, setTaskRuns] = useState<TaskRunLog>({})
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
    const [list, cfg, statuses, runs, projectList] = await Promise.all([
      window.electronAPI.getScheduledTasks(),
      window.electronAPI.getConfig(),
      window.electronAPI.getScheduledTaskStatus(),
      window.electronAPI.getScheduledTaskRuns(),
      window.electronAPI.listProjects().catch(() => []),
    ])
    setTasks(list)
    setTaskChannels(cfg.channels ?? [])
    setAgentResources(cfg.agentResources ?? [])
    setTaskStatuses(statuses)
    setTaskRuns(runs)
    setProjects(projectList.map((p) => ({ id: p.id, name: p.name, archived: p.archived })))
    setTasksReady(true)
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

  /** 没选通道 = 第一个启用的通道（与 daemon 的取法一致），校验 / 描述 / 模型补全按它算 */
  const defaultChannelId = taskChannels.find((c) => c.enabled)?.id ?? taskChannels[0]?.id
  const withEffectiveChannel = <T extends ScheduledTask>(t: T): T => ({ ...t, channelId: t.channelId || defaultChannelId })

  const openDraft = (opened: ScheduledTask, asNew: boolean) => {
    // 模型在表单里是显式的：旧任务没配（原来跟随通道）的，按它现在实际在用的补上；补上的算打开时的基线，不算「未保存的修改」
    const t = isAiTask(opened) ? opened : prefillTaskModel(opened, taskChannels, agentResources, opened.channelId || defaultChannelId)
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

  const draftResourceMissing = draft ? taskResourceMissing(draft, agentResources) : false

  // 通知的通道（同时也是任务跑在哪个通道、按哪个通道的规则运行）：旧任务单独存的发送通道优先，没有就是任务的通道，再没有就是默认通道
  const notifyChannelId = draft ? (taskNotifyChannelId(draft) ?? defaultChannelId) : undefined
  const notifyChannel = taskChannels.find((c) => c.id === notifyChannelId)
  const notifyIsApp = notifyChannel?.type === "app"

  const labels: TaskDeliveryLabels = {
    channelName: (id) => taskChannels.find((c) => c.id === id)?.name,
    projectName: (id) => projects.find((p) => p.id === id)?.name,
    isAppChannel: (id) => taskChannels.find((c) => c.id === id)?.type === "app",
  }
  const checkEnv: TaskDeliveryCheckEnv = {
    channelIsApp: (id) => taskChannels.find((c) => c.id === id)?.type === "app",
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
    // 用户建的任务只有一种交付方式：独立运行 + 通知我。旧版的交付方式（非独立 / 不通知 / 通知 AI / 绑项目）在这里转过来，
    // 通道落成实际用的那个（旧任务没选通道时，保存后不再随「第一个通道」变）；再检查模型和结果送不送得到
    const normalized = withEffectiveChannel(toUserNotifyTask(draft))
    const problem = taskModelProblem(normalized, agentResources) ?? validateTaskDelivery(normalized, checkEnv)
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

  /** 启用 / 停用：只改 enabled 这一项，表单里没保存的修改既不会被带着存下去，也不会被丢掉 */
  const handleToggle = async () => {
    if (!draft || isNew) return
    const enabled = !draft.enabled
    const updated = tasks.map((t) => t.id === draft.id ? { ...t, enabled } : t)
    await window.electronAPI.saveScheduledTasks(updated)
    setTasks(updated)
    setDraft({ ...draft, enabled })
    setSavedSnapshot(JSON.stringify({ ...(JSON.parse(savedSnapshot) as ScheduledTask), enabled }))
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

  const deliveryHint = draft ? describeTaskDelivery(withEffectiveChannel(draft), labels) : ""
  const ai = draft ? isAiTask(draft) : false

  const now = Date.now()
  const draftRuns = draft ? (taskRuns[draft.id] ?? []) : []

  // 列表顺序：停用的在最后，其余按最近一次执行的时间排（刚执行完的在最前面）
  const orderedTasks = useMemo(() => sortTasksForList(tasks, taskRuns), [tasks, taskRuns])

  const listRef = useRef<HTMLDivElement>(null)
  useScrollActiveIntoView(listRef, selectedId, tasks.length)
  useOpenFirstOnce(tasksReady, orderedTasks, selectedId !== null || draft !== null, (t) => openDraft(t, false))

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_ADD_BAR}>
            <button type="button" onClick={openAdd} className={PANEL_ADD_BTN}>
              <Plus size={14} />添加
            </button>
          </div>
          <div ref={listRef} className={PANEL_LIST}>
            {orderedTasks.map((t) => {
              const active = selectedId === t.id
              const isRunning = !!taskStatuses[t.id]?.running
              const lastRun = taskRuns[t.id]?.[0]
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void selectTask(t)}
                  aria-current={active ? "true" : undefined}
                  className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left text-sm transition ${active ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}
                >
                  <span className={`truncate text-xs font-medium ${t.enabled ? "" : "line-through opacity-60"}`}>{isAiTask(t) ? "🤖 " : ""}{t.name || "未命名"}</span>
                  <span className="truncate font-mono text-[10px] text-fg-faint">{t.cron}</span>
                  {lastRun && <span className={`truncate text-[10px] ${RUN_TONE_CLASS[runTone(lastRun.kind)]}`}>{describeLastRun(taskRuns[t.id], now)}</span>}
                  {isRunning && <span className="mt-0.5 text-[10px] text-success">运行中</span>}
                </button>
              )
            })}
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
                  <input type="text" value={draft.cron} readOnly={ai} onChange={(e) => { setDraft({ ...draft, cron: e.target.value }); setTaskCronValid(true) }} className={inputCls + (!taskCronValid ? " border-danger" : "")} placeholder="0 9 * * 1-5" />
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
                {!isNew && (
                  <div className="rounded-lg border border-line-subtle bg-surface/80 px-3 py-2">
                    <p className="text-xs font-medium text-fg-muted">最近运行</p>
                    {draftRuns.length === 0 ? (
                      <p className="mt-1 text-xs text-fg-faint">还没有记录，到点触发后会显示在这里</p>
                    ) : (
                      <ul className="mt-1.5 space-y-0.5 text-[11px]">
                        {draftRuns.slice(0, 8).map((r, i) => (
                          <li key={`${r.at}-${i}`} className={RUN_TONE_CLASS[runTone(r.kind)]}>{describeRun(r, now)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div><label className="mb-1 block text-xs text-fg-muted">任务内容</label>
                  <textarea value={draft.content} readOnly={ai} onChange={(e) => setDraft({ ...draft, content: e.target.value })} rows={6} className={inputCls + " font-mono text-xs leading-relaxed"} placeholder="要独立 Agent 去做的事，做完让它提交结果…" /></div>

                {ai ? (
                  <div className="rounded-lg border border-line-subtle bg-surface/80 px-3 py-2 text-xs leading-relaxed text-fg-3">{deliveryHint}</div>
                ) : (
                  <>
                    <div className="space-y-3 rounded-lg border border-line-subtle bg-surface/60 px-3 py-3">
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

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="mb-1 block text-xs text-fg-muted" title="任务按这个通道的规则运行，结果也从这个通道发给你">通知通道</label>
                          <select
                            value={notifyChannelId ?? ""}
                            onChange={(e) => setDraft(applyNotifyChannel(draft, e.target.value || undefined, taskChannels, agentResources))}
                            className={inputCls}
                          >
                            {!notifyChannel && <option value={notifyChannelId ?? ""}>{notifyChannelId ? "（通道已不存在）" : "请选择通道"}</option>}
                            {taskChannels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? "" : "（已停用）"}</option>)}
                          </select>
                        </div>
                        {notifyChannel?.type === "feishu" ? (
                          <div>
                            <div className="mb-1 flex items-center gap-2 text-xs text-fg-muted">
                              <span>飞书会话 ID（可选）</span>
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
                              placeholder="不填 = 发到通道绑定的主用户私聊"
                            />
                          </div>
                        ) : (
                          <p className="self-end pb-2 text-xs text-fg-faint">
                            {notifyIsApp ? "结果发到这个任务专属的会话，没有会自动创建。" : "发到通道绑定的主用户私聊。"}
                          </p>
                        )}
                      </div>

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
                    <button type="button" onClick={() => void handleTrigger()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-accent hover:bg-primary/20"><Play size={13} />立即执行</button>
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
                      className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-success-solid text-white" : "bg-primary text-on-primary hover:bg-primary-hover"}`}>
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
