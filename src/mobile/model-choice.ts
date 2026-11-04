import { modelSlug } from "../renderer/model-utils"

/**
 * 手机端「切换对话模型」抽屉的判断规则，和桌面端 ModelPicker（model-picker-logic）同一口径：
 * 同一个模型 id 在供应商那里常有好几档推理参数（variants），每一档是单独的一行，
 * 靠 params（JSON 字符串）区分——只比模型 id 的话，同模型的几档会被一起当成「当前」，点哪一档也选不对。
 */

export interface ModelCurrent {
  model?: string
  params?: string
  resourceId?: string
}

/** 供应商返回的一行：id 相同、params 不同的几行是同一个模型的不同档位。没有 params（如 LLM 类供应商）等同于空 */
export interface ProviderModelRow {
  id: string
  label?: string
  params?: string
}

/** 常用模型里的一项（服务端合并好的收藏 + 最近用过） */
export interface QuickModelRef {
  model: string
  modelParams?: string
  label?: string
  resourceId?: string
}

export interface ModelChoice {
  model: string
  modelParams?: string
  resourceId?: string
}

const norm = (p?: string): string => (p ?? "").trim()

/** 常用卡片是不是当前值：模型和推理参数都一样；卡片绑了供应商的，供应商也要对得上 */
export function isCurrentQuick(qm: QuickModelRef, cur: ModelCurrent): boolean {
  if (!cur.model || qm.model !== cur.model) return false
  if (norm(qm.modelParams) !== norm(cur.params)) return false
  return !qm.resourceId || qm.resourceId === cur.resourceId
}

/**
 * 供应商模型列表里的一行是不是当前值：模型和推理参数都一样。
 * 展示的是不是当前供应商那一列由调用方先判断（只有当前供应商那一列才算）。
 */
export function isCurrentListed(row: ProviderModelRow, cur: ModelCurrent): boolean {
  if (!cur.model) return false
  return row.id === cur.model && norm(row.params) === norm(cur.params)
}

/** 点常用卡片得到的选择 */
export function choiceForQuick(qm: QuickModelRef): ModelChoice {
  return { model: qm.model, modelParams: qm.modelParams, resourceId: qm.resourceId }
}

/** 点列表里一行得到的选择：推理参数要带上，不带的话点「xxx-low」选中的是不带参数的默认档 */
export function choiceForListed(row: ProviderModelRow, resourceId: string): ModelChoice {
  const params = norm(row.params)
  return { model: row.id, ...(params ? { modelParams: row.params } : {}), resourceId }
}

/**
 * 抽屉里当前该高亮、该拉模型列表的供应商。
 * 用户自己选的那家只要还在列表里就保持不动：手机端每 10 秒刷新一次，每次都换一个新的供应商数组，
 * 不能因为数组换了就把人从正在看的供应商拉回会话当前的那家。
 * 没选过、或选的那家已被删：回落到会话当前的供应商，再回落到第一家；一家都没有返回空串。
 */
export function resolveProviderId(
  selected: string,
  resources: readonly { id: string }[],
  currentResourceId?: string,
): string {
  const has = (id?: string): id is string => !!id && resources.some((r) => r.id === id)
  if (has(selected)) return selected
  if (has(currentResourceId)) return currentResourceId
  return resources[0]?.id ?? ""
}

/** 列表里一行的 React key：同一个 id 有好几档，光用 id 会重复 */
export function listedRowKey(row: ProviderModelRow): string {
  return `${row.id}\0${norm(row.params)}`
}

/** 顶栏上显示的模型名：同模型同参数的常用项的名字，没有就按模型 + 参数拼 */
export function currentModelLabel(
  model: string | undefined,
  params: string | undefined,
  quickModels: readonly QuickModelRef[],
): string {
  if (!model || model === "auto") return "默认模型"
  const hit = quickModels.find((q) => q.model === model && norm(q.modelParams) === norm(params) && q.label)
  return hit?.label || modelSlug(model, params)
}
