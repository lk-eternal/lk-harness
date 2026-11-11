import { describe, expect, it } from "vitest"
import {
  ACTION_ID_RESERVED, TEMPLATE_FIELDS_MAX, TEMPLATE_ID_RE, TEMPLATE_NAME_MAX,
  actionIdProblem, applyTemplateEdit, buildNewTemplate, makeUniqueId, templateDraftProblem, templateFieldsProblem,
  type TemplateDraft,
} from "../src/shared/project-template-edit"
import { DEFAULT_NODE_GROUPS, type ProjectNodeGroupDef } from "../src/shared/project-types"
import { planProjectCreate } from "../src/shared/project-create-plan"

describe("makeUniqueId", () => {
  it("英文数字名字：转成小写 slug，重名自动加序号", () => {
    expect(makeUniqueId("Design Review", [], "action")).toBe("design-review")
    expect(makeUniqueId("Design Review", ["design-review"], "action")).toBe("design-review-2")
    expect(makeUniqueId("Design Review", ["design-review", "design-review-2"], "action")).toBe("design-review-3")
  })

  it("中文名字没有 slug：用「兜底词-序号」，序号从 1 开始并避开已占用的", () => {
    expect(makeUniqueId("测试报告", [], "action")).toBe("action-1")
    expect(makeUniqueId("测试报告", ["action-1", "action-2"], "action")).toBe("action-3")
    expect(makeUniqueId("", [], "template")).toBe("template-1")
  })

  it("中英混合取其中的英文数字；数字开头补兜底前缀，保证以字母开头", () => {
    expect(makeUniqueId("Q4 调研", [], "template")).toBe("q4")
    expect(makeUniqueId("v2 方案", [], "action")).toBe("v2")
    expect(makeUniqueId("2024 计划", [], "action")).toBe("action-2024")
  })

  it("避开保留命令（它们占着 /p 子命令）", () => {
    expect(makeUniqueId("list", [], "action", ACTION_ID_RESERVED)).toBe("list-2")
    expect(makeUniqueId("Help", [], "action", ACTION_ID_RESERVED)).toBe("help-2")
  })

  it("生成的 id 永远合法，包括很长的名字和满是符号的名字", () => {
    for (const label of ["a".repeat(100), "!!!", "---", "  ", "😀", "A_B C/D", "9"]) {
      const id = makeUniqueId(label, [], "action", ACTION_ID_RESERVED)
      expect(TEMPLATE_ID_RE.test(id), `「${label}」→「${id}」`).toBe(true)
      expect(id.length).toBeLessThanOrEqual(40)
    }
  })
})

describe("actionIdProblem", () => {
  it("合法的通过；空、非法字符、保留词、重复各给一句人话", () => {
    expect(actionIdProblem("test-report", ["other"])).toBe("")
    expect(actionIdProblem("  ", [])).toContain("不能为空")
    expect(actionIdProblem("Test", [])).toContain("小写字母开头")
    expect(actionIdProblem("1abc", [])).toContain("小写字母开头")
    expect(actionIdProblem("help", [])).toContain("保留")
    expect(actionIdProblem("plan", ["plan"])).toContain("占用")
  })
})

describe("模板草稿校验", () => {
  const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({ name: "调研", description: "", workspace: "plain", fields: [], ...over })

  it("名称必填、不超长、不和别的模板重名", () => {
    expect(templateDraftProblem(draft())).toBe("")
    expect(templateDraftProblem(draft({ name: "  " }))).toContain("名称")
    expect(templateDraftProblem(draft({ name: "x".repeat(TEMPLATE_NAME_MAX + 1) }))).toContain("不要超过")
    expect(templateDraftProblem(draft({ name: " 开发 " }), ["开发", "测试"])).toContain("已经有叫「开发」")
    expect(templateDraftProblem(draft({ name: "新的" }), ["开发"])).toBe("")
  })

  it("要填的信息：重名、超过上限会被拦下；空名字的行不算错（保存时丢掉）", () => {
    expect(templateFieldsProblem([{ label: "预算" }, { label: " 预算 " }])).toContain("重复")
    expect(templateFieldsProblem([{ label: "预算" }, { label: "" }, { label: "  " }])).toBe("")
    const many = Array.from({ length: TEMPLATE_FIELDS_MAX + 1 }, (_, i) => ({ label: `项${i}` }))
    expect(templateFieldsProblem(many)).toContain("最多")
    expect(templateFieldsProblem(many.slice(0, TEMPLATE_FIELDS_MAX))).toBe("")
    expect(templateDraftProblem(draft({ fields: [{ label: "a" }, { label: "a" }] }))).toContain("重复")
  })
})

