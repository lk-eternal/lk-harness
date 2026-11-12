import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Archive, ArchiveRestore, ChevronRight, Copy, FolderOpen, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { PROJECT_NAME_MAX, PROJECT_TEXT_MAX, projectDeleteConfirmText, type ProjectListItem } from "../../../shared/project-app-types"
import { bugWatchUnsupportedReason } from "../../../shared/project-bug-watch"
import {
  INFO_KEY_MAX, LINK_FIELDS, bugWatchView, composeMetadata, fieldsForSelection, linkFieldsShown, newInfoRow,
  retargetInfo, sameIdList, splitInfo, type InfoForm, type LinkKey,
} from "../../../shared/project-detail-form"
import { usePanelSave } from "../usePanelSave"
import type { Group } from "./template-data"
import {
  EditorFrame, FieldLabel, SaveButtons, Section, dangerBtn, dashedBtn, ghostBtn, inputBase, inputCls, linkBtn, useRegisterGuard,
  type RegisterGuard,
} from "./project-ui"

interface Draft {
  name: string
  goal: string
  groupIds: string[]
  links: Record<LinkKey, string>
  watchBugs: boolean
  info: InfoForm
}

function draftOf(item: ProjectListItem): Draft {
  return {
    name: item.name,
    goal: item.goal,
    groupIds: [...item.groupIds],
    links: {
      storyUrl: item.storyUrl ?? "",
      relatedDocs: item.relatedDocs ?? "",
      productDocUrl: item.productDocUrl ?? "",
      techDocUrl: item.techDocUrl ?? "",
    },
    watchBugs: item.watchBugs,
    info: splitInfo(item.fields, item.metadata),
  }
}

/** 比较「改没改」用的快照：行 id 和空白行不算 */
function snapshotOf(d: Draft): string {
  return JSON.stringify({
    ...d,
    info: { values: d.info.values, extra: d.info.extra.filter((r) => r.key || r.value).map((r) => [r.key, r.value]) },
  })
}

interface Props {
  item: ProjectListItem
  /** 全部项目模板：换模板时按它算要填的信息 */
  groups: Group[]
  ui: { showAlert: (title: string, msg: string) => Promise<void>; showConfirm: (title: string, msg: string, ok?: string, cancel?: string) => Promise<boolean> }
  /** 保存、同步之后：让外壳重新读项目列表 */
  onChanged: () => Promise<void>
  onDeleted: () => Promise<void>
  onOpenTemplate: (groupId: string) => void
  registerGuard: RegisterGuard
}

function Fact({ label, value, actions }: { label: string; value: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-xs">
      <dt className="w-16 shrink-0 pt-0.5 text-fg-muted">{label}</dt>
      <dd className="min-w-0 flex-1 whitespace-pre-wrap break-all text-fg-2">{value}</dd>
      {actions}
    </div>
  )
}

/**
 * 项目详情：名称、目标、模板要填的信息、其他信息、所用模板、位置。
 * 展示什么跟着项目所用的模板走（模板要填什么就展示什么），不再给每个项目摆一排用不上的输入框。
 */
