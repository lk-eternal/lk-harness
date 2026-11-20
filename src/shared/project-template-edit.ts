/**
 * 设置页「项目模板」编辑用的纯逻辑（不依赖 node / react，方便单测）。
 * 模板和快捷操作的 id 是内部标识，用户和 AI 都不用看：这里随机生成，不带任何语意。
 */
import type { ProjectFieldDef, ProjectNodeDef, ProjectNodeGroupDef } from "./project-types.js"
import { normalizeWorkBranchMode, type WorkBranchMode } from "./work-branch-mode.js"
import { normalizeFieldDefs } from "./project-templates.js"

export const TEMPLATE_NAME_MAX = 30
export const TEMPLATE_DESC_MAX = 200
export const TEMPLATE_FIELDS_MAX = 8
export const ACTION_LABEL_MAX = 40

const ID_FIRST_CHARS = "abcdefghijklmnopqrstuvwxyz"
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
const ID_LENGTH = 8

function pickChar(chars: string): string {
  return chars[Math.floor(Math.random() * chars.length)]
}

/**
 * 生成一个随机 id：小写字母开头，后面是小写字母和数字，和名字没有任何关系。
 * 不从名字派生，就不会和内置节点的默认提示词、/p 子命令撞名；taken 里已有的会避开。
 */
export function newOpaqueId(taken: Iterable<string>): string {
  const used = new Set<string>(taken)
  let id: string
  do {
    id = pickChar(ID_FIRST_CHARS) + Array.from({ length: ID_LENGTH - 1 }, () => pickChar(ID_CHARS)).join("")
  } while (used.has(id))
  return id
}

/** 「建项时要填的信息」的校验：数量、重名（值按名字存，重名会互相覆盖）；空名字的行保存时会被丢掉，不算错 */
export function templateFieldsProblem(fields: readonly ProjectFieldDef[]): string {
  const named = fields.map((f) => (f.label ?? "").trim()).filter(Boolean)
  if (named.length > TEMPLATE_FIELDS_MAX) return `要填的信息最多 ${TEMPLATE_FIELDS_MAX} 项`
  const seen = new Set<string>()
  for (const n of named) {
    if (seen.has(n)) return `「${n}」重复了，每一项要有不同的名字`
    seen.add(n)
  }
  return ""
}

export interface TemplateDraft {
  name: string
  description: string
  /** 接不接代码仓库：任何模板都可以随时打开或关掉 */
  workspace: "plain" | "worktree"
  /** 接了仓库时克隆副本停在哪个分支的默认值；不接仓库时无意义，保存时丢掉 */
  branchMode?: WorkBranchMode
  fields: ProjectFieldDef[]
}

/** 草稿里的工作分支落到模板上的样子：不接仓库、或就是默认的「新建分支」都不存（缺省=新建分支） */
function draftBranchMode(d: TemplateDraft): { branchMode: WorkBranchMode } | Record<string, never> {
  if (d.workspace !== "worktree") return {}
  const mode = normalizeWorkBranchMode(d.branchMode)
  return mode === "new" ? {} : { branchMode: mode }
}

/** 保存模板前的校验；otherNames 是别的模板的名字（新建项目时靠名字挑，重名会分不清）。没问题返回空串 */
export function templateDraftProblem(d: TemplateDraft, otherNames: Iterable<string> = []): string {
  const name = d.name.trim()
  if (!name) return "请填写模板名称"
  if (name.length > TEMPLATE_NAME_MAX) return `模板名称不要超过 ${TEMPLATE_NAME_MAX} 个字`
  for (const o of otherNames) if (o.trim() === name) return `已经有叫「${name}」的模板了，换个名字`
  if (d.description.trim().length > TEMPLATE_DESC_MAX) return `说明不要超过 ${TEMPLATE_DESC_MAX} 个字`
  return templateFieldsProblem(d.fields)
}

/** 新模板自带的第一个快捷操作：模板里至少要有一个，否则建不了项目 */
const STARTER_ACTION: Pick<ProjectNodeDef, "label" | "prompt"> = {
  label: "开始",
  prompt: "按项目目标开始推进：先说说你对现状和接下来要做的事的理解；缺关键信息先问我，信息够了就直接动手，做完说明成果放在哪。",
}

/** 用草稿生成一个新模板（id 自动生成，带一个起步的快捷操作） */
export function buildNewTemplate(
  d: TemplateDraft,
  existingGroupIds: Iterable<string>,
  existingActionIds: Iterable<string>,
): ProjectNodeGroupDef {
  const actionId = newOpaqueId(existingActionIds)
  const fields = normalizeFieldDefs(d.fields)
  const description = d.description.trim()
  return {
    id: newOpaqueId(existingGroupIds),
    name: d.name.trim(),
    workspace: d.workspace,
    ...draftBranchMode(d),
    ...(description ? { description } : {}),
    ...(fields ? { fields } : {}),
    nodes: [{ id: actionId, label: STARTER_ACTION.label, prompt: STARTER_ACTION.prompt }],
  }
}

/**
 * 把编辑后的草稿合并回已有模板：动名称、说明、要填的信息、接不接代码仓库和工作分支；
 * id、快捷操作、共享空间的跟踪信息都不动。已经建好的项目有自己的模板副本，不受影响。
 */
export function applyTemplateEdit(g: ProjectNodeGroupDef, d: TemplateDraft): ProjectNodeGroupDef {
  const { description: _d, fields: _f, branchMode: _b, ...rest } = g
  const description = d.description.trim()
  const fields = normalizeFieldDefs(d.fields)
  return {
    ...rest,
    name: d.name.trim(),
    workspace: d.workspace,
    ...draftBranchMode(d),
    ...(description ? { description } : {}),
    ...(fields ? { fields } : {}),
  }
}
