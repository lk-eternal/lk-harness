import { useCallback, useEffect, useRef, useState } from "react"
import { addFavorite, removeFavorite, type FavoriteModel } from "../../shared/favorite-models"
import type { ModelChoice, QuickModel } from "../components/chat/model-picker-logic"

/**
 * 模型选择器用的「常用 / 最近」数据：
 * - quickModels = 收藏置顶 + 最近用过（服务端合并好的），决定「常用」一组里有谁；
 * - favorites = 真正收藏的（应用配置里的 favoriteModels），决定每行 ★ 的亮灭。
 */
export function useModelFavorites() {
  const [quickModels, setQuickModels] = useState<QuickModel[]>([])
  const [favorites, setFavorites] = useState<FavoriteModel[]>([])
  const busyRef = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const [quick, cfg] = await Promise.all([window.electronAPI.listQuickModels(), window.electronAPI.getConfig()])
      if (quick.ok) setQuickModels(quick.models)
      setFavorites(cfg.favoriteModels ?? [])
    } catch {
      /* 读不到就保持原样 */
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /** 点 ★：starred = 点之前是不是已收藏。返回失败原因，成功返回 undefined */
  const toggleFavorite = useCallback(async (m: ModelChoice & { label?: string }, starred: boolean): Promise<string | undefined> => {
    if (busyRef.current) return undefined
    busyRef.current = true
    try {
      const cfg = await window.electronAPI.getConfig()
      const current = cfg.favoriteModels ?? []
      if (starred) {
        await window.electronAPI.saveConfig({ favoriteModels: removeFavorite(current, m) })
        // 「常用」= 收藏 ∪ 最近：只删收藏会从「最近」补回来，看起来像取消无效
        await window.electronAPI.forgetQuickModel(m.model, m.modelParams, m.resourceId)
      } else {
        const r = addFavorite(current, m)
        if (!r.ok) return r.error
        await window.electronAPI.saveConfig({ favoriteModels: r.favorites })
      }
      await refresh()
      return undefined
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      busyRef.current = false
    }
  }, [refresh])

  return { quickModels, favorites, refresh, toggleFavorite }
}
