import { ChevronLeft, FileText, GitBranch, Plus } from "lucide-react"
import SortableList from "../SortableList"
import type { TemplateDraft } from "../../../shared/project-template-edit"
import ActionEditor, { type ActionItem } from "./ActionEditor"
import TemplateInfoEditor from "./TemplateInfoEditor"
import type { ProjectsSel, TemplateLeaf } from "./projects-nav"
import { isCodeGroup, type Action, type Group } from "./template-data"
import type { RegisterGuard } from "./project-ui"

/** 外壳提供的模板操作：落盘、确认框、提示都在外壳里，这里只管界面 */
export interface TemplateOps {
  saveInfo: (groupId: string, draft: TemplateDraft) => Promise<void>
  saveAction: (groupId: string, item: ActionItem, isNew: boolean) => Promise<void>
  deleteAction: (groupId: string, actionId: string) => Promise<void>
  reorderActions: (groupId: string, nodes: Action[]) => Promise<void>
  deleteTemplate: (groupId: string) => Promise<void>
  exportTemplate: (groupId: string) => Promise<void>
  uploadTemplate: (groupId: string) => Promise<void>
  uploadAction: (groupId: string, actionId: string) => Promise<void>
  openHubActions: (groupId: string) => void
}

interface Props {
  group: Group
  leaf: TemplateLeaf
  groups: Group[]
  go: (next: ProjectsSel) => void
  ops: TemplateOps
  hubUrlReady: boolean
  hubConfigured: boolean
  ui: { showAlert: (title: string, msg: string) => Promise<void> }
  registerGuard: RegisterGuard
  /** 窗口窄、最左边的模板栏收起来了：给出「返回」，点了回到模板栏 */
  onBack?: () => void
}

const rowCls = (on: boolean) =>
  `flex items-center gap-1 rounded-md transition ${on ? "bg-raised/70" : "hover:bg-raised/40"}`

/**
 * 一个模板的两栏：左边是这个模板里的东西（模板信息、快捷操作列表），右边是选中那一项的编辑区。
 * 和「项目列表 → 项目详情」一样，一级一级点下去。
 */
export default function TemplateWorkspace({ group, leaf, groups, go, ops, hubUrlReady, hubConfigured, ui, registerGuard, onBack }: Props) {
  const select = (next: TemplateLeaf) => go({ kind: "template", id: group.id, leaf: next })
  const otherActionIds = groups.filter((g) => g.id !== group.id).flatMap((g) => g.nodes.map((n) => n.id))
  const action = leaf.kind === "action" ? group.nodes.find((n) => n.id === leaf.id) : undefined

  return (
    <>
      <div className="flex w-52 shrink-0 flex-col border-r border-line-subtle pr-3" aria-label="模板内容">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-1.5 inline-flex items-center gap-0.5 self-start rounded-md py-1 pl-0.5 pr-2 text-xs text-fg-muted transition hover:bg-raised hover:text-fg-2"
          ><ChevronLeft size={14} />全部模板</button>
        )}
        <div className="pb-2">
          <p className="truncate text-sm font-medium text-fg-2" title={group.name}>{group.name}</p>
          <p className="flex items-center gap-1 text-[11px] text-fg-muted">
            {isCodeGroup(group) ? <><GitBranch size={11} />研发 · 接代码仓库</> : "通用"}
          </p>
        </div>

        <button
          type="button"
          data-leaf="info"
          aria-current={leaf.kind === "info" ? "true" : undefined}
          onClick={() => select({ kind: "info" })}
          className={`${rowCls(leaf.kind === "info")} px-2 py-2 text-left text-xs ${leaf.kind === "info" ? "font-medium text-fg" : "text-fg-3"}`}
        ><FileText size={13} className="shrink-0" />模板信息</button>

        <div className="mt-3 flex items-baseline justify-between px-1">
          <span className="text-[11px] font-medium text-fg-muted">快捷操作 <span className="font-normal text-fg-faint">{group.nodes.length}</span></span>
        </div>
        <p className="px-1 pb-1.5 pt-0.5 text-[10.5px] leading-snug text-fg-faint">项目里的快捷按钮，点一下让 AI 按提示词做事。顺序只影响显示，可拖动调整。</p>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SortableList
            items={group.nodes}
            getId={(n) => n.id}
            onReorder={(next) => ops.reorderActions(group.id, next)}
            gapClass="space-y-0.5"
            renderItem={(n, { grip }) => {
              const on = leaf.kind === "action" && leaf.id === n.id
              return (
                <div className={rowCls(on)}>
                  {grip}
                  <button type="button" data-leaf="action" aria-current={on ? "true" : undefined} onClick={() => select({ kind: "action", id: n.id })} className={`min-w-0 flex-1 py-2 pr-2 text-left text-xs ${on ? "font-medium text-fg" : "text-fg-3"}`}>
                    <span className="block truncate">{n.label}</span>
                  </button>
                </div>
              )
            }}
          />
          {leaf.kind === "new-action" && (
            <div className={`${rowCls(true)} px-2 py-2 text-xs font-medium text-fg`} aria-current="true">新快捷操作</div>
          )}
          <button
            type="button"
            onClick={() => select({ kind: "new-action" })}
            className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 text-xs text-fg-muted transition hover:border-line-strong hover:bg-raised/40"
          ><Plus size={14} />添加快捷操作</button>
          {hubUrlReady && (
            <button
              type="button"
              onClick={() => ops.openHubActions(group.id)}
              className={`mt-1 w-full rounded-md px-2 py-1.5 text-[11px] transition hover:bg-raised/40 ${hubConfigured ? "text-accent" : "text-fg-muted"}`}
            >从共享空间获取快捷操作</button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 pl-4">
        {leaf.kind === "info" && (
          <TemplateInfoEditor
            key={group.id}
            mode="edit"
            group={group}
            otherNames={groups.filter((g) => g.id !== group.id).map((g) => g.name)}
            onSubmit={(draft) => ops.saveInfo(group.id, draft)}
            onDelete={() => void ops.deleteTemplate(group.id)}
            canDelete={groups.length > 1}
            onExport={() => void ops.exportTemplate(group.id)}
            onUpload={hubConfigured ? () => void ops.uploadTemplate(group.id) : undefined}
            registerGuard={registerGuard}
          />
        )}
        {leaf.kind === "action" && action && (
          <ActionEditor
            key={`${group.id}:${action.id}`}
            group={group}
            action={action}
            takenIds={[...otherActionIds, ...group.nodes.filter((n) => n.id !== action.id).map((n) => n.id)]}
            canDelete={group.nodes.length > 1}
            hubConfigured={hubConfigured}
            onSave={(item, isNew) => ops.saveAction(group.id, item, isNew)}
            onDelete={() => ops.deleteAction(group.id, action.id)}
            onUpload={() => ops.uploadAction(group.id, action.id)}
            ui={ui}
            registerGuard={registerGuard}
          />
        )}
        {leaf.kind === "new-action" && (
          <ActionEditor
            key={`${group.id}:new`}
            group={group}
            takenIds={[...otherActionIds, ...group.nodes.map((n) => n.id)]}
            canDelete={false}
            hubConfigured={hubConfigured}
            onSave={(item, isNew) => ops.saveAction(group.id, item, isNew)}
            onCancelNew={() => select({ kind: "info" })}
            ui={ui}
            registerGuard={registerGuard}
          />
        )}
      </div>
    </>
  )
}
