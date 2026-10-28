import type { ReactNode } from "react"
import { ChevronRight, ChevronDown, Folder, FileText, FilePlus, FolderPlus, Trash2 } from "lucide-react"
import { dirExpandKey, joinEntryPath, skillExpandKey, type SkillEntryKind } from "./skill-entry"

export interface SkillRow { skillPath: string; name: string }

interface Props {
  rootId: string
  skills: SkillRow[]
  tree: SkillTreeNode[]
  expanded: ReadonlySet<string>
  /** 编辑器里当前打开的是哪个 Skill 的 SKILL.md（用于高亮） */
  activeSkillPath: string | null
  onToggle: (key: string) => void
  onSelectSkill: (skillPath: string) => void
  onOpenFile: (skillPath: string, relativePath: string) => void
  /** parentPath 为空串表示建在 Skill 根目录下 */
  onCreate: (kind: SkillEntryKind, skillPath: string, parentPath: string) => void
  onDeleteFolder: (skillPath: string, relativePath: string) => void
}

/**
 * 行尾的操作按钮：悬停或键盘聚焦到这一行时才显示，浮在行尾，不占名字的宽度（侧栏只有 160px）。
 * 用 hidden→flex 而不是 opacity，隐藏时不会被 Tab 选中、也不挡住下面的名字。
 */
function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-y-0 right-0 hidden items-center gap-0.5 rounded-r bg-raised pl-1 pr-0.5 group-hover:flex group-focus-within:flex">
      {children}
    </div>
  )
}

function ActionButton({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className={`rounded p-0.5 text-fg-3 ${danger ? "hover:text-danger" : "hover:text-fg"}`}>
      {children}
    </button>
  )
}

export default function SkillTreeList({ rootId, skills, tree, expanded, activeSkillPath, onToggle, onSelectSkill, onOpenFile, onCreate, onDeleteFolder }: Props) {
  const renderTree = (nodes: SkillTreeNode[], skillPath: string, parentPath: string, depth: number): ReactNode =>
    nodes.map((node) => {
      const fullPath = joinEntryPath(parentPath, node.name)
      const nodeKey = dirExpandKey(rootId, skillPath, fullPath)
      if (node.type === "directory") {
        const open = expanded.has(nodeKey)
        return (
          <div key={nodeKey}>
            <div className="group relative">
              <button type="button" onClick={() => onToggle(nodeKey)} style={{ paddingLeft: `${depth * 12 + 4}px` }}
                className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs text-fg-3 hover:bg-raised/50 hover:text-fg-soft">
                {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                <Folder size={12} className="shrink-0 text-accent/70" /><span className="truncate">{node.name}</span>
              </button>
              <RowActions>
                <ActionButton title="新建文件" onClick={() => onCreate("file", skillPath, fullPath)}><FilePlus size={12} /></ActionButton>
                <ActionButton title="新建文件夹" onClick={() => onCreate("folder", skillPath, fullPath)}><FolderPlus size={12} /></ActionButton>
                <ActionButton title="删除文件夹" danger onClick={() => onDeleteFolder(skillPath, fullPath)}><Trash2 size={12} /></ActionButton>
              </RowActions>
            </div>
            {open && node.children && renderTree(node.children, skillPath, fullPath, depth + 1)}
          </div>
        )
      }
      return (
        <button key={nodeKey} type="button" onClick={() => onOpenFile(skillPath, fullPath)} style={{ paddingLeft: `${depth * 12 + 16}px` }}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs text-fg-muted hover:bg-raised/50 hover:text-fg-soft">
          <FileText size={11} className="shrink-0" /><span className="truncate">{node.name}</span>
        </button>
      )
    })

  return (
    <>
      {skills.map((s) => {
        const key = skillExpandKey(rootId, s.skillPath)
        const isOpen = expanded.has(key)
        const children = tree.find((t) => t.name === s.skillPath)?.children
        return (
          <div key={key}>
            <div className="group relative flex items-center gap-0.5">
              <button type="button" onClick={() => onToggle(key)} className="rounded p-0.5 text-fg-faint hover:text-fg-2">
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              <button type="button" onClick={() => onSelectSkill(s.skillPath)}
                className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs transition ${activeSkillPath === s.skillPath ? "bg-raised/70 text-fg" : "text-fg-3 hover:bg-raised/40"}`}>
                {s.name}
              </button>
              <RowActions>
                <ActionButton title="新建文件" onClick={() => onCreate("file", s.skillPath, "")}><FilePlus size={12} /></ActionButton>
                <ActionButton title="新建文件夹" onClick={() => onCreate("folder", s.skillPath, "")}><FolderPlus size={12} /></ActionButton>
              </RowActions>
            </div>
            {isOpen && children && renderTree(children, s.skillPath, "", 1)}
          </div>
        )
      })}
    </>
  )
}
