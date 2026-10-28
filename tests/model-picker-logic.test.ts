import { describe, expect, it } from "vitest"
import {
  AUTO_MODEL,
  buildProviderEntries,
  buildRows,
  choiceForRow,
  computePanelPosition,
  favoriteChoiceForRow,
  followModelAllowed,
  isCurrentRow,
  listedResourceId,
  triggerText,
  type PickerRow,
  type ProviderModel,
  type QuickModel,
} from "../src/renderer/components/chat/model-picker-logic"
import type { FavoriteModel } from "../src/shared/favorite-models"

const RES = [
  { id: "sdk_main", name: "Cursor 主账号" },
  { id: "llm_b", name: "" },
]

const LISTED: ProviderModel[] = [
  { id: "composer-2", label: "Composer 2", params: "" },
  { id: "gpt-5", label: "GPT-5", params: "" },
  { id: "gpt-5", label: "GPT-5 High", params: '[{"id":"reasoning","value":"high"}]' },
]

const base = { listed: LISTED, listedResourceId: "sdk_main", quickModels: [] as QuickModel[], favorites: [] as FavoriteModel[], query: "" }
const keys = (rows: PickerRow[]) => rows.map((r) => `${r.model}|${r.params}`)

describe("buildProviderEntries / listedResourceId / followModelAllowed", () => {
  it("没有「跟随」时就是供应商列表，没有名字用 id", () => {
    expect(buildProviderEntries(RES)).toEqual([
      { id: "sdk_main", name: "Cursor 主账号", follow: false },
      { id: "llm_b", name: "llm_b", follow: false },
    ])
  })

  it("有「跟随」时它排在最前面，id 是空串", () => {
    const e = buildProviderEntries(RES, "跟随主用户")
    expect(e[0]).toEqual({ id: "", name: "跟随主用户", follow: true })
    expect(e).toHaveLength(3)
  })

  it("「跟随」项右列列的是它跟随的那家供应商；没选供应商时没有", () => {
    const [follow, sdk] = buildProviderEntries(RES, "跟随主用户")
    expect(listedResourceId(follow, "sdk_main")).toBe("sdk_main")
    expect(listedResourceId(follow, "")).toBeUndefined()
    expect(listedResourceId(follow, undefined)).toBeUndefined()
    expect(listedResourceId(sdk, "llm_b")).toBe("sdk_main")
    expect(listedResourceId(undefined, "sdk_main")).toBeUndefined()
  })

  it("「跟随主模型」只在跟随项、或明确选的就是被跟随的那家时成立", () => {
    const [follow, sdk, llm] = buildProviderEntries(RES, "跟随主用户")
    expect(followModelAllowed(follow, "sdk_main")).toBe(true)
    expect(followModelAllowed(sdk, "sdk_main")).toBe(true)
    expect(followModelAllowed(llm, "sdk_main")).toBe(false)
    // 主用户还没选供应商：具体供应商都谈不上「同一家」
    expect(followModelAllowed(sdk, undefined)).toBe(false)
    expect(followModelAllowed(sdk, "")).toBe(false)
    expect(followModelAllowed(undefined, "sdk_main")).toBe(false)
  })
})