export default function ProjectDetail({ item, groups, ui, onChanged, onDeleted, onOpenTemplate, registerGuard }: Props) {
  const { justSaved, markSaved } = usePanelSave()
  const [draft, setDraft] = useState<Draft>(() => draftOf(item))
  const [base, setBase] = useState(() => snapshotOf(draftOf(item)))
  const [busy, setBusy] = useState(false)

  // 资料在别处变了（保存后重新读回来、同步了模板）：编辑区跟着换成最新的
  const itemKey = JSON.stringify(item)
  const lastKey = useRef(itemKey)
  useEffect(() => {
    if (lastKey.current === itemKey) return
    lastKey.current = itemKey
    const d = draftOf(item)
    setDraft(d)
    setBase(snapshotOf(d))
  }, [itemKey, item])

  const dirty = snapshotOf(draft) !== base
  const fields = useMemo(() => fieldsForSelection(item, draft.groupIds, groups), [item, draft.groupIds, groups])
  const shownLinks = useMemo(() => linkFieldsShown(item), [item])
  const storyShown = shownLinks.includes("storyUrl")
  const bugView = bugWatchView(draft.links.storyUrl, draft.watchBugs, storyShown)
  const canSave = !!draft.name.trim() && dirty

  const save = async (): Promise<boolean> => {
    const name = draft.name.trim()
    if (!name) { await ui.showAlert("还不能保存", "项目名称不能为空"); return false }
    const composed = composeMetadata(fields, draft.info)
    if (!composed.ok) { await ui.showAlert("还不能保存", composed.error); return false }
    const patch: Parameters<typeof window.electronAPI.updateProject>[0] = {
      id: item.id,
      name,
      goal: draft.goal.trim(),
      metadata: composed.metadata,
    }
    for (const k of shownLinks) patch[k] = draft.links[k].trim()
    // 模板没换就别传：传了会让主进程重新复制项目的快捷操作
    if (!sameIdList(draft.groupIds, item.groupIds)) patch.groupIds = draft.groupIds
    // 需求链接不支持时一律关掉（改掉链接后不能留着一个空转的开关）
    const story = storyShown ? draft.links.storyUrl : (item.storyUrl ?? "")
    patch.watchBugs = !bugWatchUnsupportedReason(story) && draft.watchBugs
    setBusy(true)
    try {
      const r = await window.electronAPI.updateProject(patch)
      if (!r.ok) { await ui.showAlert("保存失败", r.error ?? "保存失败"); return false }
      await onChanged()
      markSaved()
      return true
    } finally {
      setBusy(false)
    }
  }

  useRegisterGuard(registerGuard, dirty, save)

  const revert = () => setDraft(draftOf(item))

  const toggleGroup = (id: string) => {
    const has = draft.groupIds.includes(id)
    if (has && draft.groupIds.length === 1) return // 至少留一个模板
    const nextIds = has ? draft.groupIds.filter((x) => x !== id) : [...draft.groupIds, id]
    setDraft({ ...draft, groupIds: nextIds, info: retargetInfo(draft.info, fieldsForSelection(item, nextIds, groups)) })
  }

  const setValue = (label: string, v: string) => setDraft({ ...draft, info: { ...draft.info, values: { ...draft.info.values, [label]: v } } })
  const setExtra = (id: number, patch: { key?: string; value?: string }) =>
    setDraft({ ...draft, info: { ...draft.info, extra: draft.info.extra.map((r) => (r.id === id ? { ...r, ...patch } : r)) } })

  const remove = async () => {
    const text = projectDeleteConfirmText({ name: item.name, externalDir: item.externalWorkspace, dir: item.dir, isCode: item.isCode })
    if (!(await ui.showConfirm("删除项目", text, "删除", "取消"))) return
    const r = await window.electronAPI.deleteProject(item.id)
    if (!r.ok) { void ui.showAlert("删除失败", r.error ?? "删除失败"); return }
    await onDeleted()
  }

  /** 归档 / 取消归档：不用确认，随时能取消。有没保存的修改先存下来，不然重新读回资料时会把它们冲掉 */
  const toggleArchive = async () => {
    const next = !item.archived
    if (dirty && !(await save())) return
    const r = await window.electronAPI.setProjectArchived(item.id, next)
    if (!r.ok) { void ui.showAlert(next ? "归档失败" : "取消归档失败", r.error ?? "操作失败"); return }
    await onChanged()
  }

  const switchTo = async () => {
    const r = await window.electronAPI.switchProject(item.id)
    if (!r.ok) void ui.showAlert("切换失败", r.error ?? "切换失败")
    await onChanged()
  }

  const sync = async () => {
    const r = await window.electronAPI.syncProjectSteps(item.id)
    if (!r.ok) { void ui.showAlert("同步失败", r.error ?? "同步失败"); return }
    await onChanged()
  }

  const selectedNames = draft.groupIds.map((id) => groups.find((g) => g.id === id)?.name).filter(Boolean) as string[]
  // 副标题的快捷操作数：模板还没换就是项目现在的，换了（还没保存）就按所选模板算
  const actionCount = sameIdList(draft.groupIds, item.groupIds)
    ? item.actions.length
    : new Set(draft.groupIds.flatMap((id) => groups.find((g) => g.id === id)?.nodes.map((n) => n.id) ?? [])).size

  return (
    <EditorFrame
      header={(
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <input
              aria-label="项目名称"
              value={draft.name}
              maxLength={PROJECT_NAME_MAX}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-medium text-fg outline-none transition hover:border-line focus:border-blue-500 focus:bg-surface"
            />
            {item.archived && <span className="shrink-0 rounded bg-raised px-2 py-0.5 text-xs text-fg-muted">已归档</span>}
          </div>
          <p className="px-2 text-[11.5px] text-fg-muted">
            {selectedNames.join("、") || "普通项目"} · {actionCount} 个快捷操作
            {item.isCode ? " · 研发项目" : ""}
          </p>
        </div>
      )}
      footer={(
        <>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => void remove()} className={dangerBtn}><Trash2 size={13} />删除</button>
            <button
              type="button"
              onClick={() => void toggleArchive()}
              title={item.archived ? "放回对话页的会话列表" : "做完了就归档：对话页里收进最下面的「已归档」，会话和成果都留着，随时可以取消"}
              className={linkBtn}
            >{item.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{item.archived ? "取消归档" : "归档"}</button>
            {!item.groupChatId && <button type="button" onClick={() => void switchTo()} className={linkBtn}>切换至</button>}
          </div>
          <SaveButtons dirty={dirty} canSave={canSave} justSaved={justSaved} busy={busy} onSave={() => void save()} onRevert={revert} />
        </>
      )}
    >
      <label className="block">
        <FieldLabel optional>想做成什么</FieldLabel>
        <textarea
          value={draft.goal}
          maxLength={PROJECT_TEXT_MAX}
          rows={3}
          placeholder="一两句话说清目标，AI 会据此推进"
          onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
          className={`${inputCls} resize-none`}
        />
      </label>

      {fields.length > 0 && (
        <Section title="模板里的信息" hint={`新建这类项目时要填的内容，AI 做事时会参考。`}>
          <div className="space-y-3">
            {fields.map((f) => (
              <label key={f.label} className="block">
                <FieldLabel optional={!f.required}>{f.label}</FieldLabel>
                {f.multiline ? (
                  <textarea
                    value={draft.info.values[f.label] ?? ""}
                    maxLength={PROJECT_TEXT_MAX}
                    rows={2}
                    placeholder={f.placeholder}
                    onChange={(e) => setValue(f.label, e.target.value)}
                    className={`${inputCls} resize-none`}
                  />
                ) : (
                  <input
                    value={draft.info.values[f.label] ?? ""}
                    maxLength={PROJECT_TEXT_MAX}
                    placeholder={f.placeholder}
                    onChange={(e) => setValue(f.label, e.target.value)}
                    className={inputCls}
                  />
                )}
              </label>
            ))}
          </div>
        </Section>
      )}

      {shownLinks.length > 0 && (
        <Section title="链接和文档">
          <div className="space-y-3">
            {LINK_FIELDS.filter((l) => shownLinks.includes(l.key)).map((l) => (
              <div key={l.key}>
                <label className="block">
                  <FieldLabel optional>{l.label}</FieldLabel>
                  {l.multiline ? (
                    <textarea
                      value={draft.links[l.key]}
                      maxLength={PROJECT_TEXT_MAX}
                      rows={2}
                      placeholder={l.placeholder}
                      onChange={(e) => setDraft({ ...draft, links: { ...draft.links, [l.key]: e.target.value } })}
                      className={`${inputCls} resize-none`}
                    />
                  ) : (
                    <input
                      value={draft.links[l.key]}
                      maxLength={PROJECT_TEXT_MAX}
                      placeholder={l.placeholder}
                      onChange={(e) => setDraft({ ...draft, links: { ...draft.links, [l.key]: e.target.value } })}
                      className={inputCls}
                    />
                  )}
                </label>
                {l.key === "storyUrl" && bugView && (
                  <div className="mt-2">
                    <label className={`flex items-center gap-2 text-xs ${bugView.disabled ? "text-fg-faint" : "text-fg-3"}`}>
                      <input
                        type="checkbox"
                        disabled={bugView.disabled}
                        checked={bugView.checked}
                        onChange={(e) => setDraft({ ...draft, watchBugs: e.target.checked })}
                        className="rounded border-line-strong"
                      />
                      自动盯缺陷
                    </label>
                    <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
                      {bugView.reason
                        ? `暂不能开启：${bugView.reason}`
                        : "每 10 分钟查一次飞书项目里关联本需求的缺陷，发现新增的就交给项目会话处理，并在项目群里提一句。开启时已有的缺陷不会通知，只通知之后新增的。"}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="其他信息"
        hint="AI 做事时会参考这些，也会在工作中补充新的。想让 AI 记住什么，写在这里就行。"
      >
        {draft.info.extra.length > 0 && (
          <div className="space-y-2" data-testid="extra-info">
            {draft.info.extra.map((r) => (
              <div key={r.id} className="flex items-center gap-2">
                <input
                  value={r.key}
                  maxLength={INFO_KEY_MAX}
                  placeholder="名称，如：预算"
                  aria-label="其他信息的名称"
                  onChange={(e) => setExtra(r.id, { key: e.target.value })}
                  className={`${inputBase} w-36 shrink-0`}
                />
                <input
                  value={r.value}
                  maxLength={PROJECT_TEXT_MAX}
                  placeholder="内容"
                  aria-label="其他信息的内容"
                  onChange={(e) => setExtra(r.id, { value: e.target.value })}
                  className={`${inputBase} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  title="删除这一项"
                  aria-label="删除这一项"
                  onClick={() => setDraft({ ...draft, info: { ...draft.info, extra: draft.info.extra.filter((x) => x.id !== r.id) } })}
                  className="shrink-0 rounded-md border border-line p-1.5 text-fg-3 transition hover:bg-raised hover:text-danger"
                ><X size={13} /></button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setDraft({ ...draft, info: { ...draft.info, extra: [...draft.info.extra, newInfoRow()] } })}
          className={dashedBtn}
        ><Plus size={13} />添加一项</button>
      </Section>

      <Section
        title="项目模板"
        hint="模板决定项目里有哪些快捷操作、要填哪些信息。换模板后，已经填的内容会保留。"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {groups.map((g) => {
            const on = draft.groupIds.includes(g.id)
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleGroup(g.id)}
                className={`rounded-md border px-3 py-1.5 text-xs transition ${on ? "border-blue-500 bg-blue-500/10 font-medium text-fg" : "border-line text-fg-3 hover:bg-raised hover:text-fg-soft"}`}
              >{g.name}</button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {draft.groupIds[0] && groups.some((g) => g.id === draft.groupIds[0]) && (
            <button type="button" onClick={() => onOpenTemplate(draft.groupIds[0])} className="inline-flex items-center gap-0.5 text-xs text-accent transition hover:text-accent-soft">
              查看「{groups.find((g) => g.id === draft.groupIds[0])?.name}」模板<ChevronRight size={12} />
            </button>
          )}
          {item.canSyncSteps && (
            <button type="button" disabled={dirty} onClick={() => void sync()} title={dirty ? "先保存修改再同步" : undefined} className={`${ghostBtn} inline-flex items-center gap-1 px-2 py-1`}>
              <RefreshCw size={12} />同步模板的最新改动
            </button>
          )}
        </div>
        {item.hasGroupSnapshot && (
          <p className="text-[11px] leading-relaxed text-fg-muted">
            这个项目有自己的一份快捷操作副本，模板之后的改动不会自动带过来；{item.canSyncSteps ? "模板已经有新改动，可以点上面的按钮同步。" : "现在和模板是一致的。"}
            换模板会按所选模板重新复制。
          </p>
        )}
      </Section>

      <Section title="位置">
        <dl className="space-y-2 rounded-lg border border-line-subtle bg-surface/50 px-3 py-2.5">
          <Fact
            label="项目文件夹"
            value={item.dir || "—"}
            actions={item.dir ? (
              <span className="flex shrink-0 items-center gap-0.5">
                <button type="button" title="在文件夹中显示" aria-label="在文件夹中显示" onClick={() => void window.electronAPI.appChatShowInFolder(item.dir)} className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-2"><FolderOpen size={13} /></button>
                <button type="button" title="复制路径" aria-label="复制路径" onClick={() => void navigator.clipboard.writeText(item.dir)} className="rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-2"><Copy size={13} /></button>
              </span>
            ) : undefined}
          />
          {item.isCode && item.featureBranch && <Fact label="feature 分支" value={item.featureBranch} />}
          {item.isCode && item.repoPaths.length > 0 && <Fact label="代码仓库" value={item.repoPaths.join("\n")} />}
        </dl>
        {item.externalWorkspace && <p className="text-[11px] text-fg-muted">这是你自己选的文件夹，删除项目时不会删它。</p>}
      </Section>
    </EditorFrame>
  )
}
