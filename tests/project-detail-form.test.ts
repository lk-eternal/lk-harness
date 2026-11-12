import { describe, expect, it } from "vitest"
import type { ProjectListItem } from "../src/shared/project-app-types.js"
import {
  INFO_KEY_MAX, composeMetadata, fieldsForSelection, linkFieldsShown, newInfoRow, retargetInfo, sameIdList, splitInfo,
} from "../src/shared/project-detail-form.js"
import { DEFAULT_NODE_GROUPS, type ProjectFieldDef, type ProjectNodeGroupDef } from "../src/shared/project-types.js"

const f = (label: string, extra: Partial<ProjectFieldDef> = {}): ProjectFieldDef => ({ label, ...extra }) as ProjectFieldDef
const FIELDS = [f("汇报对象"), f("汇报周期")]
const rows = (form: { extra: { key: string; value: string }[] }) => form.extra.map((r) => [r.key, r.value])

describe("splitInfo（项目资料 → 表单）", () => {
  it("模板声明的字段各占一项（没填就是空串），没声明的放进其他信息", () => {
    const form = splitInfo(FIELDS, { 汇报对象: "老板", 临时备注: "别忘了" })
    expect(form.values).toEqual({ 汇报对象: "老板", 汇报周期: "" })
    expect(rows(form)).toEqual([["临时备注", "别忘了"]])
  })

  it("没有任何资料、没有任何字段：都是空的，不抛错", () => {
    expect(splitInfo([], undefined)).toEqual({ values: {}, extra: [] })
    expect(splitInfo(FIELDS, undefined).values).toEqual({ 汇报对象: "", 汇报周期: "" })
  })

  it("其他信息每行有各自的 id（改名字时不丢焦点）", () => {
    const form = splitInfo([], { a: "1", b: "2" })
    expect(new Set(form.extra.map((r) => r.id)).size).toBe(2)
  })
})

describe("retargetInfo（换模板后重新分配）", () => {
  it("新模板的字段沿用旧值；同名的其他信息一行并入字段；旧模板独有且有内容的挪进其他信息", () => {
    const form = splitInfo(FIELDS, { 汇报对象: "老板", 交付形式: "PPT" })
    const next = retargetInfo(form, [f("交付形式"), f("汇报对象")])
    expect(next.values).toEqual({ 交付形式: "PPT", 汇报对象: "老板" })
    expect(next.extra).toEqual([])

    const dropped = retargetInfo(splitInfo(FIELDS, { 汇报对象: "老板", 汇报周期: "每周五" }), [f("交付形式")])
    expect(dropped.values).toEqual({ 交付形式: "" })
    expect(rows(dropped)).toEqual([["汇报对象", "老板"], ["汇报周期", "每周五"]])
  })

  it("旧模板独有但没填的字段直接消失，不留空行", () => {
    const next = retargetInfo(splitInfo(FIELDS, {}), [f("交付形式")])
    expect(next.extra).toEqual([])
  })

  it("切过去再切回来：填过的值都还在", () => {
    const form = splitInfo(FIELDS, { 汇报对象: "老板", 汇报周期: "每周五" })
    const away = retargetInfo(form, [f("交付形式")])
    const back = retargetInfo(away, FIELDS)
    expect(back.values).toEqual({ 汇报对象: "老板", 汇报周期: "每周五" })
    expect(back.extra).toEqual([])
  })

  it("不改传进来的表单", () => {
    const form = splitInfo(FIELDS, { 汇报对象: "老板", 临时: "x" })
    const snapshot = JSON.stringify(form)
    retargetInfo(form, [f("交付形式")])
    expect(JSON.stringify(form)).toBe(snapshot)
  })
})