describe("buildRows", () => {
  it("没有常用时：全部模型按列表顺序，推理参数不同的算不同的行", () => {
    const r = buildRows(base)
    expect(r.head).toEqual([])
    expect(r.favorites).toEqual([])
    expect(keys(r.others)).toEqual(["composer-2|", "gpt-5|", 'gpt-5|[{"id":"reasoning","value":"high"}]'])
    expect(r.noMatch).toBe(false)
  })

  it("常用在前，并且不在「全部模型」里重复出现", () => {
    const quick: QuickModel[] = [{ model: "gpt-5", modelParams: "", label: "GPT-5", resourceId: "sdk_main" }]
    const r = buildRows({ ...base, quickModels: quick })
    expect(keys(r.favorites)).toEqual(["gpt-5|"])
    expect(keys(r.others)).toEqual(["composer-2|", 'gpt-5|[{"id":"reasoning","value":"high"}]'])
  })

  it("常用只显示属于当前列出的供应商的", () => {
    const quick: QuickModel[] = [
      { model: "gpt-5", resourceId: "sdk_main" },
      { model: "other-model", resourceId: "llm_b" },
    ]
    expect(keys(buildRows({ ...base, quickModels: quick }).favorites)).toEqual(["gpt-5|"])
  })

  it("常用里没带供应商的条目，算 fallback 供应商的", () => {
    const quick: QuickModel[] = [{ model: "old-model" }]
    expect(keys(buildRows({ ...base, quickModels: quick, fallbackResourceId: "sdk_main" }).favorites)).toEqual(["old-model|"])
    expect(buildRows({ ...base, quickModels: quick, fallbackResourceId: "llm_b" }).favorites).toEqual([])
  })

  it("没有列出具体供应商时（「跟随」项但主用户还没选）：没带供应商的老条目也不会冒出来", () => {
    const quick: QuickModel[] = [{ model: "old-model" }]
    expect(buildRows({ ...base, listedResourceId: undefined, fallbackResourceId: undefined, quickModels: quick }).favorites).toEqual([])
  })

  it("常用的展示名：给了用给的，没给用模型名 + 参数拼出来的", () => {
    const quick: QuickModel[] = [
      { model: "gpt-5", modelParams: '[{"id":"reasoning","value":"high"}]', resourceId: "sdk_main" },
      { model: "composer-2", label: "我的 Composer", resourceId: "sdk_main" },
    ]
    const labels = buildRows({ ...base, quickModels: quick }).favorites.map((r) => r.label)
    expect(labels).toEqual(["gpt-5-high", "我的 Composer"])
  })

  it("搜索：模型 id 或展示名包含即可，大小写不敏感；顶部的特殊项搜索时不显示", () => {
    const r = buildRows({ ...base, query: " GPT ", followModelLabel: "跟随主模型", autoLabel: "自动" })
    expect(keys(r.others)).toEqual(["gpt-5|", 'gpt-5|[{"id":"reasoning","value":"high"}]'])
    expect(r.head).toEqual([])
    // 按展示名（Composer 2）和按模型 id（composer-2）都能搜到，不同的词搜不到
    expect(buildRows({ ...base, query: "COMPOSER 2" }).others.map((o) => o.model)).toEqual(["composer-2"])
    expect(buildRows({ ...base, query: "composer-2" }).others.map((o) => o.model)).toEqual(["composer-2"])
    expect(buildRows({ ...base, query: "composer 3" }).others.map((o) => o.model)).toEqual([])
  })

  it("搜索也过滤常用", () => {
    const quick: QuickModel[] = [{ model: "gpt-5", resourceId: "sdk_main" }, { model: "composer-2", resourceId: "sdk_main" }]
    expect(keys(buildRows({ ...base, quickModels: quick, query: "composer" }).favorites)).toEqual(["composer-2|"])
  })

  it("顶部特殊项：跟随主模型（模型为空串）、自动（auto）", () => {
    const r = buildRows({ ...base, followModelLabel: "跟随主模型", autoLabel: "自动（auto）" })
    expect(r.head.map((h) => [h.kind, h.model, h.label])).toEqual([
      ["follow", "", "跟随主模型"],
      ["auto", AUTO_MODEL, "自动（auto）"],
    ])
    expect(r.head.every((h) => !h.starrable)).toBe(true)
  })

  it("还在加载或失败（listed 为 undefined）：没有「全部模型」，也不算没匹配", () => {
    const r = buildRows({ ...base, listed: undefined, query: "zzz" })
    expect(r.others).toEqual([])
    expect(r.noMatch).toBe(false)
  })

  it("列表已加载、搜索什么也没匹配：noMatch", () => {
    expect(buildRows({ ...base, query: "zzz" }).noMatch).toBe(true)
  })

  it("供应商本来就没有模型、也没搜索：不是「没匹配」", () => {
    expect(buildRows({ ...base, listed: [], query: "" }).noMatch).toBe(false)
  })

  it("收藏标记：已收藏的行 starred；未收藏的不是；跟着供应商走", () => {
    const favs: FavoriteModel[] = [{ model: "gpt-5", modelParams: "", resourceId: "sdk_main" }]
    const r = buildRows({ ...base, favorites: favs })
    const byKey = Object.fromEntries(r.others.map((o) => [`${o.model}|${o.params}`, o.starred]))
    expect(byKey["gpt-5|"]).toBe(true)
    expect(byKey["composer-2|"]).toBe(false)
    expect(byKey['gpt-5|[{"id":"reasoning","value":"high"}]']).toBe(false)
    // 同名模型在另一家供应商下收藏过，不影响这家
    expect(buildRows({ ...base, listedResourceId: "llm_b", favorites: favs }).others.find((o) => o.model === "gpt-5" && !o.params)?.starred).toBe(false)
  })

  it("收藏标记：没带供应商的老收藏，按当前生效的供应商算归属", () => {
    const legacy: FavoriteModel[] = [{ model: "gpt-5" }]
    const onCurrent = buildRows({ ...base, favorites: legacy, fallbackResourceId: "sdk_main" })
    expect(onCurrent.others.find((o) => o.model === "gpt-5" && !o.params)?.starred).toBe(true)
    const onOther = buildRows({ ...base, favorites: legacy, fallbackResourceId: "llm_b" })
    expect(onOther.others.find((o) => o.model === "gpt-5" && !o.params)?.starred).toBe(false)
  })

  it("常用里的行：来自「最近用过」但没收藏的不是 starred", () => {
    const quick: QuickModel[] = [{ model: "gpt-5", resourceId: "sdk_main" }]
    expect(buildRows({ ...base, quickModels: quick }).favorites[0].starred).toBe(false)
    const favs: FavoriteModel[] = [{ model: "gpt-5", resourceId: "sdk_main" }]
    expect(buildRows({ ...base, quickModels: quick, favorites: favs }).favorites[0].starred).toBe(true)
  })

  it("没有列出具体供应商（「跟随」项但主用户还没选）：不能收藏", () => {
    const r = buildRows({ ...base, listedResourceId: undefined })
    expect(r.others.every((o) => !o.starrable)).toBe(true)
  })

  it("手输：开了手输、搜索框有字、列表里没有这个名字，才多一行「使用「xxx」」", () => {
    const r = buildRows({ ...base, query: "  my-custom  ", allowManual: true })
    expect(r.manual).toMatchObject({ kind: "manual", model: "my-custom", params: "", label: "使用「my-custom」", starrable: false })
    expect(r.noMatch).toBe(false)
    expect(buildRows({ ...base, query: "my-custom" }).manual).toBeUndefined()
    expect(buildRows({ ...base, query: "GPT-5", allowManual: true }).manual).toBeUndefined()
    expect(buildRows({ ...base, query: "", allowManual: true }).manual).toBeUndefined()
  })

  it("手输：列表还没加载出来（失败）时照样能输", () => {
    expect(buildRows({ ...base, listed: undefined, query: "abc", allowManual: true }).manual?.model).toBe("abc")
  })

  it("手输：模型名正好是常用里的，不再重复给一行", () => {
    const quick: QuickModel[] = [{ model: "mine", resourceId: "sdk_main" }]
    expect(buildRows({ ...base, quickModels: quick, query: "mine", allowManual: true }).manual).toBeUndefined()
  })
})

