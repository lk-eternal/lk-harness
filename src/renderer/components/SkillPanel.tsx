import { useState, useEffect, useCallback, useRef } from "react"
import useInlineModal from "./useInlineModal"
import { usePanelSave } from "./usePanelSave"
import SkillNameDialog from "./SkillNameDialog"
import SkillEditor, { type EditMode } from "./skill/SkillEditor"
import { SkillFilesColumn, SkillListColumn, SkillRootColumn, type RootInfo } from "./skill/SkillColumns"
import { skillDeleteConfirm } from "./skill/skill-delete"
import { pickInitialRoot, skillsColumns } from "./skill/skills-nav"
import { useOpenFirstOnce } from "./panel-default"
import { EmptyPane, dashedBtn } from "./project/project-ui"
import { ancestorExpandKeys, diskLocationOf, findEntryConflict, isSameOrInside, joinEntryPath, locationLabel, validateEntryName, validateSkillPath, type SkillEntryKind } from "./skill-entry"

interface SkillFile { rootId: string; skillPath: string; name: string; content: string }
/** 某个目录读回来的内容；带着 rootId，切目录后旧的结果一眼就能认出来不用 */
interface Loaded { rootId: string; skills: SkillFile[]; tree: SkillTreeNode[] }

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * 设置页「Skills」：一级一级点下去。
 * 目录（各个 AI 工具读 Skill 的位置）→ 这个目录里的 Skill → Skill 里的文件 → 右边的编辑区。
 * 窗口放不下这么多列时，从最左边开始收，被收起的那一级在剩下最左一列的顶上有「返回」。
 */
