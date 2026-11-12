// ── 设置页「项目详情」表单的纯逻辑（不依赖 node / react，方便单测） ─────────────────
// 详情页展示什么由项目所用的模板决定：模板要填的信息逐项展示，别的信息放进「其他信息」，
// 老项目留下的链接字段只在有内容（或研发项目）时才出现，不再给每个项目都摆一排用不上的输入框。

import { PROJECT_TEXT_MAX, type ProjectListItem } from "./project-app-types.js"
import { mergeGroupFields } from "./project-templates.js"
import type { ProjectFieldDef, ProjectNodeGroupDef } from "./project-types.js"

export const INFO_KEY_MAX = 40

/** 「其他信息」里的一行；id 只用来稳定地标识这一行（改名字时不丢焦点） */
export interface InfoRow {
  id: number
  key: string
  value: string
}

export interface InfoForm {
  /** 模板要填的信息的值，键是字段名 */
  values: Record<string, string>
  /** 模板没声明的其他信息：AI 补充的、老模板留下的、用户自己加的 */
  extra: InfoRow[]
}

let rowSeq = 0
export function newInfoRow(key = "", value = ""): InfoRow {
  rowSeq += 1
  return { id: rowSeq, key, value }
}

/** 项目的 metadata → 表单：声明过的字段取值，其余原样放进其他信息 */
export function splitInfo(fields: readonly ProjectFieldDef[], metadata: Readonly<Record<string, string>> | undefined): InfoForm {
  const labels = new Set(fields.map((f) => f.label))
  const values: Record<string, string> = {}
  for (const f of fields) values[f.label] = metadata?.[f.label] ?? ""
  const extra = Object.entries(metadata ?? {})
    .filter(([k]) => !labels.has(k))
    .map(([k, v]) => newInfoRow(k, String(v ?? "")))
  return { values, extra }
}

/**
 * 换模板后重新分配：新模板声明的字段从旧的值（或其他信息里同名的一行）里取，
 * 旧模板有、新模板没有的字段，有内容就挪进其他信息，已经填的东西不会因为换模板丢掉。
 */
export function retargetInfo(form: InfoForm, nextFields: readonly ProjectFieldDef[]): InfoForm {
  const nextLabels = new Set(nextFields.map((f) => f.label))
  const extra = form.extra.map((r) => ({ ...r }))
  const values: Record<string, string> = {}
  for (const f of nextFields) {
    const own = form.values[f.label]
    if (own !== undefined && own !== "") {
      values[f.label] = own
      continue
    }
    const at = extra.findIndex((r) => r.key.trim() === f.label)
    if (at >= 0) {
      values[f.label] = extra[at].value
      extra.splice(at, 1)
    } else {
      values[f.label] = ""
    }
  }
  const demoted = Object.entries(form.values)
    .filter(([k, v]) => !nextLabels.has(k) && v.trim() !== "")
    .map(([k, v]) => newInfoRow(k, v))
  return { values, extra: [...extra, ...demoted] }
}

export type ComposeResult =
  | { ok: true; metadata: Record<string, string> }
  | { ok: false; error: string }

/**
 * 表单 → 要存的 metadata：模板字段在前、其他信息在后，去首尾空白，空值不存。
 * 其他信息里的名字不能和模板字段、别的行重名（值按名字存，重名会互相覆盖）。
 */
export function composeMetadata(fields: readonly ProjectFieldDef[], form: InfoForm): ComposeResult {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = (form.values[f.label] ?? "").trim()
    if (!v) continue
    if (v.length > PROJECT_TEXT_MAX) return { ok: false, error: `「${f.label}」不要超过 ${PROJECT_TEXT_MAX} 个字` }
    out[f.label] = v
  }
  const declared = new Set(fields.map((f) => f.label))
  const seen = new Set<string>()
  for (const r of form.extra) {
    const key = r.key.trim()
    const value = r.value.trim()
    if (!key && !value) continue
    if (!key) return { ok: false, error: `「其他信息」里有一项只填了内容，没有填名称：${value.slice(0, 20)}` }
    if (!value) continue
    if (key.length > INFO_KEY_MAX) return { ok: false, error: `名称「${key.slice(0, 12)}…」太长了，不要超过 ${INFO_KEY_MAX} 个字` }
    if (declared.has(key)) return { ok: false, error: `「${key}」已经是上面单独的一项了，直接填在那里` }
    if (seen.has(key)) return { ok: false, error: `「其他信息」里「${key}」重复了，每一项要有不同的名称` }
    if (value.length > PROJECT_TEXT_MAX) return { ok: false, error: `「${key}」不要超过 ${PROJECT_TEXT_MAX} 个字` }
    seen.add(key)
    out[key] = value
  }
  return { ok: true, metadata: out }
}

/** 选中的模板 id 和项目现在用的是不是同一组（不看顺序以外的东西：顺序也算，首个模板决定主模板） */
export function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * 详情页现在应该展示哪些「模板要填的信息」：模板没换就用项目自己在用的；换了（还没保存）就按所选模板算。
 */
export function fieldsForSelection(
  item: Pick<ProjectListItem, "groupIds" | "fields">,
  selectedIds: readonly string[],
  globals: readonly ProjectNodeGroupDef[],
): ProjectFieldDef[] {
  if (sameIdList(selectedIds, item.groupIds)) return item.fields
  const picked = selectedIds
    .map((id) => globals.find((g) => g.id === id))
    .filter((g): g is ProjectNodeGroupDef => !!g)
  return mergeGroupFields(picked)
}

/** 项目链接类的老字段 */
export type LinkKey = "storyUrl" | "relatedDocs" | "productDocUrl" | "techDocUrl"

export const LINK_FIELDS: { key: LinkKey; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: "storyUrl", label: "项目链接", placeholder: "需求、任务单、参考资料等入口链接" },
  { key: "relatedDocs", label: "相关文档", placeholder: "文档链接或说明，多个换行写", multiline: true },
  { key: "productDocUrl", label: "产品文档", placeholder: "产品文档链接" },
  { key: "techDocUrl", label: "技术文档", placeholder: "技术文档链接" },
]

/**
 * 要展示哪些链接类字段：研发项目建项时就问过「项目链接」「相关文档」，所以一直展示；
 * 其它项目只有已经有内容才展示（老数据要能看、能改），产品 / 技术文档是更老的字段，同理。
 * 按已保存的资料判断，用户在输入框里把内容删光也不会让输入框当场消失。
 */
export function linkFieldsShown(
  saved: Pick<ProjectListItem, "isCode" | "storyUrl" | "relatedDocs" | "productDocUrl" | "techDocUrl">,
): LinkKey[] {
  const has = (k: LinkKey) => !!saved[k]?.trim()
  const shown: LinkKey[] = []
  if (saved.isCode || has("storyUrl")) shown.push("storyUrl")
  if (saved.isCode || has("relatedDocs")) shown.push("relatedDocs")
  if (has("productDocUrl")) shown.push("productDocUrl")
  if (has("techDocUrl")) shown.push("techDocUrl")
  return shown
}
