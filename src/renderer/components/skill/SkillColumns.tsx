import { ChevronLeft, FilePlus, FolderPlus, FileText, Plus } from "lucide-react"
import SkillTreeList from "../SkillTreeList"
import ScrollActiveList from "../ScrollActiveList"
import type { SkillEntryKind } from "../skill-entry"
import { rootDisplayName, skillSummary, withoutSkillMd, type SkillRootLike } from "./skills-nav"

/** 列表里的一行：选中高亮，和「项目」页左栏的行是同一个样子 */
const itemCls = (on: boolean) =>
  `flex w-full flex-col rounded-md px-2.5 py-1.5 text-left transition ${on ? "bg-raised/70 text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`

const columnCls = "flex w-44 shrink-0 flex-col border-r border-line-subtle"

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1 inline-flex max-w-full items-center gap-0.5 self-start rounded-md py-1 pl-0.5 pr-2 text-xs text-fg-muted transition hover:bg-raised hover:text-fg-2"
    ><ChevronLeft size={14} className="shrink-0" /><span className="truncate">{label}</span></button>
  )
}

function ColumnTitle({ title, count }: { title: string; count?: number }) {
  return (
    <div className="px-2.5 pb-1 pt-2">
      <p className="text-[11px] font-medium text-fg-muted">
        {title}
        {count !== undefined && <span className="font-normal text-fg-faint"> {count}</span>}
      </p>
    </div>
  )
}

// ── 第一级：目录 ──────────────────────────────────────────────────────────

export interface RootInfo extends SkillRootLike {
  path: string
}