describe("choiceForRow / favoriteChoiceForRow", () => {
  const [follow, sdk] = buildProviderEntries(RES, "跟随主用户")
  const row = (p: Partial<PickerRow>): PickerRow => ({ key: "k", kind: "model", model: "gpt-5", params: "", label: "GPT-5", starrable: true, starred: false, ...p })

  it("选中的供应商取左列当前展示的那一项；参数为空时不带 modelParams", () => {
    expect(choiceForRow(row({}), sdk)).toEqual({ model: "gpt-5", resourceId: "sdk_main" })
    expect(choiceForRow(row({ params: "[1]" }), sdk)).toEqual({ model: "gpt-5", modelParams: "[1]", resourceId: "sdk_main" })
  })

  it("在「跟随」项下选模型：供应商为空串（继续跟随），模型是选的那个", () => {
    expect(choiceForRow(row({}), follow)).toEqual({ model: "gpt-5", resourceId: "" })
  })

  it("「跟随主模型」：供应商和模型都是空串", () => {
    expect(choiceForRow(row({ kind: "follow", model: "" }), follow)).toEqual({ model: "", resourceId: "" })
  })

  it("收藏用的是右列实际列出的供应商，「跟随」项下也是真实的那一家", () => {
    expect(favoriteChoiceForRow(row({ params: "[1]" }), "sdk_main")).toEqual({
      model: "gpt-5",
      modelParams: "[1]",
      resourceId: "sdk_main",
      label: "GPT-5",
    })
  })
})

