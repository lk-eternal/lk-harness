import type { ReactNode } from "react"
import { ChevronRight, ChevronDown, Folder, FileText, FilePlus, FolderPlus, Trash2 } from "lucide-react"
import { dirExpandKey, joinEntryPath, type SkillEntryKind } from "./skill-entry"

interface Props {
  rootId: string
  skillPath: string
  /** 这个 Skill 里除了 SKILL.md 之外的内容（SKILL.md 在文件列表里单独占第一行） */
  nodes: SkillTreeNode[]
  expanded: ReadonlySet<string>
  /** 编辑区里现在打开的文件（相对 Skill 目录的路径），用来高亮 */
  activeFile: string | null
  onToggle: (key: string) => void
  onOpenFile: (relativePath: string) => void
  /** parentPath 为空串表示建在 Skill 根目录下 */
  onCreate: (kind: SkillEntryKind, parentPath: string) => void
  onDeleteFolder: (relativePath: string) => void
}

/**
 * 行尾的操作按钮：悬停或键盘聚焦到这一行时才显示，浮在行尾，不占名字的宽度（列只有 160px 左右）。
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

/** 一个 Skill 里的文件和文件夹（文件夹可以一层层展开） */
export default function SkillTreeList({ rootId, skillPath, nodes, expanded, activeFile, onToggle, onOpenFile, onCreate, onDeleteFolder }: Props) {
  const renderTree = (list: SkillTreeNode[], parentPath: string, depth: number): ReactNode =>
    list.map((node) => {
      const fullPath = joinEntryPath(parentPath, node.name)
      const nodeKey = dirExpandKey(rootId, skillPath, fullPath)
      if (node.type === "directory") {
        const open = expanded.has(nodeKey)
        return (
          <div key={nodeKey}>
            <div className="group relative">
              <button type="button" onClick={() => onToggle(nodeKey)} style={{ paddingLeft: `${depth * 12 + 4}px` }}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-fg-3 hover:bg-raised/50 hover:text-fg-soft">
                {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                <Folder size={12} className="shrink-0 text-accent/70" /><span className="truncate">{node.name}</span>
              </button>
              <RowActions>
                <ActionButton title="新建文件" onClick={() => onCreate("file", fullPath)}><FilePlus size={12} /></ActionButton>
                <ActionButton title="新建文件夹" onClick={() => onCreate("folder", fullPath)}><FolderPlus size={12} /></ActionButton>
                <ActionButton title="删除文件夹" danger onClick={() => onDeleteFolder(fullPath)}><Trash2 size={12} /></ActionButton>
              </RowActions>
            </div>
            {open && node.children && renderTree(node.children, fullPath, depth + 1)}
          </div>
        )
      }
      const on = activeFile === fullPath
      return (
        <button key={nodeKey} type="button" data-file={fullPath} aria-current={on ? "true" : undefined} onClick={() => onOpenFile(fullPath)} style={{ paddingLeft: `${depth * 12 + 16}px` }}
          className={`flex w-full items-center gap-1 rounded px-1 py-1 text-xs transition ${on ? "bg-raised/70 font-medium text-fg" : "text-fg-muted hover:bg-raised/50 hover:text-fg-soft"}`}>
          <FileText size={11} className="shrink-0" /><span className="truncate">{node.name}</span>
        </button>
      )
    })

  return <>{renderTree(nodes, "", 0)}</>
}