/** 第一列：各个 AI 工具读取 Skill 的目录。点哪个，右边的 Skill 列表就是哪个目录里的 */
export function SkillRootColumn({ roots, rootId, onSelect }: { roots: RootInfo[]; rootId: string | null; onSelect: (id: string) => void }) {
  return (
    <aside className={columnCls} aria-label="Skill 目录">
      <ColumnTitle title="目录" count={roots.length} />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {roots.map((r) => {
          const on = r.id === rootId
          return (
            <button key={r.id} type="button" data-rail="root" aria-current={on ? "true" : undefined} title={r.path} onClick={() => onSelect(r.id)} className={itemCls(on)}>
              <span className="flex items-baseline gap-1.5">
                <span className={`min-w-0 flex-1 truncate text-xs ${on ? "font-medium" : ""}`}>{rootDisplayName(r)}</span>
                <span className="shrink-0 text-[10px] text-fg-faint">{r.skillCount}</span>
              </span>
              <span className="truncate font-mono text-[10px] text-fg-faint">{r.label}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

// ── 第二级：这个目录里的 Skill ───────────────────────────────────────────────

export interface SkillRow {
  skillPath: string
  content: string
}

interface SkillListProps {
  root: RootInfo
  /** null：还在读 */
  skills: SkillRow[] | null
  activeSkill: string | null
  /** 正在新建（还没保存）：列表里先占一个位置 */
  creating: boolean
  onSelect: (skillPath: string) => void
  onNew: () => void
  /** 最左的目录列收起来时，给一个回到目录的入口 */
  onBack?: () => void
}

export function SkillListColumn({ root, skills, activeSkill, creating, onSelect, onNew, onBack }: SkillListProps) {
  return (
    <aside className={columnCls} aria-label="Skill 列表">
      <div className="px-2 pt-1">{onBack && <BackButton label="全部目录" onClick={onBack} />}</div>
      <div className="px-2.5 pb-1 pt-1">
        <p className="truncate text-sm font-medium text-fg-2" title={root.path}>{rootDisplayName(root)}</p>
        <p className="truncate font-mono text-[10px] text-fg-faint" title={root.path}>{root.label}</p>
      </div>
      {/* 「新建 Skill」在列表外面，Skill 再多也一直看得见 */}
      <div className="shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted transition hover:border-line-strong hover:bg-raised/40"
        ><Plus size={14} />新建 Skill</button>
      </div>
      {/* 新建保存后新 Skill 追加在列表末尾：列表长时滚到选中的那一行 */}
      <ScrollActiveList activeKey={creating ? "\0new" : activeSkill} count={skills?.length ?? 0} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {skills === null && <p className="px-2.5 py-1.5 text-[11px] text-fg-faint">加载中…</p>}
        {skills?.map((s) => {
          const on = s.skillPath === activeSkill
          const summary = skillSummary(s.content)
          return (
            <button key={s.skillPath} type="button" data-skill={s.skillPath} aria-current={on ? "true" : undefined} title={s.skillPath} onClick={() => onSelect(s.skillPath)} className={itemCls(on)}>
              <span className={`truncate text-xs ${on ? "font-medium" : ""}`}>{s.skillPath}</span>
              {summary && <span className="line-clamp-2 text-[10px] leading-snug text-fg-faint">{summary}</span>}
            </button>
          )
        })}
        {creating && (
          <div className={itemCls(true)} aria-current="true"><span className="text-xs font-medium">新 Skill</span><span className="text-[10px] text-fg-faint">正在创建…</span></div>
        )}
        {skills !== null && skills.length === 0 && !creating && (
          <p className="px-2.5 py-1.5 text-[11px] leading-snug text-fg-faint">这个目录里还没有 Skill。</p>
        )}
      </ScrollActiveList>
    </aside>
  )
}

// ── 第三级：一个 Skill 里的文件 ──────────────────────────────────────────────

interface FilesProps {
  rootId: string
  skillPath: string
  tree: SkillTreeNode[]
  expanded: ReadonlySet<string>
  /** 编辑区里开着 SKILL.md */
  skillMdActive: boolean
  /** 编辑区里开着的别的文件（相对路径） */
  activeFile: string | null
  onToggle: (key: string) => void
  onOpenSkillMd: () => void
  onOpenFile: (relativePath: string) => void
  onCreate: (kind: SkillEntryKind, parentPath: string) => void
  onDeleteFolder: (relativePath: string) => void
  /** 左边的列都收起来了：回到上一级的入口（文字是回到哪） */
  back?: { label: string; onClick: () => void }
}

const iconBtn = "rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-2"

export function SkillFilesColumn({ rootId, skillPath, tree, expanded, skillMdActive, activeFile, onToggle, onOpenSkillMd, onOpenFile, onCreate, onDeleteFolder, back }: FilesProps) {
  const nodes = withoutSkillMd(tree.find((t) => t.name === skillPath)?.children)
  return (
    <aside className={columnCls} aria-label="Skill 里的文件">
      <div className="px-2 pt-1">{back && <BackButton label={back.label} onClick={back.onClick} />}</div>
      <div className="px-2.5 pb-1 pt-1">
        <p className="truncate text-sm font-medium text-fg-2" title={skillPath}>{skillPath}</p>
        <p className="text-[10px] text-fg-faint">Skill 里的内容</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button
          type="button"
          data-leaf="skill"
          aria-current={skillMdActive ? "true" : undefined}
          onClick={onOpenSkillMd}
          className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs transition ${skillMdActive ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}
        ><FileText size={13} className="shrink-0" />SKILL.md</button>

        <div className="mt-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium text-fg-muted">其他文件</span>
          <span className="flex items-center gap-0.5">
            <button type="button" title="新建文件" aria-label="新建文件" onClick={() => onCreate("file", "")} className={iconBtn}><FilePlus size={13} /></button>
            <button type="button" title="新建文件夹" aria-label="新建文件夹" onClick={() => onCreate("folder", "")} className={iconBtn}><FolderPlus size={13} /></button>
          </span>
        </div>
        <div className="mt-0.5">
          <SkillTreeList
            rootId={rootId}
            skillPath={skillPath}
            nodes={nodes}
            expanded={expanded}
            activeFile={activeFile}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
            onCreate={onCreate}
            onDeleteFolder={onDeleteFolder}
          />
          {nodes.length === 0 && <p className="px-2.5 py-1.5 text-[11px] leading-snug text-fg-faint">没有别的文件。需要脚本或参考资料时，点右上角的图标添加。</p>}
        </div>
      </div>
    </aside>
  )
}
