import { describe, expect, it } from "vitest"
import {
  GENERAL_NODE_GROUPS,
  cloneGroupPlain,
  fieldValuesToMetadata,
  mergeGroupFields,
  missingRequiredFields,
  normalizeFieldDefs,
  snapshotGroups,
} from "../src/shared/project-templates.js"
import {
  DEFAULT_NODE_GROUPS,
  PROJECT_RESERVED_SUBCOMMANDS,
  type ProjectNodeGroupDef,
} from "../src/shared/project-types.js"
import { ACTION_GUIDES } from "../src/shared/project-node-guides.js"

describe("通用模板数据", () => {
  it("所有默认流程组的节点 id 全局唯一，也不撞 /p 保留子命令", () => {
    const ids = DEFAULT_NODE_GROUPS.flatMap((g) => g.nodes.map((n) => n.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(PROJECT_RESERVED_SUBCOMMANDS).not.toContain(id)
  })

  it("模板 id 唯一，且都是 plain 工作区、有说明、有步骤", () => {
    const ids = DEFAULT_NODE_GROUPS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const g of GENERAL_NODE_GROUPS) {
      expect(g.workspace, g.id).toBe("plain")
      expect(g.description?.trim(), g.id).toBeTruthy()
      expect(g.nodes.length, g.id).toBeGreaterThanOrEqual(3)
    }
  })

  it("通用模板每个步骤都有自己的提示词（不会掉进「完成 xx 工作」的兜底）", () => {
    for (const g of GENERAL_NODE_GROUPS) {
      for (const n of g.nodes) {
        expect(ACTION_GUIDES[n.id]?.length, `${g.id}/${n.id}`).toBeGreaterThan(2)
      }
    }
  })

  it("通用模板的提示词和字段说明里不出现 git / 飞书 / GitLab 等研发工具措辞", () => {
    const banned = /git|分支|\bMR\b|合并请求|飞书|lark|meegle|GitLab|feature|worktree|commit/i
    for (const g of GENERAL_NODE_GROUPS) {
      const texts = [
        g.name,
        g.description ?? "",
        ...(g.fields ?? []).flatMap((f) => [f.label, f.placeholder ?? ""]),
        ...g.nodes.flatMap((n) => [n.label, ...(ACTION_GUIDES[n.id] ?? [])]),
      ]
      for (const t of texts) expect(t, `${g.id}: ${t}`).not.toMatch(banned)
    }
  })

  it("字段名在模板内不重复（值按名字存 metadata）", () => {
    for (const g of GENERAL_NODE_GROUPS) {
      const labels = (g.fields ?? []).map((f) => f.label)
      expect(new Set(labels).size, g.id).toBe(labels.length)
    }
  })
})

describe("字段与副本工具", () => {
  const fields = [
    { label: "交付形式", required: true },
    { label: "截止时间" },
    { label: "备注", multiline: true },
  ]

  it("fieldValuesToMetadata：只收声明过的字段，去空白，空值不写", () => {
    expect(fieldValuesToMetadata(fields, {
      交付形式: "  PPT  ",
      截止时间: "   ",
      备注: "",
      没声明过: "x",
    })).toEqual({ 交付形式: "PPT" })
    expect(fieldValuesToMetadata(undefined, { a: "b" })).toEqual({})
    expect(fieldValuesToMetadata(fields, { 交付形式: 123 as unknown as string })).toEqual({})
  })

  it("missingRequiredFields：只报没填的必填项", () => {
    expect(missingRequiredFields(fields, {})).toEqual(["交付形式"])
    expect(missingRequiredFields(fields, { 交付形式: "  " })).toEqual(["交付形式"])
    expect(missingRequiredFields(fields, { 交付形式: "PPT" })).toEqual([])
    expect(missingRequiredFields(undefined, {})).toEqual([])
  })

  it("normalizeFieldDefs：去无名、去重、只留合法属性", () => {
    expect(normalizeFieldDefs("nope")).toBeUndefined()
    expect(normalizeFieldDefs([{ label: " " }])).toBeUndefined()
    expect(normalizeFieldDefs([
      { label: " 对象 ", placeholder: " 给谁 ", multiline: true, required: true },
      { label: "对象" },
      { label: "时间", multiline: false, required: false },
    ])).toEqual([
      { label: "对象", placeholder: "给谁", multiline: true, required: true },
      { label: "时间" },
    ])
  })

  it("mergeGroupFields：多个模板的字段按顺序合并、同名只留第一个", () => {
    const a: ProjectNodeGroupDef = { id: "a", name: "A", nodes: [], fields: [{ label: "对象" }, { label: "时间" }] }
    const b: ProjectNodeGroupDef = { id: "b", name: "B", nodes: [], fields: [{ label: "时间", required: true }, { label: "预算" }] }
    expect(mergeGroupFields([a, b]).map((f) => f.label)).toEqual(["对象", "时间", "预算"])
    expect(mergeGroupFields([a, b])[1].required).toBeUndefined()
  })

  it("snapshotGroups：深拷贝，不带中心库跟踪字段，只固化用户改过的提示词", () => {
    const src: ProjectNodeGroupDef = {
      id: "g", name: "G", workspace: "plain", description: "d",
      hubId: "h1", hubRevision: 3, hubContentHash: "x", localRevision: 1,
      fields: [{ label: "对象" }],
      nodes: [
        { id: "n1", label: "一", prompt: "自己写的要求", hubId: "nh", hubRevision: 1 },
        { id: "n2", label: "二", prompt: "   " },
        { id: "n3", label: "三" },
      ],
    }
    const [snap] = snapshotGroups([src])
    expect(snap).toEqual({
      id: "g", name: "G", workspace: "plain", description: "d",
      fields: [{ label: "对象" }],
      nodes: [
        { id: "n1", label: "一", prompt: "自己写的要求" },
        { id: "n2", label: "二" },
        { id: "n3", label: "三" },
      ],
    })
    // 副本和原件互不影响
    snap.nodes[0].label = "改了"
    snap.fields![0].label = "改了"
    expect(src.nodes[0].label).toBe("一")
    expect(src.fields![0].label).toBe("对象")
  })

  it("cloneGroupPlain 复制出来的默认组不和常量共用引用", () => {
    const c = cloneGroupPlain(GENERAL_NODE_GROUPS[1])
    c.fields![0].label = "被改"
    c.nodes[0].label = "被改"
    expect(GENERAL_NODE_GROUPS[1].fields![0].label).not.toBe("被改")
    expect(GENERAL_NODE_GROUPS[1].nodes[0].label).not.toBe("被改")
  })
})