describe("composeMetadata（表单 → 要存的资料）", () => {
  it("模板字段在前、其他信息在后，去首尾空白，空值不存", () => {
    const form = splitInfo(FIELDS, {})
    form.values["汇报对象"] = "  老板  "
    form.extra.push(newInfoRow("  备注 ", " 别忘了 "), newInfoRow("", ""), newInfoRow("空值", "   "))
    const r = composeMetadata(FIELDS, form)
    expect(r).toEqual({ ok: true, metadata: { 汇报对象: "老板", 备注: "别忘了" } })
    expect(r.ok && Object.keys(r.metadata)).toEqual(["汇报对象", "备注"])
  })

  it("只填了内容没填名称：报错，指出是哪条", () => {
    const form = splitInfo([], {})
    form.extra.push(newInfoRow("", "孤零零的内容"))
    const r = composeMetadata([], form)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("孤零零的内容")
  })

  it("其他信息的名称不能和模板字段、别的行重名", () => {
    const a = splitInfo(FIELDS, {})
    a.extra.push(newInfoRow("汇报对象", "x"))
    expect(composeMetadata(FIELDS, a)).toMatchObject({ ok: false })
    const b = splitInfo([], {})
    b.extra.push(newInfoRow("备注", "1"), newInfoRow(" 备注", "2"))
    const r = composeMetadata([], b)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("重复")
  })

  it("名称过长、内容过长都拦下", () => {
    const longKey = splitInfo([], {})
    longKey.extra.push(newInfoRow("名".repeat(INFO_KEY_MAX + 1), "x"))
    expect(composeMetadata([], longKey).ok).toBe(false)
    const longValue = splitInfo(FIELDS, {})
    longValue.values["汇报对象"] = "x".repeat(2001)
    const r = composeMetadata(FIELDS, longValue)
    expect(r.ok).toBe(false)
  })

  it("往返不丢：splitInfo → composeMetadata 得到同样的资料", () => {
    const meta = { 汇报对象: "老板", 临时: "x", 另一项: "y" }
    expect(composeMetadata(FIELDS, splitInfo(FIELDS, meta))).toEqual({ ok: true, metadata: meta })
  })
})

describe("fieldsForSelection（详情页现在展示哪些字段）", () => {
  const globals: ProjectNodeGroupDef[] = structuredClone(DEFAULT_NODE_GROUPS)
  const item = { groupIds: ["general"], fields: [] as ProjectFieldDef[] }

  it("模板没换：用项目自己在用的字段（项目有自己的副本时以副本为准）", () => {
    const own = [f("副本里的字段")]
    expect(fieldsForSelection({ groupIds: ["research"], fields: own }, ["research"], globals)).toBe(own)
  })

  it("换了模板（还没保存）：马上按所选模板算，通用任务没有字段，调研有", () => {
    expect(fieldsForSelection(item, ["research"], globals).map((x) => x.label)).toContain("交付形式")
    expect(fieldsForSelection({ groupIds: ["research"], fields: [f("x")] }, ["general"], globals)).toEqual([])
  })

  it("多选：字段合并；选了全局里没有的模板 id：忽略它", () => {
    const both = fieldsForSelection(item, ["research", "report"], globals).map((x) => x.label)
    expect(both).toContain("交付形式")
    expect(both).toContain("汇报对象")
    expect(fieldsForSelection(item, ["ghost"], globals)).toEqual([])
  })

  it("sameIdList：顺序也算", () => {
    expect(sameIdList(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameIdList(["a", "b"], ["b", "a"])).toBe(false)
    expect(sameIdList(["a"], ["a", "b"])).toBe(false)
    expect(sameIdList([], [])).toBe(true)
  })
})

describe("linkFieldsShown（哪些链接输入框要出现）", () => {
  const saved = (extra: Partial<ProjectListItem> = {}) => ({ isCode: false, ...extra }) as Parameters<typeof linkFieldsShown>[0]

  it("通用项目什么链接都没有：一个输入框都不出现", () => {
    expect(linkFieldsShown(saved())).toEqual([])
    expect(linkFieldsShown(saved({ storyUrl: "   " }))).toEqual([])
  })

  it("研发项目：项目链接和相关文档一直在（建项时问过），产品/技术文档没内容就不在", () => {
    expect(linkFieldsShown(saved({ isCode: true }))).toEqual(["storyUrl", "relatedDocs"])
  })

  it("有内容的老字段都要出现，才能看、能改", () => {
    expect(linkFieldsShown(saved({ storyUrl: "https://x", productDocUrl: "https://p", techDocUrl: "https://t", relatedDocs: "文档" })))
      .toEqual(["storyUrl", "relatedDocs", "productDocUrl", "techDocUrl"])
    expect(linkFieldsShown(saved({ techDocUrl: "https://t" }))).toEqual(["techDocUrl"])
  })
})
