import { useState, useEffect } from "react"
import { Plus, Trash2, Upload } from "lucide-react"
import SortableList from "./SortableList"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"

import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

export type ProjectNodeItem = { id: string; label: string; prompt?: string; defaultPrompt?: string; hubId?: string; hubRevision?: number; hubContentHash?: string; localRevision?: number }

interface Props {
  nodes: ProjectNodeItem[]
  onSaveNodes: (nodes: ProjectNodeItem[]) => Promise<void>
  hubConfigured?: boolean
  groupId?: string
  onUploadNode?: (nodeId: string) => Promise<void>
}

export default function ProjectNodePanel({ nodes, onSaveNodes, hubConfigured, groupId, onUploadNode }: Props) {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<(ProjectNodeItem & { index: number }) | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [isNew, setIsNew] = useState(false)

  useEffect(() => {
    if (selectedIndex !== null && nodes[selectedIndex]) {
      const n = nodes[selectedIndex]
      const d = { ...n, index: selectedIndex }
      setDraft(d)
      setSavedSnapshot(JSON.stringify(d))
      setIsNew(false)
    }
  }, [nodes, selectedIndex])

  const isDirty = draft ? JSON.stringify(draft) !== savedSnapshot : false

  const selectNode = async (index: number) => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    setSelectedIndex(index)
  }

  const openAdd = async () => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，继续新增？", "继续", "取消"))) return
    const d = { id: "", label: "", index: -1 }
    setDraft(d)
    setSavedSnapshot(JSON.stringify(d))
    setIsNew(true)
    setSelectedIndex(null)
  }

  const handleSave = async () => {
    if (!draft || !draft.id.trim() || !draft.label.trim()) return
    const reserved = ["help", "menu", "ls", "list", "use", "leave", "info", "new", "del", "delete", "rm", "setup", "sync", "ship"]
    const id = draft.id.trim()
    if (reserved.includes(id) || !/^[a-z][a-z0-9-]*$/.test(id)) {
      void showAlert("节点 id 不可用", `「${id}」需小写字母开头，且不能与保留命令冲突`)
      return
    }
    if (nodes.some((n, j) => n.id === id && j !== draft.index)) {
      void showAlert("无法保存", "节点 id 与组内已有节点重复")
      return
    }
    const raw = (draft.prompt ?? "").trim()
    const promptVal = raw && raw !== (draft.defaultPrompt ?? "").trim() ? raw : undefined
    const item: ProjectNodeItem = { id, label: draft.label.trim(), prompt: promptVal }
    const next: ProjectNodeItem[] = draft.index < 0
      ? [...nodes, item]
      : nodes.map((n, j) => j === draft.index ? { ...n, ...item } : n)
    await onSaveNodes(next)
    markSaved()
    const idx = draft.index < 0 ? next.length - 1 : draft.index
    setSelectedIndex(idx)
    setIsNew(false)
  }

  const handleDelete = async () => {
    if (!draft || draft.index < 0) return
    if (!(await showConfirm("删除节点", `确定删除「${draft.label || draft.id}」？`))) return
    await onSaveNodes(nodes.filter((_, j) => j !== draft.index))
    setDraft(null)
    setSelectedIndex(null)
  }

  return (
    <>
      <div className={PANEL_ROOT} style={{ minHeight: 320 }}>
        <aside className="flex w-44 shrink-0 flex-col border-r border-gray-800 pl-2 pr-2">
          <SortableList
            items={nodes}
            getId={(n) => n.id}
            onReorder={onSaveNodes}
            gapClass="space-y-1 flex-1 overflow-y-auto min-h-0"
            renderItem={(n, { grip }) => {
              const idx = nodes.findIndex((x) => x.id === n.id)
              return (
                <div className={`flex items-center gap-1 rounded-md transition ${selectedIndex === idx ? "bg-gray-800/70" : "hover:bg-gray-800/40"}`}>
                  {grip}
                  <button type="button" onClick={() => void selectNode(idx)} className="min-w-0 flex-1 py-2 pr-2 text-left">
                    <span className="block truncate text-xs text-gray-200">{n.label}</span>
                    <span className="font-mono text-[10px] text-gray-600">/p {n.id}</span>
                  </button>
                </div>
              )
            }}
          />
          <button type="button" onClick={() => void openAdd()}
            className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-700 py-2 text-xs text-gray-500 hover:border-gray-600 hover:bg-gray-800/40">
            <Plus size={14} />添加节点
          </button>
        </aside>
        <div className={PANEL_MAIN}>
          {draft ? (
            <>
              <div className={PANEL_SCROLL}>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="mb-1 block text-xs text-gray-500">节点 id</label>
                    <input type="text" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.trim() })} className={inputCls} placeholder="test-report" /></div>
                  <div><label className="mb-1 block text-xs text-gray-500">按钮名称</label>
                    <input type="text" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className={inputCls} placeholder="测试报告" /></div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-gray-500">节点提示词</label>
                  <textarea rows={14} value={draft.prompt ?? draft.defaultPrompt ?? ""} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                    className={inputCls + " font-mono text-xs leading-relaxed"} />
                </div>
              </div>
              <div className={PANEL_FOOTER}>
                <div className="flex items-center gap-2">
                  {draft.index >= 0 && hubConfigured && onUploadNode && (
                    <button type="button" onClick={() => void onUploadNode(draft.id)} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-blue-400 hover:bg-gray-800">
                      <Upload size={13} />上传
                    </button>
                  )}
                  {draft.index >= 0 && (
                    <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => { setDraft(null); setSelectedIndex(null) }} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave()} disabled={!draft.id.trim() || !draft.label.trim()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择节点</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
