import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Download, Plus, Trash2, Upload, X } from "lucide-react"
import type { ProjectFieldDef } from "../../../shared/project-types"
import { WORK_BRANCH_MODES, normalizeWorkBranchMode, type WorkBranchMode } from "../../../shared/work-branch-mode"
import {
  TEMPLATE_DESC_MAX, TEMPLATE_FIELDS_MAX, TEMPLATE_NAME_MAX, templateDraftProblem, type TemplateDraft,
} from "../../../shared/project-template-edit"
import { usePanelSave } from "../usePanelSave"
import type { Group } from "./template-data"
import {
  EditorFrame, FieldLabel, SaveButtons, Section, dangerBtn, dashedBtn, ghostBtn, inputBase, inputCls, linkBtn, useRegisterGuard,
  type RegisterGuard,
} from "./project-ui"

function draftOf(group: Group | undefined): TemplateDraft {
  return {
    name: group?.name ?? "",
    description: group?.description ?? "",
    // 老数据没写类型的当接代码仓库（和建项目时的判断一致）；新建默认不接
    workspace: group ? (group.workspace === "plain" ? "plain" : "worktree") : "plain",
    branchMode: normalizeWorkBranchMode(group?.branchMode),
    fields: group?.fields?.map((f) => ({ ...f })) ?? [],
  }
}

interface Props {
  mode: "create" | "edit"
  /** 编辑已有模板时传 */
  group?: Group
  /** 别的模板的名字，用来防重名（新建项目时靠名字挑，重名会分不清） */
  otherNames: string[]
  onSubmit: (draft: TemplateDraft) => Promise<void>
  /** 新建时的「取消」 */
  onCancel?: () => void
  /** 编辑时的模板级操作；不传就不显示 */
  onDelete?: () => void
  /** 还有别的模板可以留着：只剩最后一个时删除按钮是灰的 */
  canDelete?: boolean
  onExport?: () => void
  onUpload?: () => void
  registerGuard: RegisterGuard
}

