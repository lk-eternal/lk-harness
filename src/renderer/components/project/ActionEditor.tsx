import { useEffect, useRef, useState } from "react"
import { Trash2, Upload } from "lucide-react"
import { ACTION_ID_RESERVED, ACTION_LABEL_MAX, actionIdProblem, makeUniqueId } from "../../../shared/project-template-edit"
import { usePanelSave } from "../usePanelSave"
import type { Action, Group } from "./template-data"
import {
  EditorFrame, FieldLabel, SaveButtons, dangerBtn, ghostBtn, inputCls, linkBtn, useRegisterGuard, type RegisterGuard,
} from "./project-ui"

/** 存进模板的快捷操作：prompt 留空表示用内置默认提示词 */
export interface ActionItem {
  id: string
  label: string
  prompt?: string
}

interface Draft {
  id: string
  label: string
  /** 输入框里的全文：没改过时就是内置默认提示词 */
  prompt: string
}

function draftOf(action: Action | undefined): Draft {
  return { id: action?.id ?? "", label: action?.label ?? "", prompt: action?.prompt ?? action?.defaultPrompt ?? "" }
}

interface Props {
  group: Group
  /** 正在编辑的快捷操作；新建时不传 */
  action?: Action
  /** 已经被占用的 id：别的模板里的、本模板里别的操作的 */
  takenIds: string[]
  canDelete: boolean
  /** 配好了共享空间，可以上传 */
  hubConfigured: boolean
  onSave: (item: ActionItem, isNew: boolean) => Promise<void>
  onDelete?: () => Promise<void>
  onUpload?: () => Promise<void>
  /** 新建时点取消 */
  onCancelNew?: () => void
  ui: { showAlert: (title: string, msg: string) => Promise<void> }
  registerGuard: RegisterGuard
}

/** 快捷操作：一个按钮名称 + 点它时交给 AI 的提示词。命令 id 自动生成，不用用户操心 */
export default function ActionEditor({ group, action, takenIds, canDelete, hubConfigured, onSave, onDelete, onUpload, onCancelNew, ui, registerGuard }: Props) {
  const isNew = !action
  const { justSaved, markSaved } = usePanelSave()
  const [draft, setDraft] = useState<Draft>(() => draftOf(action))
  const [base, setBase] = useState(() => JSON.stringify(draftOf(action)))
  const [busy, setBusy] = useState(false)
  const defaultPrompt = (action?.defaultPrompt ?? "").trim()

  // 保存后重新读回来、或别处改了这个操作：编辑区跟着换成最新的（改的是别的操作时不动）
  const actionKey = JSON.stringify(action ?? null)
  const lastKey = useRef(actionKey)
  useEffect(() => {
    if (lastKey.current === actionKey) return
    lastKey.current = actionKey
    const d = draftOf(action)
    setDraft(d)
    setBase(JSON.stringify(d))
  }, [actionKey, action])

  const dirty = JSON.stringify(draft) !== base
  const canSave = !!draft.label.trim() && dirty

  const save = async (): Promise<boolean> => {
    const label = draft.label.trim()
    if (!label) return false
    let id = action?.id ?? draft.id.trim()
    if (isNew) {
      // 新建：没手填命令 id 就按名字自动生成；手填了就按规则校验
      if (id) {
        const problem = actionIdProblem(id, takenIds)
        if (problem) { await ui.showAlert("命令 id 不可用", problem); return false }
      } else {
        id = makeUniqueId(label, takenIds, "action", ACTION_ID_RESERVED)
      }
    }
    const raw = draft.prompt.trim()
    const prompt = raw && raw !== defaultPrompt ? raw : undefined
    setBusy(true)
    try {
      await onSave({ id, label, prompt }, isNew)
      markSaved()
      return true
    } catch (e: unknown) {
      await ui.showAlert("保存失败", e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  useRegisterGuard(registerGuard, dirty, save)

  const usingDefault = defaultPrompt !== "" && draft.prompt.trim() === defaultPrompt
  const customized = defaultPrompt !== "" && draft.prompt.trim() !== defaultPrompt

  return (
    <EditorFrame
      header={(
        <div className="px-0.5">
          <p className="text-[11px] text-fg-muted">{group.name} ›</p>
          <h3 className="text-sm font-medium text-fg-2">{isNew ? "新快捷操作" : (action?.label || "快捷操作")}</h3>
        </div>
      )}
      footer={(
        <>
          <div className="flex items-center gap-1">
            {!isNew && onDelete && (
              <button
                type="button"
                disabled={!canDelete}
                title={canDelete ? undefined : "模板里至少要留一个快捷操作，否则用它建不了项目"}
                onClick={() => void onDelete()}
                className={`${dangerBtn} disabled:opacity-40 disabled:hover:bg-transparent`}
              ><Trash2 size={13} />删除</button>
            )}
            {!isNew && hubConfigured && onUpload && (
              <button type="button" onClick={() => void onUpload()} className={linkBtn}><Upload size={13} />上传到共享空间</button>
            )}
          </div>
          {isNew ? (
            <div className="flex items-center gap-2">
              <button type="button" onClick={onCancelNew} className={ghostBtn}>取消</button>
              <SaveButtons dirty={dirty} canSave={canSave} justSaved={justSaved} busy={busy} saveLabel="添加" onSave={() => void save()} />
            </div>
          ) : (
            <SaveButtons dirty={dirty} canSave={canSave} justSaved={justSaved} busy={busy} onSave={() => void save()} onRevert={() => setDraft(draftOf(action))} />
          )}
        </>
      )}
    >
      <label className="block">
        <FieldLabel>按钮名称</FieldLabel>
        <input
          value={draft.label}
          maxLength={ACTION_LABEL_MAX}
          placeholder="如：测试报告"
          autoFocus={isNew}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          className={inputCls}
        />
      </label>

      <label className="block">
        <FieldLabel>点这个按钮时，让 AI 做什么</FieldLabel>
        <textarea
          rows={14}
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          placeholder="每行一条要求，会原样发给 AI。写清要做什么、产出什么、放在哪；不写的话 AI 只会按按钮名称理解。"
          className={`${inputCls} font-mono text-xs leading-relaxed`}
        />
        {usingDefault && <p className="mt-1 text-[11px] text-fg-muted">当前用的是内置的默认提示词（上面就是全文，改动即覆盖）。</p>}
        {customized && (
          <button type="button" className="mt-1 text-[11px] text-accent hover:text-accent-soft" onClick={() => setDraft({ ...draft, prompt: action?.defaultPrompt ?? "" })}>恢复内置默认提示词</button>
        )}
      </label>

      <details className="rounded-lg border border-line-subtle px-3 py-2 text-xs text-fg-muted">
        <summary className="cursor-pointer select-none text-fg-3">更多</summary>
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-fg-muted">命令 id（飞书里用 /p 命令触发时才会用到）</p>
          {isNew ? (
            <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.trim() })} className={inputCls} placeholder="不填，保存时按名称自动生成" />
          ) : (
            <>
              <p className="font-mono text-xs text-fg-2">{action?.id}</p>
              <p className="text-[10.5px] text-fg-faint">已经被项目和命令引用，建好后不能改。</p>
            </>
          )}
        </div>
      </details>
    </EditorFrame>
  )
}
