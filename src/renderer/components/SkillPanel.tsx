import { useState, useEffect, useCallback } from "react"
import { Plus, Trash2 } from "lucide-react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import SkillTreeList from "./SkillTreeList"
import SkillNameDialog from "./SkillNameDialog"
import { ancestorExpandKeys, findEntryConflict, isSameOrInside, joinEntryPath, locationLabel, validateEntryName, type SkillEntryKind } from "./skill-entry"
import { PANEL_ROOT, PANEL_ASIDE, PANEL_LIST, PANEL_MAIN, PANEL_SCROLL, PANEL_FOOTER } from "./panel-layout"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"

interface SkillFile { rootId: string; skillPath: string; name: string; content: string }

type EditMode =
  | { kind: "skill"; skillPath: string; name: string; content: string; originalPath: string | null; isNew: boolean }
  | { kind: "file"; skillPath: string; relativePath: string; content: string }

export default function SkillPanel() {
  const { showAlert, showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [skillRoots, setSkillRoots] = useState<{ id: string; label: string; path: string; skillCount: number }[]>([])
  const [skillRootId, setSkillRootId] = useState("cursor")
  const [skills, setSkills] = useState<SkillFile[]>([])
  const [skillTree, setSkillTree] = useState<SkillTreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<EditMode | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [namePrompt, setNamePrompt] = useState<{ kind: SkillEntryKind; skillPath: string; parentPath: string } | null>(null)

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

  /** 编辑器里有没保存的修改时问一下；返回 false 表示用户取消（或保存失败），调用方不要继续 */
  const guardUnsaved = async (saveLabel: string): Promise<boolean> => {
    if (!isDirty) return true
    const choice = await showUnsavedChoice("未保存", "有未保存的修改，怎么办？", { save: saveLabel })
    if (choice === "cancel") return false
    if (choice === "save" && !(await handleSave())) return false
    return true
  }

  const selectSkill = async (s: SkillFile) => {
    if (!(await guardUnsaved("保存并切换"))) return
    const mode: EditMode = { kind: "skill", skillPath: s.skillPath, name: s.skillPath, content: s.content, originalPath: s.skillPath, isNew: false }
    setEdit(mode)
    setSavedSnapshot(JSON.stringify(mode))
  }

  /** 把文件读进编辑器（不管未保存的修改，调用前自己处理） */
  const loadFile = async (skillPath: string, relativePath: string): Promise<boolean> => {
    const res = await window.electronAPI.readSkillFile(skillRootId, skillPath, relativePath)
    if (!res.ok) { void showAlert("读取失败", res.error ?? ""); return false }
    const mode: EditMode = { kind: "file", skillPath, relativePath, content: res.content ?? "" }
    setEdit(mode)
    setSavedSnapshot(JSON.stringify(mode))
    return true
  }

  const openFile = async (skillPath: string, relativePath: string) => {
    if (!(await guardUnsaved("保存并切换"))) return
    await loadFile(skillPath, relativePath)
  }

  const openAdd = async () => {
    if (!(await guardUnsaved("保存并继续"))) return
    const mode: EditMode = { kind: "skill", skillPath: "", name: "", content: "", originalPath: null, isNew: true }
    setEdit(mode)
    setSavedSnapshot(JSON.stringify(mode))
  }

  /** 在 Skill 目录（或其子文件夹）下新建文件 / 文件夹：先弹出输入名字的对话框 */
  const openCreate = async (kind: SkillEntryKind, skillPath: string, parentPath: string) => {
    // 新建文件后会直接在编辑器里打开，先处理掉没保存的修改；新建文件夹不动编辑器
    if (kind === "file" && !(await guardUnsaved("保存并继续"))) return
    setNamePrompt({ kind, skillPath, parentPath })
  }

  /** 返回错误文案让对话框显示；返回 null 表示已建好 */
  const submitNew = async (rawName: string): Promise<string | null> => {
    if (!namePrompt) return null
    const checked = validateEntryName(rawName)
    if (!checked.ok) return checked.error
    const { kind, skillPath, parentPath } = namePrompt
    const rel = joinEntryPath(parentPath, checked.name)
    try {
      // 用刚从磁盘读的树查重，不用界面上可能过期的那份：直接 saveSkillFile 会把同名文件清空
      const fresh = await window.electronAPI.getSkillTree(skillRootId)
      const conflict = findEntryConflict(fresh.find((t) => t.name === skillPath)?.children, rel)
      if (conflict) return conflict
      const res = kind === "file"
        ? await window.electronAPI.saveSkillFile(skillRootId, skillPath, rel, "")
        : await window.electronAPI.createSkillDir(skillRootId, skillPath, rel)
      if (!res.ok) return res.error ?? "创建失败"
    } catch (e) {
      return `创建失败：${e instanceof Error ? e.message : String(e)}`
    }
    setNamePrompt(null)
    // 展开到新东西所在的位置，这样建完立刻看得见
    setExpanded((prev) => new Set([...prev, ...ancestorExpandKeys(skillRootId, skillPath, rel)]))
    reloadRoots(); reloadSkills()
    if (kind === "file") await loadFile(skillPath, rel)
    return null
  }

  const deleteFolder = async (skillPath: string, relativePath: string) => {
    if (!(await showConfirm("删除文件夹", `确定删除「${skillPath}/${relativePath}」及其中所有内容？`))) return
    try {
      const res = await window.electronAPI.deleteSkillFile(skillRootId, skillPath, relativePath)
      if (!res.ok) { void showAlert("删除失败", res.error ?? ""); return }
    } catch (e) {
      void showAlert("删除失败", e instanceof Error ? e.message : String(e))
      return
    }
    // 编辑器里开着的文件在被删的文件夹里，就关掉它
    if (edit?.kind === "file" && edit.skillPath === skillPath && isSameOrInside(edit.relativePath, relativePath)) setEdit(null)
    reloadRoots(); reloadSkills()
  }

  const handleSave = async () => {
    if (!edit) return false
    if (edit.kind === "skill") {
      if (!edit.name.trim()) return false
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
    return true
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

  return (
    <>
      <div className={PANEL_ROOT}>
        <aside className={PANEL_ASIDE}>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {skillRoots.map((root) => (
              <button key={root.id} type="button" onClick={() => { setSkillRootId(root.id); setExpanded(new Set()); setEdit(null) }}
                className={`rounded border px-1.5 py-0.5 text-[10px] transition ${skillRootId === root.id ? "border-blue-500 bg-blue-500/10 text-fg" : "border-line text-fg-muted hover:bg-raised"}`}>
                {root.label}
              </button>
            ))}
          </div>
          <div className={PANEL_LIST}>
            <SkillTreeList
              rootId={skillRootId}
              skills={skills}
              tree={skillTree}
              expanded={expanded}
              activeSkillPath={edit?.kind === "skill" ? edit.skillPath : null}
              onToggle={toggleExpand}
              onSelectSkill={(skillPath) => { const s = skills.find((x) => x.skillPath === skillPath); if (s) void selectSkill(s) }}
              onOpenFile={(skillPath, relativePath) => void openFile(skillPath, relativePath)}
              onCreate={(kind, skillPath, parentPath) => void openCreate(kind, skillPath, parentPath)}
              onDeleteFolder={(skillPath, relativePath) => void deleteFolder(skillPath, relativePath)}
            />
            <button type="button" onClick={() => void openAdd()}
              className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted hover:border-line-strong hover:bg-raised/40">
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
                    <div><label className="mb-1 block text-xs text-fg-muted">路径</label>
                      <input type="text" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value, skillPath: e.target.value })} className={inputCls} placeholder="my-skill" /></div>
                    <div><label className="mb-1 block text-xs text-fg-muted">SKILL.md</label>
                      <textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} rows={20} className={inputCls + " font-mono text-xs leading-relaxed"} /></div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-fg-muted">{edit.skillPath}/{edit.relativePath}</p>
                    <textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} rows={22} className={inputCls + " font-mono text-xs leading-relaxed"} />
                  </>
                )}
              </div>
              <div className={PANEL_FOOTER}>
                <button type="button" onClick={() => void handleDelete()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-danger hover:bg-danger-tint/30"><Trash2 size={13} />删除</button>
                <div className="flex items-center gap-2">
                  <button onClick={() => { if (!isDirty) setEdit(null) }} className="rounded-md px-4 py-1.5 text-xs text-fg-3 hover:bg-raised hover:text-fg">取消</button>
                  <button onClick={() => void handleSave()}
                    className={`rounded-md px-4 py-1.5 text-xs font-medium transition ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}>
                    {justSaved ? "已保存" : "保存"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">← 选择 Skill 或文件</div>
          )}
        </div>
      </div>
      {namePrompt && (
        <SkillNameDialog
          title={namePrompt.kind === "file" ? "新建文件" : "新建文件夹"}
          location={locationLabel(namePrompt.skillPath, namePrompt.parentPath)}
          placeholder={namePrompt.kind === "file" ? "例如 utils.py，或 scripts/run.sh（会一并建出 scripts）" : "例如 scripts"}
          onSubmit={submitNew}
          onCancel={() => setNamePrompt(null)}
        />
      )}
      {ModalPortal}
    </>
  )
}
