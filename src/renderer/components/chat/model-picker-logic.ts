import { isFavorite, type FavoriteModel } from "../../../shared/favorite-models"
import { modelSlug, resolveModelLabel } from "../../model-utils"

/** 通道默认模型的哨兵值：SDK 落到 composer-2，LLM 落到供应商默认模型；供应商的模型列表里没有它，要单独给一行 */
export const AUTO_MODEL = "auto"

export interface QuickModel { model: string; modelParams?: string; label?: string; resourceId?: string }

/** 选中的结果。resourceId 为空串 = 「跟随」（设置页的其他人跟随主用户的供应商） */
export interface ModelChoice { model: string; modelParams?: string; resourceId: string }

export interface ProviderModel { id: string; label: string; params: string }

/** 左列的一项：真实供应商，或顶部的「跟随」占位项（id 为空串） */
export interface ProviderEntry { id: string; name: string; follow: boolean }

export function buildProviderEntries(resources: { id: string; name?: string }[], followLabel?: string): ProviderEntry[] {
  const list = resources.map((r) => ({ id: r.id, name: r.name || r.id, follow: false }))
  return followLabel ? [{ id: "", name: followLabel, follow: true }, ...list] : list
}

/** 右列列出哪个供应商的模型：「跟随」项列的是它所跟随的那一家（可能还没选，此时 undefined） */
export function listedResourceId(entry: ProviderEntry | undefined, followResourceId?: string): string | undefined {
  if (!entry) return undefined
  return entry.follow ? (followResourceId || undefined) : entry.id
}

/** 「跟随主模型」只在模型来自同一家供应商时成立：选了「跟随」项，或明确选的就是被跟随的那一家 */
export function followModelAllowed(entry: ProviderEntry | undefined, followResourceId?: string): boolean {
  if (!entry) return false
  return entry.follow || (!!followResourceId && entry.id === followResourceId)
}

export interface PickerRow {
  /** React key，也是去重依据 */
  key: string
  kind: "follow" | "auto" | "favorite" | "model" | "manual"
  model: string
  params: string
  label: string
  /** 能不能收藏（跟随 / 自动 / 手输的不能） */
  starrable: boolean
  starred: boolean
}

export interface BuiltRows {
  /** 顶部的特殊项：跟随主模型、自动 */
  head: PickerRow[]
  /** 常用（含最近用过） */
  favorites: PickerRow[]
  /** 全部模型（不含已在常用里的） */
  others: PickerRow[]
  /** 手输项：开了手输、搜索框里有字、而且列表里没有这个模型名 */
  manual?: PickerRow
  /** 列表已加载、有搜索词，但什么也没匹配到 */
  noMatch: boolean
}

export interface BuildRowsInput {
  /** 当前列出的供应商的模型；还在加载或加载失败时传 undefined */
  listed?: ProviderModel[]
  /** 当前列出的供应商 id；没有就不能收藏 */
  listedResourceId?: string
  quickModels: QuickModel[]
  favorites: FavoriteModel[]
  /** 常用里没带供应商的老条目算谁的：当前生效的那一家（不是右列正在看的那一家） */
  fallbackResourceId?: string
  query: string
  followModelLabel?: string
  autoLabel?: string
  allowManual?: boolean
}

const modelKey = (id: string, params: string | undefined) => `${id}\0${params ?? ""}`

/** 右列要显示的行 */
export function buildRows(input: BuildRowsInput): BuiltRows {
  const { listed, listedResourceId: listedId, quickModels, favorites, fallbackResourceId, followModelLabel, autoLabel, allowManual } = input
  const needle = input.query.trim().toLowerCase()
  const matches = (id: string, label: string) => !needle || id.toLowerCase().includes(needle) || label.toLowerCase().includes(needle)
  const starred = (model: string, params: string) => !!listedId && isFavorite(favorites, { model, modelParams: params, resourceId: listedId }, fallbackResourceId)

  const head: PickerRow[] = []
  if (!needle) {
    if (followModelLabel) head.push({ key: "head:follow", kind: "follow", model: "", params: "", label: followModelLabel, starrable: false, starred: false })
    if (autoLabel) head.push({ key: "head:auto", kind: "auto", model: AUTO_MODEL, params: "", label: autoLabel, starrable: false, starred: false })
  }

  const favRows: PickerRow[] = quickModels
    .filter((m) => listedId !== undefined && (m.resourceId ?? fallbackResourceId) === listedId)
    .filter((m) => matches(m.model, m.label || modelSlug(m.model, m.modelParams)))
    .map((m) => ({
      key: `fav:${modelKey(m.model, m.modelParams)}`,
      kind: "favorite" as const,
      model: m.model,
      params: m.modelParams ?? "",
      label: m.label || modelSlug(m.model, m.modelParams),
      starrable: !!listedId,
      starred: starred(m.model, m.modelParams ?? ""),
    }))
  const favKeys = new Set(favRows.map((r) => modelKey(r.model, r.params)))

  const others: PickerRow[] = (listed ?? [])
    .filter((m) => !favKeys.has(modelKey(m.id, m.params)) && matches(m.id, m.label))
    .map((m) => ({
      key: `all:${modelKey(m.id, m.params)}`,
      kind: "model" as const,
      model: m.id,
      params: m.params,
      label: m.label,
      starrable: !!listedId,
      starred: starred(m.id, m.params),
    }))

  const typed = input.query.trim()
  const known = [...quickModels.map((m) => m.model), ...(listed ?? []).map((m) => m.id)]
    .some((id) => id.toLowerCase() === typed.toLowerCase())
  const manual: PickerRow | undefined = allowManual && typed && !known
    ? { key: "manual", kind: "manual", model: typed, params: "", label: `使用「${typed}」`, starrable: false, starred: false }
    : undefined

  return {
    head,
    favorites: favRows,
    others,
    manual,
    noMatch: !!listed && needle !== "" && favRows.length === 0 && others.length === 0 && !manual,
  }
}

