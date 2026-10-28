import { modelSlug } from "./model-utils.js"

/** 常用模型（存在应用配置的 favoriteModels 里）；resourceId 缺省 = 绑定供应商之前存的老条目 */
export interface FavoriteModel {
  model: string
  modelParams?: string
  label?: string
  resourceId?: string
}

type ModelIdentity = { model: string; modelParams?: string; resourceId?: string }

/** 同一个模型 = 模型名 + 推理参数 + 供应商都一样 */
export function favoriteKey(m: ModelIdentity): string {
  return `${m.model}\0${m.modelParams ?? ""}\0${m.resourceId ?? ""}`
}

/**
 * 是否已收藏。老条目没有 resourceId，按 fallbackResourceId（当前展示的供应商）算它的归属，
 * 和常用列表里「没带供应商的算当前供应商的」是同一个口径。
 */
export function isFavorite(favorites: readonly FavoriteModel[], m: ModelIdentity, fallbackResourceId?: string): boolean {
  const key = favoriteKey({ ...m, resourceId: m.resourceId || fallbackResourceId || "" })
  return favorites.some((f) => favoriteKey({ ...f, resourceId: f.resourceId || fallbackResourceId || "" }) === key)
}

export type AddFavoriteResult = { ok: true; favorites: FavoriteModel[] } | { ok: false; error: string }

/** 加入收藏。必须带供应商（不带的模型无法判断属于哪家，选到别家会串）；已收藏的报「已在常用列表中」 */
export function addFavorite(favorites: readonly FavoriteModel[], m: ModelIdentity & { label?: string }): AddFavoriteResult {
  if (!m.model?.trim()) return { ok: false, error: "模型名不能为空" }
  if (!m.resourceId) return { ok: false, error: "该模型未绑定供应商，请从供应商模型列表里重选" }
  if (isFavorite(favorites, m)) return { ok: false, error: "该模型已在常用列表中" }
  return {
    ok: true,
    favorites: [
      ...favorites,
      {
        model: m.model,
        modelParams: m.modelParams,
        label: m.label || modelSlug(m.model, m.modelParams),
        resourceId: m.resourceId,
      },
    ],
  }
}

/** 取消收藏；绑定供应商之前存的老条目（没有 resourceId）同模型同参数也一并去掉 */
export function removeFavorite(favorites: readonly FavoriteModel[], m: ModelIdentity): FavoriteModel[] {
  return favorites.filter((f) => {
    if (f.model !== m.model || (f.modelParams ?? "") !== (m.modelParams ?? "")) return true
    if (!f.resourceId) return false
    return f.resourceId !== (m.resourceId ?? "")
  })
}