/** 模板信息：名称、说明、接不接代码仓库（随时可改）、建项目时要填的信息。新建和编辑共用 */
export default function TemplateInfoEditor({ mode, group, otherNames, onSubmit, onCancel, onDelete, canDelete = true, onExport, onUpload, registerGuard }: Props) {
  const editing = mode === "edit"
  const { justSaved, markSaved } = usePanelSave()
  const [draft, setDraft] = useState<TemplateDraft>(() => draftOf(group))
  const [base, setBase] = useState(() => JSON.stringify(draftOf(group)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const groupKey = JSON.stringify(group ? { n: group.name, d: group.description, w: group.workspace, b: group.branchMode, f: group.fields } : null)
  const lastKey = useRef(groupKey)
  useEffect(() => {
    if (lastKey.current === groupKey) return
    lastKey.current = groupKey
    const d = draftOf(group)
    setDraft(d)
    setBase(JSON.stringify(d))
  }, [groupKey, group])

  const dirty = JSON.stringify(draft) !== base
  const problem = templateDraftProblem(draft, otherNames)
  const canSave = !problem && (editing ? dirty : true)

  const setField = (i: number, patch: Partial<ProjectFieldDef>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }))
  const moveField = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const j = i + by
      if (j < 0 || j >= d.fields.length) return d
      const next = [...d.fields]
      ;[next[i], next[j]] = [next[j], next[i]]
      return { ...d, fields: next }
    })

  const save = async (): Promise<boolean> => {
    if (problem || busy) return false
    setBusy(true)
    setError("")
    try {
      await onSubmit(draft)
      markSaved()
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  // 新建时填了东西还没创建也算「没保存」：切走前问一下
  useRegisterGuard(registerGuard, dirty, save)

  return (
    <EditorFrame
      header={(
        <div className="px-0.5">
          <h3 className="text-sm font-medium text-fg-2">{editing ? "模板信息" : "新建项目模板"}</h3>
          {!editing && <p className="mt-0.5 text-[11.5px] text-fg-muted">模板决定新建项目时要填什么、项目里有哪些快捷操作。建好后会自带一个「开始」快捷操作，可以再改。</p>}
        </div>
      )}
      footer={(
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1">
            {editing && onDelete && (
              <button
                type="button"
                disabled={!canDelete}
                title={canDelete ? undefined : "至少保留 1 个项目模板"}
                onClick={onDelete}
                className={`${dangerBtn} disabled:opacity-40 disabled:hover:bg-transparent`}
              ><Trash2 size={13} />删除模板</button>
            )}
            {editing && onExport && <button type="button" onClick={onExport} className={linkBtn}><Download size={13} />导出文件</button>}
            {editing && onUpload && <button type="button" onClick={onUpload} className={linkBtn}><Upload size={13} />上传到共享空间</button>}
            <p role="alert" className={`min-w-0 truncate pl-1 text-xs ${error ? "text-danger" : "text-fg-muted"}`}>{error || (draft.name.trim() && dirty ? problem : "")}</p>
          </div>
          {editing ? (
            <SaveButtons dirty={dirty} canSave={canSave} justSaved={justSaved} busy={busy} onSave={() => void save()} onRevert={() => setDraft(draftOf(group))} />
          ) : (
            <div className="flex items-center gap-2">
              <button type="button" onClick={onCancel} disabled={busy} className={ghostBtn}>取消</button>
              <SaveButtons dirty={dirty} canSave={canSave} justSaved={false} busy={busy} saveLabel="创建" onSave={() => void save()} />
            </div>
          )}
        </>
      )}
    >
      <label className="block">
        <FieldLabel>模板名称</FieldLabel>
        <input value={draft.name} maxLength={TEMPLATE_NAME_MAX} autoFocus={!editing} placeholder="如：客户拜访" onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} />
      </label>

      <label className="block">
        <FieldLabel optional>说明（显示在新建项目的选择卡片下面）</FieldLabel>
        <textarea rows={2} value={draft.description} maxLength={TEMPLATE_DESC_MAX} placeholder="一句话说明这类项目是做什么的" onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${inputCls} resize-none`} />
      </label>

      <Section
        title="代码仓库"
        hint="打开后，新建项目时可以选代码仓库（选不选都行，不选就是普通项目）。仓库要不要克隆一份副本，在「设置 → 项目 → 常用代码仓库」里按仓库设置。"
      >
        <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
          <div className="min-w-0 pr-3">
            <p className="text-xs font-medium text-fg-2">接入代码仓库</p>
            <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">建项目时出现「代码仓库」选择；选了的仓库信息会记进项目，AI 按项目里记的目录去用。</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="接入代码仓库"
            aria-checked={draft.workspace === "worktree"}
            onClick={() => setDraft((d) => ({ ...d, workspace: d.workspace === "worktree" ? "plain" : "worktree" }))}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${draft.workspace === "worktree" ? "bg-primary" : "bg-stronger"}`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full shadow transition-transform duration-200 ${draft.workspace === "worktree" ? "translate-x-[18px] bg-on-primary" : "translate-x-[3px] bg-white"}`} />
          </button>
        </div>
        {draft.workspace === "worktree" && (
          <label className="block">
            <FieldLabel>默认工作分支</FieldLabel>
            <select
              aria-label="默认工作分支"
              value={normalizeWorkBranchMode(draft.branchMode)}
              onChange={(e) => setDraft((d) => ({ ...d, branchMode: normalizeWorkBranchMode(e.target.value) as WorkBranchMode }))}
              className={inputCls}
            >
              {WORK_BRANCH_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <span className="mt-1 block text-[11px] leading-snug text-fg-muted">
              {WORK_BRANCH_MODES.find((m) => m.value === normalizeWorkBranchMode(draft.branchMode))?.hint}。这里只是默认值，建项目时可以临时改。只对会克隆副本的仓库有效。
            </span>
          </label>
        )}
      </Section>

      <Section
        title="建项目时要填的信息"
        hint={`可选，最多 ${TEMPLATE_FIELDS_MAX} 项。填的内容会存在项目里，AI 做事时会参考；项目详情里也按这里的名称展示。`}
      >
        <div className="space-y-2">
          {draft.fields.map((f, i) => (
            <div key={i} className="rounded-lg border border-line-subtle p-2">
              <div className="flex items-center gap-2">
                <input value={f.label} placeholder="名称，如：客户" aria-label="信息名称" onChange={(e) => setField(i, { label: e.target.value })} className={`${inputBase} min-w-0 flex-1`} />
                <input value={f.placeholder ?? ""} placeholder="填写提示（可不填）" aria-label="填写提示" onChange={(e) => setField(i, { placeholder: e.target.value || undefined })} className={`${inputBase} min-w-0 flex-[1.6]`} />
              </div>
              <div className="mt-1.5 flex items-center gap-4 text-[11.5px] text-fg-muted">
                <label className="flex items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={f.required === true} onChange={(e) => setField(i, { required: e.target.checked || undefined })} className="accent-primary" />必填</label>
                <label className="flex items-center gap-1.5 whitespace-nowrap"><input type="checkbox" checked={f.multiline === true} onChange={(e) => setField(i, { multiline: e.target.checked || undefined })} className="accent-primary" />多行输入</label>
                <span className="flex-1" />
                <button type="button" title="上移" aria-label="上移" disabled={i === 0} onClick={() => moveField(i, -1)} className="shrink-0 rounded-md border border-line p-1 text-fg-3 hover:bg-raised disabled:opacity-30"><ArrowUp size={13} /></button>
                <button type="button" title="下移" aria-label="下移" disabled={i === draft.fields.length - 1} onClick={() => moveField(i, 1)} className="shrink-0 rounded-md border border-line p-1 text-fg-3 hover:bg-raised disabled:opacity-30"><ArrowDown size={13} /></button>
                <button type="button" title="删除这一项" aria-label="删除这一项" onClick={() => setDraft((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))} className="shrink-0 rounded-md border border-line p-1 text-fg-3 hover:bg-raised hover:text-danger"><X size={13} /></button>
              </div>
            </div>
          ))}
          {draft.fields.length < TEMPLATE_FIELDS_MAX && (
            <button type="button" onClick={() => setDraft((d) => ({ ...d, fields: [...d.fields, { label: "" }] }))} className={dashedBtn}><Plus size={13} />添加一项</button>
          )}
        </div>
      </Section>
    </EditorFrame>
  )
}