describe("isCurrentRow", () => {
  const row = (p: Partial<PickerRow>): PickerRow => ({ key: "k", kind: "model", model: "gpt-5", params: "", label: "x", starrable: true, starred: false, ...p })

  it("模型名和参数都一样才是当前", () => {
    expect(isCurrentRow(row({}), { model: "gpt-5", params: "" })).toBe(true)
    expect(isCurrentRow(row({}), { model: "gpt-5" })).toBe(true)
    expect(isCurrentRow(row({ params: "[1]" }), { model: "gpt-5", params: "" })).toBe(false)
    expect(isCurrentRow(row({}), { model: "gpt-4" })).toBe(false)
  })

  it("当前没有模型：只有「跟随」行是当前", () => {
    expect(isCurrentRow(row({ kind: "follow", model: "" }), { model: "" })).toBe(true)
    expect(isCurrentRow(row({ kind: "follow", model: "" }), {})).toBe(true)
    expect(isCurrentRow(row({}), { model: "" })).toBe(false)
    expect(isCurrentRow(row({ kind: "follow", model: "" }), { model: "gpt-5" })).toBe(false)
  })

  it("自动行：当前模型是 auto 时是当前", () => {
    expect(isCurrentRow(row({ kind: "auto", model: AUTO_MODEL }), { model: "auto" })).toBe(true)
  })
})

describe("computePanelPosition", () => {
  const panel = { width: 464, height: 320 }
  const viewport = { width: 1200, height: 800 }
  const at = (top: number, left = 100) => ({ left, top, bottom: top + 34 })

  it("向下：下面放得下就放下面，顶边贴着按钮底边加间距", () => {
    expect(computePanelPosition({ trigger: at(100), viewport, panel, placement: "down" }))
      .toEqual({ left: 100, top: 140, height: 320 })
  })

  it("向上：上面放得下就放上面，底边贴着按钮顶边加间距", () => {
    expect(computePanelPosition({ trigger: at(500), viewport, panel, placement: "up" }))
      .toEqual({ left: 100, bottom: 800 - 500 + 6, height: 320 })
  })

  it("向下放不下、上面空间更大：翻到上面", () => {
    const p = computePanelPosition({ trigger: at(650), viewport, panel, placement: "down" })
    expect(p.top).toBeUndefined()
    expect(p.bottom).toBe(800 - 650 + 6)
    expect(p.height).toBe(320)
  })

  it("向上放不下、下面空间更大：翻到下面", () => {
    const p = computePanelPosition({ trigger: at(50), viewport, panel, placement: "up" })
    expect(p.bottom).toBeUndefined()
    expect(p.top).toBe(50 + 34 + 6)
    expect(p.height).toBe(320)
  })

  it("两边都放不下：取空间大的一侧并压缩高度", () => {
    const small = { width: 1200, height: 400 }
    const p = computePanelPosition({ trigger: at(250), viewport: small, panel, placement: "down" })
    // 上面 250 - 8 - 6 = 236，下面 400 - 284 - 8 - 6 = 102 → 翻到上面，高度 236
    expect(p.bottom).toBe(400 - 250 + 6)
    expect(p.height).toBe(236)
  })

  it("放不下但期望方向的空间仍然更大：留在原方向，压缩高度", () => {
    const small = { width: 1200, height: 400 }
    const p = computePanelPosition({ trigger: at(40), viewport: small, panel, placement: "down" })
    expect(p.top).toBe(80)
    expect(p.height).toBe(400 - 74 - 8 - 6)
  })

  it("左边缘不超出视口右侧，也不小于边距", () => {
    expect(computePanelPosition({ trigger: at(100, 1000), viewport, panel, placement: "down" }).left).toBe(1200 - 464 - 8)
    expect(computePanelPosition({ trigger: at(100, -30), viewport, panel, placement: "down" }).left).toBe(8)
  })

  it("视口比面板还窄：贴着左边距，不出现负数", () => {
    expect(computePanelPosition({ trigger: at(100, 50), viewport: { width: 300, height: 800 }, panel, placement: "down" }).left).toBe(8)
  })

  it("没有任何空间：高度为 0，不是负数", () => {
    const p = computePanelPosition({ trigger: { left: 0, top: 2, bottom: 790 }, viewport, panel, placement: "down" })
    expect(p.height).toBeGreaterThanOrEqual(0)
  })
})