export default function SkillPanel() {
  const { showAlert, showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const { justSaved, markSaved } = usePanelSave()
  const [roots, setRoots] = useState<RootInfo[]>([])
  const [rootId, setRootId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  /** 选中的 Skill。只在点选、保存（含改名）、删除时变，不跟着编辑区里正在输入的路径走 */
  const [skillSel, setSkillSel] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [edit, setEdit] = useState<EditMode | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState("")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [namePrompt, setNamePrompt] = useState<{ kind: SkillEntryKind; skillPath: string; parentPath: string } | null>(null)
  const [width, setWidth] = useState(0)

  const alive = useRef(true)
  const rootEl = useRef<HTMLDivElement>(null)
  const rootIdRef = useRef(rootId)
  rootIdRef.current = rootId

  const loadRoots = useCallback(async () => {
    const list = await window.electronAPI.getSkillRoots().catch(() => [] as RootInfo[])
    if (!alive.current) return
    setRoots(list)
    setRootId((prev) => (prev && list.some((r) => r.id === prev) ? prev : pickInitialRoot(list)))
  }, [])

  const loadSkills = useCallback(async (id: string) => {
    try {
      const [skills, tree] = await Promise.all([window.electronAPI.getSkills(id), window.electronAPI.getSkillTree(id)])
      // 读的过程中用户已经切到别的目录了：这份结果作废
      if (!alive.current || rootIdRef.current !== id) return
      setLoaded({ rootId: id, skills, tree })
      // 选中的 Skill 在磁盘上没了（被别处删了）：退回列表
      setSkillSel((prev) => (prev !== null && !skills.some((s) => s.skillPath === prev) ? null : prev))
    } catch {
      setLoaded((prev) => (prev?.rootId === id ? prev : { rootId: id, skills: [], tree: [] }))
    }
  }, [])

  const reloadAll = useCallback(async () => {
    await Promise.all([loadRoots(), rootIdRef.current ? loadSkills(rootIdRef.current) : Promise.resolve()])
  }, [loadRoots, loadSkills])

  useEffect(() => {
    alive.current = true
    void loadRoots()
    return () => { alive.current = false }
  }, [loadRoots])
  useEffect(() => { if (rootId) void loadSkills(rootId) }, [rootId, loadSkills])

  // 设置页是常驻的（只是被藏起来）：别处（比如 AI 自己）改了 Skill，再回到这里要重新读
  useEffect(() => {
    const el = rootEl.current
    if (!el) return
    let visible: boolean | undefined
    const io = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => {
      const now = entries[entries.length - 1].isIntersecting
      if (now && visible === false) void reloadAll()
      visible = now
    })
    io?.observe(el)
    // 内容区的宽度决定显示几列；被藏起来时宽度是 0：量不到，保持原样
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width
      if (w > 0) setWidth(w)
    })
    ro?.observe(el)
    return () => { io?.disconnect(); ro?.disconnect() }
  }, [reloadAll])

  const root = roots.find((r) => r.id === rootId) ?? null
  const data = loaded && loaded.rootId === rootId ? loaded : null
  const skills = data?.skills ?? null
  const cols = skillsColumns(width, skillSel !== null)
  const isDirty = edit ? JSON.stringify(edit) !== savedSnapshot : false
  const creating = edit?.kind === "skill" && edit.isNew

  /** 换编辑区里的内容；顺带把「没改过」的基准和上一次的错误一起清掉 */
  const open = (mode: EditMode | null) => {
    setEdit(mode)
    setSavedSnapshot(mode ? JSON.stringify(mode) : "")
    setSaveError(null)
  }

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

  const selectRoot = async (id: string) => {
    if (id === rootId) return
    if (!(await guardUnsaved("保存并切换"))) return
    setRootId(id)
    setSkillSel(null)
    setExpanded(new Set())
    open(null)
  }

  /** 打开某个 Skill 的 SKILL.md（点列表里的 Skill、或文件列表第一行都走这里） */
  const openSkill = async (skillPath: string) => {
    const s = skills?.find((x) => x.skillPath === skillPath)
    if (!s || !rootId) return
    if (!(await guardUnsaved("保存并切换"))) return
    // 从磁盘现读：列表里那份可能是几分钟前读的
    const res = await window.electronAPI.readSkillFile(rootId, skillPath, "SKILL.md").catch(() => null)
    setSkillSel(skillPath)
    open({ kind: "skill", skillPath, name: skillPath, content: res?.ok ? res.content ?? "" : s.content, originalPath: skillPath, isNew: false })
  }

  /** 把文件读进编辑器（不管未保存的修改，调用前自己处理） */
  const loadFile = async (skillPath: string, relativePath: string): Promise<boolean> => {
    if (!rootId) return false
    const res = await window.electronAPI.readSkillFile(rootId, skillPath, relativePath)
    if (!res.ok) { void showAlert("读取失败", res.error ?? ""); return false }
    open({ kind: "file", skillPath, relativePath, content: res.content ?? "" })
    return true
  }

  const openFile = async (relativePath: string) => {
    if (!skillSel) return
    if (!(await guardUnsaved("保存并切换"))) return
    await loadFile(skillSel, relativePath)
  }

  const openAdd = async () => {
    if (creating) return
    if (!(await guardUnsaved("保存并继续"))) return
    setSkillSel(null)
    open({ kind: "skill", skillPath: "", name: "", content: "", originalPath: null, isNew: true })
  }

  /** 回到「目录 + Skill 列表」那一层（窄窗口里最左的列顶上的「返回」） */
  const backToList = async () => {
    if (!(await guardUnsaved("保存并返回"))) return
    setSkillSel(null)
    open(null)
  }

  /** 在当前 Skill（或其子文件夹）下新建文件 / 文件夹：先弹出输入名字的对话框 */
  const openCreate = async (kind: SkillEntryKind, parentPath: string) => {
    if (!skillSel) return
    // 新建文件后会直接在编辑器里打开，先处理掉没保存的修改；新建文件夹不动编辑器
    if (kind === "file" && !(await guardUnsaved("保存并继续"))) return
    setNamePrompt({ kind, skillPath: skillSel, parentPath })
  }

  /** 返回错误文案让对话框显示；返回 null 表示已建好 */
  const submitNew = async (rawName: string): Promise<string | null> => {
    if (!namePrompt || !rootId) return null
    const checked = validateEntryName(rawName)
    if (!checked.ok) return checked.error
    const { kind, skillPath, parentPath } = namePrompt
    const rel = joinEntryPath(parentPath, checked.name)
    try {
      // 用刚从磁盘读的树查重，不用界面上可能过期的那份：直接 saveSkillFile 会把同名文件清空
      const fresh = await window.electronAPI.getSkillTree(rootId)
      const conflict = findEntryConflict(fresh.find((t) => t.name === skillPath)?.children, rel)
      if (conflict) return conflict
      const res = kind === "file"
        ? await window.electronAPI.saveSkillFile(rootId, skillPath, rel, "")
        : await window.electronAPI.createSkillDir(rootId, skillPath, rel)
      if (!res.ok) return res.error ?? "创建失败"
    } catch (e) {
      return `创建失败：${messageOf(e)}`
    }
    setNamePrompt(null)
    // 展开到新东西所在的位置，这样建完立刻看得见
    setExpanded((prev) => new Set([...prev, ...ancestorExpandKeys(rootId, skillPath, rel)]))
    await reloadAll()
    if (kind === "file") await loadFile(skillPath, rel)
    return null
  }

  const deleteFolder = async (relativePath: string) => {
    if (!skillSel || !rootId) return
    const skillPath = skillSel
    if (!(await showConfirm("删除文件夹", `确定删除「${skillPath}/${relativePath}」及其中所有内容？`))) return
    try {
      const res = await window.electronAPI.deleteSkillFile(rootId, skillPath, relativePath)
      if (!res.ok) { void showAlert("删除失败", res.error ?? ""); return }
    } catch (e) {
      void showAlert("删除失败", messageOf(e))
      return
    }
    // 编辑器里开着的文件在被删的文件夹里，就关掉它
    if (edit?.kind === "file" && edit.skillPath === skillPath && isSameOrInside(edit.relativePath, relativePath)) open(null)
    await reloadAll()
  }

  /**
   * 在系统文件管理器里打开：skillPath、relativePath 都为空串是目录自己，只有 relativePath 为空是 Skill 文件夹。
   * 文件夹直接打开，文件是显示它的位置。只是看一眼位置，不动编辑区，所以不用问「有未保存的修改」。
   */
  const reveal = async (skillPath: string, relativePath: string) => {
    if (!rootId) return
    try {
      const res = await window.electronAPI.revealSkillPath(rootId, skillPath, relativePath)
      if (!res.ok) void showAlert("打开失败", res.error ?? "")
    } catch (e) {
      void showAlert("打开失败", messageOf(e))
    }
  }

  /** 编辑区里这个文件在磁盘上的位置；Skill 的路径框里改了没保存的名字不算，磁盘上还是原来的 */
  const revealEditing = () => {
    const at = edit ? diskLocationOf(edit) : null
    if (at) void reveal(at.skillPath, at.relativePath)
  }

  const handleSave = async (): Promise<boolean> => {
    if (!edit || !rootId) return false
    setSaveError(null)
    try {
      if (edit.kind === "skill") {
        // 用刚从磁盘读的目录查重，不用界面上可能过期的那份：保存会直接写 SKILL.md，同名就把别人的内容盖掉了
        const fresh = await window.electronAPI.getSkillTree(rootId)
        const checked = validateSkillPath(edit.name, fresh.map((t) => t.name), edit.originalPath)
        if (!checked.ok) { setSaveError(checked.error); return false }
        const newPath = checked.path
        if (edit.originalPath && edit.originalPath !== newPath) {
          const renamed = await window.electronAPI.renameSkill(rootId, edit.originalPath, newPath)
          if (!renamed.ok) { setSaveError(renamed.error ?? "改路径失败"); return false }
        }
        const written = await window.electronAPI.saveSkill(rootId, newPath, edit.content)
        if (!written.ok) { setSaveError(written.error ?? "保存失败"); return false }
        await reloadAll()
        setSkillSel(newPath)
        open({ kind: "skill", skillPath: newPath, name: newPath, content: edit.content, originalPath: newPath, isNew: false })
      } else {
        const written = await window.electronAPI.saveSkillFile(rootId, edit.skillPath, edit.relativePath, edit.content)
        if (!written.ok) { setSaveError(written.error ?? "保存失败"); return false }
        setSavedSnapshot(JSON.stringify(edit))
      }
    } catch (e) {
      setSaveError(`保存失败：${messageOf(e)}`)
      return false
    }
    markSaved()
    return true
  }

  const handleRevert = () => {
    if (savedSnapshot) setEdit(JSON.parse(savedSnapshot) as EditMode)
    setSaveError(null)
  }

  const handleDelete = async () => {
    if (!edit || !rootId) return
    try {
      if (edit.kind === "skill") {
        if (edit.isNew) { open(null); return }
        const path = edit.originalPath ?? edit.skillPath
        // 链接和真文件夹删的东西不一样，先问一下，确认里才说得准
        const linkTarget = await window.electronAPI.getSkillLinkTarget(rootId, path).catch(() => null)
        const ask = skillDeleteConfirm(path, linkTarget)
        if (!(await showConfirm(ask.title, ask.message))) return
        const res = await window.electronAPI.deleteSkill(rootId, path)
        if (!res.ok) {
          void showAlert("删除失败", res.error ?? "")
          await reloadAll() // 失败前可能已经删掉了一部分，让列表反映磁盘上的真实情况
          return
        }
        await reloadAll()
        setSkillSel(null)
        open(null)
      } else {
        if (!(await showConfirm("删除文件", `确定删除「${edit.relativePath}」？`))) return
        const res = await window.electronAPI.deleteSkillFile(rootId, edit.skillPath, edit.relativePath)
        if (!res.ok) { void showAlert("删除失败", res.error ?? ""); return }
        await reloadAll()
        open(null)
      }
    } catch (e) {
      void showAlert("删除失败", messageOf(e))
    }
  }

  const noSkills = skills !== null && skills.length === 0 && !creating

  // 进来默认停在第一个目录（pickInitialRoot），再打开它的第一个 Skill
  useOpenFirstOnce(skills !== null, skills ?? [], skillSel !== null || edit !== null, (s) => void openSkill(s.skillPath))

  return (
    <>
      <div ref={rootEl} className="flex min-h-0 flex-1">
        {cols.roots && <SkillRootColumn roots={roots} rootId={rootId} onSelect={(id) => void selectRoot(id)} />}
        {cols.skills && root && (
          <SkillListColumn
            root={root}
            skills={skills}
            activeSkill={skillSel}
            creating={creating}
            onSelect={(p) => void openSkill(p)}
            onNew={() => void openAdd()}
            onOpenRoot={() => void reveal("", "")}
            onBack={cols.back === "roots" ? () => void backToList() : undefined}
          />
        )}
        {cols.files && root && skillSel && (
          <SkillFilesColumn
            rootId={root.id}
            skillPath={skillSel}
            tree={data?.tree ?? []}
            expanded={expanded}
            skillMdActive={edit?.kind === "skill" && !edit.isNew}
            activeFile={edit?.kind === "file" ? edit.relativePath : null}
            onToggle={toggleExpand}
            onOpenSkillMd={() => void openSkill(skillSel)}
            onOpenFile={(rel) => void openFile(rel)}
            onCreate={(kind, parent) => void openCreate(kind, parent)}
            onDeleteFolder={(rel) => void deleteFolder(rel)}
            onReveal={(rel) => void reveal(skillSel, rel)}
            back={cols.back === "skills" ? { label: "全部 Skill", onClick: () => void backToList() } : undefined}
          />
        )}

        <div className="flex min-h-0 min-w-0 flex-1 pl-4">
          {edit && root ? (
            <SkillEditor
              key={edit.kind === "skill" ? `skill:${edit.originalPath ?? "new"}` : `file:${edit.skillPath}/${edit.relativePath}`}
              edit={edit}
              rootLabel={root.label}
              dirty={isDirty}
              justSaved={justSaved && !isDirty}
              error={saveError}
              onChange={setEdit}
              onSave={() => void handleSave()}
              onRevert={handleRevert}
              onDelete={() => void handleDelete()}
              onReveal={revealEditing}
            />
          ) : noSkills ? (
            <EmptyPane title="这个目录里还没有 Skill">
              <p>Skill 是写给 AI 的一份做事说明（SKILL.md），还可以带上脚本和参考资料。AI 遇到相关的事，会去读它。</p>
              <div className="pt-1">
                <button type="button" onClick={() => void openAdd()} className={`${dashedBtn} border-blue-500/60 text-accent`}>新建 Skill</button>
              </div>
            </EmptyPane>
          ) : skillSel ? (
            <EmptyPane title="选一个文件">
              <p>点 SKILL.md 修改这个 Skill 的说明，或点其他文件查看、编辑。</p>
            </EmptyPane>
          ) : (
            <EmptyPane title="选一个 Skill">
              <p>在左边选一个 Skill，查看和修改它的说明与文件。</p>
            </EmptyPane>
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
