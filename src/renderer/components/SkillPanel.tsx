import { useState, useEffect, useCallback } from "react"
import { Plus, Trash2, ChevronRight, ChevronDown, Folder, FileText } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface SkillFile { rootId: string; skillPath: string; name: string; content: string }

type EditMode =
  | { kind: "skill"; skillPath: string; name: string; content: string; originalPath: string | null; isNew: boolean }
  | { kind: "file"; skillPath: string; relativePath: string; content: string }

export default function SkillPanel() {
  const { showAlert, showConfirm, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [skillRoots, setSkillRoots] = useState<{ id: string; label: string; path: string; skillCount: number }[]>([])
  const [skillRootId, setSkillRootId] = useState("cursor")
  const [skills, setSkills] = useState<SkillFile[]>([])
  const [skillTree, setSkillTree] = useState<SkillTreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<EditMode | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")

  const reloadRoots = useCallback(() => {
    window.electronAPI.getSkillRoots().then((roots) => {
      setSkillRoots(roots)
      if (!roots.some((r) => r.id === skillRootId) && roots[0]) setSkillRootId(roots[0].id)
    })
  }, [skillRootId])

  const reloadSkills = useCallback(() => {
    window.electronAPI.getSkills(skillRootId).then(setSkills)
    window.electronAPI.getSkillTree(skillRootId).then(setSkillTree)
  }, [skillRootId])

  useEffect(() => { reloadRoots() }, [reloadRoots])
  useEffect(() => { reloadSkills() }, [reloadSkills])

  const isDirty = edit ? JSON.stringify(edit) !== savedSnapshot : false

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const selectSkill = async (s: SkillFile) => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    const mode: EditMode = { kind: "skill", skillPath: s.skillPath, name: s.skillPath, content: s.content, originalPath: s.skillPath, isNew: false }
    setEdit(mode)
    setSavedSnapshot(JSON.stringify(mode))
  }

  const openFile = async (skillPath: string, relativePath: string) => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，切换将丢弃。继续？", "丢弃", "取消"))) return
    const res = await window.electronAPI.readSkillFile(skillRootId, skillPath, relativePath)
    if (!res.ok) { void showAlert("读取失败", res.error ?? ""); return }
    const mode: EditMode = { kind: "file", skillPath, relativePath, content: res.content ?? "" }
    setEdit(mode)
    setSavedSnapshot(JSON.stringify(mode))
  }

  const openAdd = async () => {
    if (isDirty && !(await showConfirm("未保存", "有未保存修改，继续新增？", "继续", "取消"))) return
    const mode: EditMode = { kind: "skill", skillPath: "", name: "", content: "", originalPath: null, isNew: true }
    setEdit(mode)
    setSavedSnapshot(JSON.stringify(mode))
  }

  const handleSave = async () => {
    if (!edit) return
    if (edit.kind === "skill") {
      if (!edit.name.trim()) return
      const newPath = edit.name.trim()
      if (edit.originalPath && edit.originalPath !== newPath) {
        await window.electronAPI.renameSkill(skillRootId, edit.originalPath, newPath)
      }
      await window.electronAPI.saveSkill(skillRootId, newPath, edit.content)
      reloadRoots(); reloadSkills()
      const mode: EditMode = { kind: "skill", skillPath: newPath, name: newPath, content: edit.content, originalPath: newPath, isNew: false }
      setEdit(mode)
      setSavedSnapshot(JSON.stringify(mode))
    } else {
      await window.electronAPI.saveSkillFile(skillRootId, edit.skillPath, edit.relativePath, edit.content)
      setSavedSnapshot(JSON.stringify(edit))
    }
    markSaved()
  }

  const handleDelete = async () => {
    if (!edit) return
    if (edit.kind === "skill") {
      if (edit.isNew) { setEdit(null); return }
      if (!(await showConfirm("删除 Skill", `确定删除「${edit.skillPath}」？`))) return
      await window.electronAPI.deleteSkill(skillRootId, edit.skillPath)
    } else {
      if (!(await showConfirm("删除文件", `确定删除「${edit.relativePath}」？`))) return
      await window.electronAPI.deleteSkillFile(skillRootId, edit.skillPath, edit.relativePath)
    }
    reloadRoots(); reloadSkills()
    setEdit(null)
  }

  const renderTree = (nodes: SkillTreeNode[], skillPath: string, parentPath: string, depth: number): React.ReactNode => {
    return nodes.map((node) => {
      const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name
      const nodeKey = `${skillRootId}:${skillPath}/${fullPath}`
      if (node.type === "directory") {
        const open = expanded.has(nodeKey)
        return (
          <div key={nodeKey}>
            <button type="button" onClick={() => toggleExpand(nodeKey)} style={{ paddingLeft: `${depth * 12 + 4}px` }}
              className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs text-gray-400 hover:bg-gray-800/50 hover:text-gray-200">
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Folder size={12} className="text-blue-400/70" />{node.name}
            </button>
            {open && node.children && renderTree(node.children, skillPath, fullPath, depth + 1)}
          </div>
        )
      }
      return (
        <button key={nodeKey} type="button" onClick={() => void openFile(skillPath, fullPath)} style={{ paddingLeft: `${depth * 12 + 16}px` }}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs text-gray-500 hover:bg-gray-800/50 hover:text-gray-200">
          <FileText size={11} />{node.name}
        </button>
      )
    })
  }

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {skillRoots.map((root) => (
              <button key={root.id} type="button" onClick={() => { setSkillRootId(root.id); setExpanded(new Set()); setEdit(null) }}
                className={`rounded border px-1.5 py-0.5 text-[10px] transition ${skillRootId === root.id ? "border-blue-500 bg-blue-500/10 text-white" : "border-gray-700 text-gray-500 hover:bg-gray-800"}`}>
                {root.label}
              </button>
            ))}
          </div>
          <div className={PANEL_LIST}>
            {skills.map((s) => {
              const skillKey = `${skillRootId}:${s.skillPath}`
              const isOpen = expanded.has(skillKey)
              const tree = skillTree.find((t) => t.name === s.skillPath)
              return (
                <div key={skillKey}>
                  <div className="flex items-center gap-0.5">
                    <button type="button" onClick={() => toggleExpand(skillKey)} className="rounded p-0.5 text-gray-600 hover:text-gray-300">
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <button type="button" onClick={() => void selectSkill(s)} className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs transition ${edit?.kind === "skill" && edit.skillPath === s.skillPath ? "bg-gray-800/70 text-white" : "text-gray-400 hover:bg-gray-800/40"}`}>
                      {s.name}
                    </button>
                  </div>
                  {isOpen && tree?.children && renderTree(tree.children, s.skillPath, "", 1)}
                </div>
              )
            })}
            <button type="button" onClick={() => void openAdd()}
              className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-700 py-2 text-xs text-gray-500 hover:border-gray-600 hover:bg-gray-800/40">
              <Plus size={14} />添加
            </button>
          </div>
        </aside>
        <div className={PANEL_MAIN}>
          {edit ? (
            <>
              <div className={PANEL_SCROLL}>
                {edit.kind === "skill" ? (
                  <>
                    <div><label className="mb-1 block text-xs text-gray-500">路径</label>
                      <input type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value, skillPath: e.target.value })} className={inputCls} placeholder="my-skill" /></div>
                    <div><label className="mb-1 block text-xs text-gray-500">SKILL.md</label>
                      <textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} rows={20} className={inputCls + " font-mono text-xs leading-relaxed"} /></div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-gray-500">{edit.skillPath}/{edit.relativePath}</p>
                    <textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} rows={22} className={inputCls + " font-mono text-xs leading-relaxed"} />
                  </>
                )}
              </div>
              <div className={PANEL_FOOTER}>
                <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/30"><Trash2 size={13} />删除</button>
                <div className="flex items-center gap-2">
                  <button onClick={() => { if (!isDirty) setEdit(null) }} className="rounded-md px-4 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">取消</button>
                  <button onClick={() => void handleSave()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-600">← 选择 Skill 或文件</div>
          )}
        </div>
      </div>
      {ModalPortal}
    </>
  )
}