describe("triggerText", () => {
  const entries = buildProviderEntries(RES, "跟随主用户")
  const common = { entries, followResourceId: "sdk_main", followModelLabel: "跟随主模型", autoLabel: "自动（auto）", placeholder: "选择供应商 / 模型" }

  it("具体供应商 + 具体模型", () => {
    expect(triggerText({ ...common, current: { resourceId: "sdk_main", model: "gpt-5", params: "" } }))
      .toEqual({ provider: "Cursor 主账号", model: "gpt-5", empty: false })
  })

  it("给了模型展示名就用它", () => {
    expect(triggerText({ ...common, current: { resourceId: "sdk_main", model: "gpt-5" }, currentLabel: "GPT-5" }).model).toBe("GPT-5")
  })

  it("模型是 auto：显示「自动」", () => {
    expect(triggerText({ ...common, current: { resourceId: "sdk_main", model: "auto" } }).model).toBe("自动（auto）")
  })

  it("跟随主用户的供应商 + 跟随主模型", () => {
    expect(triggerText({ ...common, current: { resourceId: "", model: "" } }))
      .toEqual({ provider: "跟随主用户", model: "跟随主模型", empty: false })
  })

  it("跟随主用户的供应商 + 具体模型", () => {
    expect(triggerText({ ...common, current: { resourceId: "", model: "gpt-5" } }).provider).toBe("跟随主用户")
  })

  it("选了和主用户不同的供应商但没选模型：这时不能跟随，显示占位", () => {
    expect(triggerText({ ...common, current: { resourceId: "llm_b", model: "" } }))
      .toEqual({ provider: "llm_b", model: "选择供应商 / 模型", empty: true })
  })

  it("明确选了和主用户同一家、没选模型：算跟随主模型", () => {
    expect(triggerText({ ...common, current: { resourceId: "sdk_main", model: "" } }).model).toBe("跟随主模型")
  })

  it("什么都没选：占位", () => {
    expect(triggerText({ entries: buildProviderEntries(RES), current: {}, placeholder: "请选择" }))
      .toEqual({ provider: undefined, model: "请选择", empty: true })
  })

  it("供应商被锁定时不显示供应商名", () => {
    expect(triggerText({ ...common, current: { resourceId: "sdk_main", model: "gpt-5" }, hideProvider: true }).provider).toBeUndefined()
  })

  it("当前供应商不在列表里（已删除）：不显示供应商名，模型照常显示", () => {
    expect(triggerText({ entries: buildProviderEntries(RES), current: { resourceId: "gone", model: "gpt-5" }, placeholder: "x" }))
      .toEqual({ provider: undefined, model: "gpt-5", empty: false })
  })
})
