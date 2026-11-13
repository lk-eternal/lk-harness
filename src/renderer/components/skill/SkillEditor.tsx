import { FolderSearch, Trash2 } from "lucide-react"
import { EditorFrame, FieldLabel, SaveButtons, dangerBtn, inputCls } from "../project/project-ui"
import { diskLocationOf } from "../skill-entry"

export type EditMode =
  | { kind: "skill"; skillPath: string; name: string; content: string; originalPath: string | null; isNew: boolean }
  | { kind: "file"; skillPath: string; relativePath: string; content: string }

interface Props {
  edit: EditMode
  /** 目录的显示路径，如 ~/.cursor/skills，用来在标题下写出完整位置 */
  rootLabel: string
  dirty: boolean
  justSaved: boolean
  /** 保存失败的原因，显示在内容上方 */
  error: string | null
  onChange: (next: EditMode) => void
  onSave: () => void
  onRevert: () => void
  onDelete: () => void
  /** 在系统文件管理器里显示正在编辑的这个文件（新建还没保存的 Skill 磁盘上还没有，不显示这个入口） */
  onReveal: () => void
}

const mono = `${inputCls} font-mono text-xs leading-relaxed`

/** 右边的编辑区：编辑 Skill 的 SKILL.md（还可以改路径），或 Skill 里的某个文件 */
export default function SkillEditor({ edit, rootLabel, dirty, justSaved, error, onChange, onSave, onRevert, onDelete, onReveal }: Props) {
  const isSkill = edit.kind === "skill"
  const title = isSkill ? (edit.isNew ? "新 Skill" : edit.originalPath ?? edit.skillPath) : edit.relativePath
  const where = isSkill
    ? `${rootLabel}/${edit.isNew ? "…" : edit.originalPath ?? edit.skillPath}/SKILL.md`
    : `${rootLabel}/${edit.skillPath}/${edit.relativePath}`
  const canSave = dirty && (!isSkill || edit.name.trim() !== "")

  return (
    <EditorFrame
      header={
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg-2" title={title}>{title}</p>
            <p className="truncate font-mono text-[11px] text-fg-muted" title={where}>{where}</p>
          </div>
          {diskLocationOf(edit) && (
            <button
              type="button"
              title="在文件管理器中显示这个文件"
              onClick={onReveal}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-fg-3 transition hover:bg-raised hover:text-fg"
            ><FolderSearch size={13} />显示位置</button>
          )}
        </div>
      }
      footer={
        <>
          <button type="button" onClick={onDelete} className={dangerBtn}>
            <Trash2 size={13} />{isSkill ? (edit.isNew ? "放弃" : "删除 Skill") : "删除文件"}
          </button>
          <SaveButtons dirty={dirty} canSave={canSave} justSaved={justSaved} onSave={onSave} onRevert={onRevert} />
        </>
      }
    >
      {error && <p role="alert" className="rounded-md bg-danger-tint/30 px-3 py-2 text-xs text-danger">{error}</p>}
      {edit.kind === "skill" ? (
        <>
          <label className="block">
            <FieldLabel>路径</FieldLabel>
            <input
              type="text"
              value={edit.name}
              onChange={(e) => onChange({ ...edit, name: e.target.value })}
              className={inputCls}
              placeholder="my-skill"
              aria-label="Skill 路径"
            />
            {!edit.isNew && <span className="mt-1 block text-[11px] text-fg-faint">改了路径，保存时会把整个 Skill 文件夹改名。</span>}
          </label>
          <label className="block">
            <FieldLabel>SKILL.md</FieldLabel>
            <textarea
              value={edit.content}
              onChange={(e) => onChange({ ...edit, content: e.target.value })}
              rows={20}
              className={mono}
              placeholder={"---\nname: my-skill\ndescription: 一句话说明什么时候该用它\n---\n\n在这里写 AI 该怎么做。"}
              aria-label="SKILL.md 内容"
            />
          </label>
        </>
      ) : (
        <textarea
          value={edit.content}
          onChange={(e) => onChange({ ...edit, content: e.target.value })}
          rows={24}
          className={mono}
          aria-label={`${edit.relativePath} 内容`}
        />
      )}
    </EditorFrame>
  )
}
