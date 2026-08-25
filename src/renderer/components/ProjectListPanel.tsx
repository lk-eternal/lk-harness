import { useState, useEffect, useCallback } from "react"
import { Trash2 } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

const STATUS_LABEL: Record<string, string> = { active: "进行中", paused: "已暂停", done: "已完成" }

interface ProjectListItem {
  id: string
  name: string
  goal?: string
  storyUrl?: string
  productDocUrl?: string
  techDocUrl?: string
  featureBranch: string
  status: string
  groupId?: string
  groupIds?: string[]
  worktreePath?: string
  repoPath?: string
  workspaceType?: string
  metadata?: Record<string, string>
  groupChatId?: string
}

interface NodeGroup { id: string; name: string }

function normalizeDraft(p: ProjectListItem, groups: NodeGroup[]): ProjectListItem {
  return {
    ...p,
    goal: p.goal ?? "",
    storyUrl: p.storyUrl ?? "",
    productDocUrl: p.productDocUrl ?? "",
    techDocUrl: p.techDocUrl ?? "",
    groupIds: p.groupIds?.length ? p.groupIds : (p.groupId ? [p.groupId] : groups[0]?.id ? [groups[0].id] : []),
  }
}

export default function ProjectListPanel() {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [nodeGroups, setNodeGroups] = useState<NodeGroup[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProjectListItem | null>(null)
  const [metadataText, setMetadataText] = useState("{}")
  const [savedSnapshot, setSavedSnapshot] = useState("")

  const reload = useCallback(async () => {
    const [list, groups] = await Promise.all([
      window.electronAPI.listProjects().catch(() => [] as ProjectListItem[]),
      window.electronAPI.getProjectNodeGroups(),
    ])
    setProjects(list)
    setNodeGroups(groups.map((g) => ({ id: g.id, name: g.name })))
  }, [])

  useEffect(() => { void reload() }, [reload])

  const isDirty = draft ? JSON.stringify({ draft, metadataText }) !== savedSnapshot : false

  const selectProject = async (p: ProjectListItem) => {
    if (isDirty && !(await showConfirm("未保存", "当前项目有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    const d = normalizeDraft(p, nodeGroups)
    setSelectedId(p.id)
    setDraft(d)
    setMetadataText(JSON.stringify(p.metadata ?? {}, null, 2))
    setSavedSnapshot(JSON.stringify({ draft: d, metadataText: JSON.stringify(p.metadata ?? {}, null, 2) }))
  }

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return
    let metadata: Record<string, string> | undefined
    try {
      const parsed = JSON.parse(metadataText || "{}") as unknown
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (!k.trim()) continue
          metadata[k] = String(v ?? "")
        }
        if (!Object.keys(metadata).length) metadata = undefined
      } else {
        void showAlert("错误", "metadata 必须是 JSON 对象")
        return
      }
    } catch {
      void showAlert("错误", "metadata JSON 格式无效")
      return
    }
    const r = await window.electronAPI.updateProject({
      id: draft.id,
      name: draft.name.trim(),
      goal: draft.goal?.trim() || "",
      storyUrl: draft.storyUrl?.trim() || "",
      productDocUrl: draft.productDocUrl?.trim() || "",
      techDocUrl: draft.techDocUrl?.trim() || "",
      status: draft.status,
      groupIds: draft.groupIds ?? [],
      metadata,
    })
    if (!r.ok) { void showAlert("错误", r.error ?? "保存失败"); return }
    const list = await window.electronAPI.listProjects().catch(() => [] as ProjectListItem[])
    setProjects(list)
    const updated = list.find((x) => x.id === draft.id)
    if (updated) {
      const d = normalizeDraft(updated, nodeGroups)
      setDraft(d)
      const meta = JSON.stringify(updated.metadata ?? {}, null, 2)
      setMetadataText(meta)
      setSavedSnapshot(JSON.stringify({ draft: d, metadataText: meta }))
    }
    markSaved()
  }

  const handleDelete = async () => {
    if (!draft) return
    if (!(await showConfirm("删除项目", `确定删除「${draft.name}」？\n将移除 AI 工作目录（含未提交改动）；主仓与远程分支不受影响。`, "删除", "取消"))) return
    const r = await window.electronAPI.deleteProject(draft.id)
    if (!r.ok) void showAlert("错误", r.error ?? "删除失败")
    else {
      setSelectedId(null)
      setDraft(null)
      await reload()
    }
  }

  const handleSwitch = async () => {
    if (!draft || draft.groupChatId) return
    const r = await window.electronAPI.switchProject(draft.id)
    if (!r.ok) void showAlert("错误", r.error ?? "切换失败")
    await reload()
  }

  const handleCancel = async () => {
    if (isDirty && !(await showConfirm("未保存", "放弃未保存的修改？", "放弃", "取消"))) return
    if (selectedId) {
      const p = projects.find((x) => x.id === selectedId)
      if (p) {
        const d = normalizeDraft(p, nodeGroups)
        setDraft(d)
        setMetadataText(JSON.stringify(p.metadata ?? {}, null, 2))
      }
    }
  }

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className={PANEL_LIST}>
            {projects.map((p) => (
              <button key={p.id} type="button" onClick={() => void selectProject(p)}
                className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left transition ${selectedId === p.id ? "bg-gray-800/70 font-medium text-white" : "text-gray-400 hover:bg-gray-800/40 hover:text-gray-200"}`}>
                <span className="truncate text-xs font-medium">{p.name}</span>
                <span className="truncate font-mono text-[10px] text-gray-600">{p.featureBranch}</span>
                <span className="text-[10px] text-gray-600">{STATUS_LABEL[p.status] ?? p.status}</span>
              </button>
            ))}
          </div>
        </aside>
        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <div><label className="mb-1 block text-xs text-gray-500">名称</label>
                  <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-gray-500">目标（可空）</label>
                  <textarea value={draft.goal ?? ""} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} rows={2} className={inputCls} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="mb-1 block text-xs text-gray-500">状态</label>
                    <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} className={inputCls}>
                      <option value="active">进行中</option>
                      <option value="paused">已暂停</option>
                      <option value="done">已完成</option>
                    </select></div>
                  <div className="col-span-2"><label className="mb-1 block text-xs text-gray-500">流程组（可多选）</label>
                    <div className="flex flex-wrap gap-2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2">
                      {nodeGroups.map((g) => {
                        const selected = (draft.groupIds ?? []).includes(g.id)
                        return (
                          <label key={g.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-300">
                            <input type="checkbox" checked={selected} onChange={(e) => {
                              const cur = draft.groupIds ?? []
                              const next = e.target.checked ? [...cur, g.id] : cur.filter((id) => id !== g.id)
                              setDraft({ ...draft, groupIds: next, groupId: next[0] })
                            }} className="rounded border-gray-600" />
                            {g.name}
                          </label>
                        )
                      })}
                    </div></div>
                </div>
                <div><label className="mb-1 block text-xs text-gray-500">飞书项目 / 需求链接</label>
                  <input type="text" value={draft.storyUrl ?? ""} onChange={(e) => setDraft({ ...draft, storyUrl: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-gray-500">产品文档</label>
                  <input type="text" value={draft.productDocUrl ?? ""} onChange={(e) => setDraft({ ...draft, productDocUrl: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-gray-500">技术文档</label>
                  <input type="text" value={draft.techDocUrl ?? ""} onChange={(e) => setDraft({ ...draft, techDocUrl: e.target.value })} className={inputCls} /></div>
                <div><label className="mb-1 block text-xs text-gray-500">metadata（JSON 对象）</label>
                  <textarea value={metadataText} onChange={(e) => setMetadataText(e.target.value)} rows={6} className={`${inputCls} font-mono text-xs`} /></div>
                <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-[11px] text-gray-500">
                  <p className="mb-1 text-gray-400">只读</p>
                  <p className="truncate">🌿 {draft.featureBranch || "—"}</p>
                  {draft.repoPath && <p className="truncate">📦 {draft.repoPath}</p>}
                  {draft.worktreePath && <p className="truncate">📁 {draft.worktreePath}</p>}
                </div>
              </div>
              <div className={PANEL_FOOTER}>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>
                  {!draft.groupChatId && (
                    <button type="button" onClick={() => void handleSwitch()} className="rounded-md px-2.5 py-1.5 text-xs text-blue-400 hover:bg-blue-600/20">切换至</button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void handleCancel()} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave()} disabled={!draft.name.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择项目</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