describe("buildNewTemplate / applyTemplateEdit", () => {
  const existing: ProjectNodeGroupDef[] = DEFAULT_NODE_GROUPS

  it("新模板：id 自动生成、不和已有的撞；自带一个起步快捷操作，所以马上就能用来建项目", () => {
    const g = buildNewTemplate(
      { name: "客户拜访", description: " 拜访前后要做的事 ", workspace: "plain", fields: [{ label: "客户", required: true }, { label: "" }] },
      existing.map((x) => x.id), existing.flatMap((x) => x.nodes.map((n) => n.id)),
    )
    expect(TEMPLATE_ID_RE.test(g.id)).toBe(true)
    expect(existing.some((x) => x.id === g.id)).toBe(false)
    expect(g).toMatchObject({ name: "客户拜访", workspace: "plain", description: "拜访前后要做的事" })
    expect(g.fields).toEqual([{ label: "客户", required: true }])
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].label).toBe("开始")
    expect(g.nodes[0].prompt?.length).toBeGreaterThan(10)

    const plan = planProjectCreate({ name: "拜访 A 公司", templateId: g.id, fields: { 客户: "A 公司" } }, [...existing, g])
    expect(plan.ok).toBe(true)
  })

  it("研发类新模板：建项时要求接代码仓库", () => {
    const g = buildNewTemplate({ name: "后端", description: "", workspace: "worktree", fields: [] }, [], [])
    expect(g.workspace).toBe("worktree")
    expect(g.description).toBeUndefined()
    expect(g.fields).toBeUndefined()
    const plan = planProjectCreate({ name: "x", templateId: g.id }, [g])
    expect(plan.ok).toBe(false)
  })

  it("两次建同名模板：id 不同；起步快捷操作 id 也避开已有的", () => {
    const a = buildNewTemplate({ name: "Research", description: "", workspace: "plain", fields: [] }, [], [])
    const b = buildNewTemplate({ name: "Research", description: "", workspace: "plain", fields: [] }, [a.id], a.nodes.map((n) => n.id))
    expect(a.id).not.toBe(b.id)
    expect(b.nodes[0].id).not.toBe(a.nodes[0].id)
  })

  it("编辑已有模板：只改名称、说明、要填的信息；类型、id、快捷操作、共享空间跟踪信息原样保留；清空说明和字段会真的清掉", () => {
    const g: ProjectNodeGroupDef = {
      id: "design", name: "设计", workspace: "worktree", description: "旧说明", fields: [{ label: "旧字段" }],
      hubId: "h1", hubRevision: 3, nodes: [{ id: "a", label: "A", prompt: "p" }],
    }
    const edited = applyTemplateEdit(g, { name: " 设计2 ", description: "新说明", workspace: "plain", fields: [{ label: "新字段" }] })
    expect(edited).toEqual({
      id: "design", name: "设计2", workspace: "worktree", description: "新说明", fields: [{ label: "新字段" }],
      hubId: "h1", hubRevision: 3, nodes: [{ id: "a", label: "A", prompt: "p" }],
    })
    const cleared = applyTemplateEdit(g, { name: "设计", description: "  ", workspace: "worktree", fields: [] })
    expect("description" in cleared).toBe(false)
    expect("fields" in cleared).toBe(false)
    expect(g.description).toBe("旧说明")
  })
})