/** 点中一行得到的选择；row 为跟随项时模型为空串。entry 是左列当前展示的那一项 */
export function choiceForRow(row: PickerRow, entry: ProviderEntry): ModelChoice {
  return { model: row.model, ...(row.params ? { modelParams: row.params } : {}), resourceId: entry.id }
}

/** 收藏 / 取消收藏一行时用的模型标识，供应商取右列实际列出的那一家（「跟随」项下也是真实供应商） */
export function favoriteChoiceForRow(row: PickerRow, listedId: string): ModelChoice & { label: string } {
  return { model: row.model, ...(row.params ? { modelParams: row.params } : {}), resourceId: listedId, label: row.label }
}

export interface CurrentValue {
  resourceId?: string
  model?: string
  params?: string
}

/** 这一行是不是当前值。供应商是否也对得上由调用方先判断（只有展示的就是当前供应商那一列才算） */
export function isCurrentRow(row: PickerRow, current: CurrentValue): boolean {
  if (row.kind === "follow") return !current.model
  if (!current.model) return false
  return row.model === current.model && row.params === (current.params ?? "")
}

export interface TriggerText {
  /** 供应商名；没选或跟随时是对应的文案 */
  provider?: string
  /** 模型显示名 */
  model: string
  /** 什么都还没选：显示占位文案 */
  empty: boolean
}

/** 触发按钮上显示的文字 */
export function triggerText(input: {
  entries: ProviderEntry[]
  current: CurrentValue
  /** 外部给定的模型显示名（对话页用会话 tab 里的名字） */
  currentLabel?: string
  followResourceId?: string
  followModelLabel?: string
  autoLabel?: string
  /** 锁定供应商时不在按钮上显示供应商名 */
  hideProvider?: boolean
  placeholder: string
}): TriggerText {
  const { entries, current, followResourceId, followModelLabel, autoLabel } = input
  const entry = entries.find((e) => e.id === (current.resourceId ?? ""))
  const provider = input.hideProvider ? undefined : entry?.name
  const model = current.model?.trim()
  if (!model) {
    if (followModelLabel && followModelAllowed(entry, followResourceId)) return { provider, model: followModelLabel, empty: false }
    return { provider, model: input.placeholder, empty: true }
  }
  if (model === AUTO_MODEL && autoLabel) return { provider, model: autoLabel, empty: false }
  return { provider, model: input.currentLabel || resolveModelLabel(model, current.params), empty: false }
}

export interface PanelPosition {
  left: number
  /** 向下展开：面板顶边距视口顶部 */
  top?: number
  /** 向上展开：面板底边距视口底部 */
  bottom?: number
  /** 面板实际高度：空间不够时比 panel.height 小 */
  height: number
}

/**
 * 面板（挂在 body 上、fixed 定位）放在触发按钮的哪一侧。
 * 先按期望的方向放；放不下而另一侧空间更大就翻到另一侧；两边都放不下取大的一侧并压缩高度。左边缘不超出视口。
 */
export function computePanelPosition(input: {
  trigger: { left: number; top: number; bottom: number }
  viewport: { width: number; height: number }
  panel: { width: number; height: number }
  placement: "up" | "down"
  gap?: number
  margin?: number
}): PanelPosition {
  const { trigger, viewport, panel, placement } = input
  const gap = input.gap ?? 6
  const margin = input.margin ?? 8
  const below = viewport.height - trigger.bottom - margin - gap
  const above = trigger.top - margin - gap
  const preferred = placement === "down" ? below : above
  const other = placement === "down" ? above : below
  const flip = preferred < panel.height && other > preferred
  const down = (placement === "down") !== flip
  const room = Math.max(0, down ? below : above)
  const left = Math.max(margin, Math.min(trigger.left, viewport.width - panel.width - margin))
  const height = Math.min(panel.height, room)
  return down
    ? { left, top: trigger.bottom + gap, height }
    : { left, bottom: viewport.height - trigger.top + gap, height }
}
