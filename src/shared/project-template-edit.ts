/**
 * 设置页「项目模板」编辑用的纯逻辑（不依赖 node / react，方便单测）。
 * 模板和快捷操作的 id 是内部标识，不该让用户操心：这里按名字自动生成。
 */
import type { ProjectFieldDef, ProjectNodeDef, ProjectNodeGroupDef } from "./project-types.js"
import { normalizeFieldDefs } from "./project-templates.js"

export const TEMPLATE_ID_RE = /^[a-z][a-z0-9-]*$/
export const TEMPLATE_NAME_MAX = 30
export const TEMPLATE_DESC_MAX = 200
export const TEMPLATE_FIELDS_MAX = 8
export const ACTION_LABEL_MAX = 20

/** 和聊天里 /p 子命令撞名的词，不能当快捷操作 id */
export const ACTION_ID_RESERVED: readonly string[] = [
  "help", "menu", "ls", "list", "use", "leave", "info", "new", "del", "delete", "rm", "setup", "sync", "ship",
]

function asciiSlug(text: string): string {
  return (text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "")
}

/**
 * 按名字生成一个不重复的 id：名字里的英文数字当 slug；中文名没有 slug，就用「兜底词-序号」。
 * taken 里已有的、reserved 里禁用的都会避开。结果一定符合 TEMPLATE_ID_RE。
 */
export function makeUniqueId(
  label: string,
  taken: Iterable<string>,
  fallback: string,
  reserved: Iterable<string> = [],
): string {
  const used = new Set<string>([...taken, ...reserved])
  let base = asciiSlug(label)
  if (base && !/^[a-z]/.test(base)) base = `${fallback}-${base}`
  if (base && !used.has(base)) return base
  const stem = base || fallback
  for (let i = base ? 2 : 1; i < 1000; i++) {
    const cand = `${stem}-${i}`
    if (!used.has(cand)) return cand
  }
  return `${fallback}-${Date.now().toString(36)}`
}

/** 快捷操作 id 的人工输入校验（高级里手填时用）；没问题返回空串 */
export function actionIdProblem(id: string, takenByOthers: Iterable<string>): string {
  const v = (id ?? "").trim()
  if (!v) return "命令 id 不能为空"
  if (!TEMPLATE_ID_RE.test(v)) return `「${v}」需小写字母开头，只能含小写字母、数字和 -`
  if (ACTION_ID_RESERVED.includes(v)) return `「${v}」是保留命令，换一个`
  for (const t of takenByOthers) if (t === v) return `「${v}」已经被占用了，换一个`
  return ""
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
  workspace: "plain" | "worktree"
  fields: ProjectFieldDef[]
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
  const actionId = makeUniqueId("start", existingActionIds, "action", ACTION_ID_RESERVED)
  const fields = normalizeFieldDefs(d.fields)
  const description = d.description.trim()
  return {
    id: makeUniqueId(d.name, existingGroupIds, "template"),
    name: d.name.trim(),
    workspace: d.workspace,
    ...(description ? { description } : {}),
    ...(fields ? { fields } : {}),
    nodes: [{ id: actionId, label: STARTER_ACTION.label, prompt: STARTER_ACTION.prompt }],
  }
}

/** 把编辑后的草稿合并回已有模板：只动名称、说明、要填的信息，类型和 id、快捷操作、共享空间的跟踪信息都不动 */
export function applyTemplateEdit(g: ProjectNodeGroupDef, d: TemplateDraft): ProjectNodeGroupDef {
  const { description: _d, fields: _f, ...rest } = g
  const description = d.description.trim()
  const fields = normalizeFieldDefs(d.fields)
  return {
    ...rest,
    name: d.name.trim(),
    ...(description ? { description } : {}),
    ...(fields ? { fields } : {}),
  }
}
