import { describe, expect, it } from "vitest"
import { addFavorite, favoriteKey, isFavorite, removeFavorite, type FavoriteModel } from "../src/shared/favorite-models"

const A: FavoriteModel = { model: "composer-2", modelParams: "", label: "Composer 2", resourceId: "sdk_a" }
const B: FavoriteModel = { model: "gemini-flash", modelParams: '[{"id":"thinking","value":"high"}]', resourceId: "llm_b" }
const LEGACY: FavoriteModel = { model: "old-model", modelParams: "" }

describe("favoriteKey", () => {
  it("模型名、参数、供应商任何一个不同就是不同的模型", () => {
    const base = { model: "m", modelParams: "p", resourceId: "r" }
    expect(favoriteKey(base)).not.toBe(favoriteKey({ ...base, model: "m2" }))
    expect(favoriteKey(base)).not.toBe(favoriteKey({ ...base, modelParams: "p2" }))
    expect(favoriteKey(base)).not.toBe(favoriteKey({ ...base, resourceId: "r2" }))
  })

  it("参数缺省和空串是同一个", () => {
    expect(favoriteKey({ model: "m", resourceId: "r" })).toBe(favoriteKey({ model: "m", modelParams: "", resourceId: "r" }))
  })
})

describe("isFavorite", () => {
  it("按模型 + 参数 + 供应商匹配", () => {
    expect(isFavorite([A, B], { model: "composer-2", resourceId: "sdk_a" })).toBe(true)
    expect(isFavorite([A, B], { model: "composer-2", resourceId: "llm_b" })).toBe(false)
    expect(isFavorite([A, B], { model: "gemini-flash", modelParams: B.modelParams, resourceId: "llm_b" })).toBe(true)
    expect(isFavorite([A, B], { model: "gemini-flash", modelParams: "", resourceId: "llm_b" })).toBe(false)
  })

  it("老条目没有供应商：按传入的当前供应商算归属", () => {
    expect(isFavorite([LEGACY], { model: "old-model", resourceId: "sdk_a" }, "sdk_a")).toBe(true)
    expect(isFavorite([LEGACY], { model: "old-model", resourceId: "sdk_a" }, "llm_b")).toBe(false)
    expect(isFavorite([LEGACY], { model: "old-model", resourceId: "sdk_a" })).toBe(false)
  })

  it("要查的模型自己没带供应商：也按传入的当前供应商算", () => {
    const bound: FavoriteModel = { model: "composer-2", resourceId: "sdk_a" }
    expect(isFavorite([bound], { model: "composer-2" }, "sdk_a")).toBe(true)
    expect(isFavorite([bound], { model: "composer-2" }, "llm_b")).toBe(false)
    expect(isFavorite([bound], { model: "composer-2" })).toBe(false)
  })
})

describe("addFavorite", () => {
  it("加到末尾，补上展示名，不改原数组", () => {
    const favs = [A]
    const r = addFavorite(favs, { model: "gemini-flash", modelParams: B.modelParams, resourceId: "llm_b" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.favorites).toHaveLength(2)
      expect(r.favorites[1]).toMatchObject({ model: "gemini-flash", resourceId: "llm_b", label: "gemini-flash-high" })
    }
    expect(favs).toHaveLength(1)
  })

  it("给了展示名就用给的", () => {
    const r = addFavorite([], { model: "m", resourceId: "r", label: "我的模型" })
    expect(r.ok && r.favorites[0].label).toBe("我的模型")
  })

  it("没有供应商不能收藏（不然无法判断属于哪家）", () => {
    const r = addFavorite([], { model: "m" })
    expect(r).toEqual({ ok: false, error: "该模型未绑定供应商，请从供应商模型列表里重选" })
  })

  it("已经收藏了：报错且不重复加", () => {
    const r = addFavorite([A], { model: "composer-2", modelParams: "", resourceId: "sdk_a" })
    expect(r).toEqual({ ok: false, error: "该模型已在常用列表中" })
  })

  it("同一个模型名在另一家供应商下可以单独收藏", () => {
    const r = addFavorite([A], { model: "composer-2", resourceId: "llm_b" })
    expect(r.ok && r.favorites).toHaveLength(2)
  })

  it("模型名为空白不能收藏", () => {
    expect(addFavorite([], { model: "  ", resourceId: "r" }).ok).toBe(false)
  })
})

describe("removeFavorite", () => {
  it("只去掉同模型、同参数、同供应商的那一条", () => {
    const out = removeFavorite([A, B], { model: "composer-2", modelParams: "", resourceId: "sdk_a" })
    expect(out).toEqual([B])
  })

  it("别家供应商下的同名模型不受影响", () => {
    const same: FavoriteModel = { ...A, resourceId: "llm_b" }
    expect(removeFavorite([A, same], { model: "composer-2", resourceId: "sdk_a" })).toEqual([same])
  })

  it("参数不同的同名模型不受影响", () => {
    const hi: FavoriteModel = { ...A, modelParams: '[{"id":"thinking","value":"high"}]' }
    expect(removeFavorite([A, hi], { model: "composer-2", modelParams: "", resourceId: "sdk_a" })).toEqual([hi])
  })

  it("老条目（没有供应商）同模型同参数也一并去掉", () => {
    expect(removeFavorite([LEGACY, A], { model: "old-model", resourceId: "sdk_a" })).toEqual([A])
  })

  it("没收藏过的：原样返回内容", () => {
    expect(removeFavorite([A], { model: "nope", resourceId: "sdk_a" })).toEqual([A])
  })
})
