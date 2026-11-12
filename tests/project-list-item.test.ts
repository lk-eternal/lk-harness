import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { buildProjectListItem, changeProjectGroups, templateUsage } from "../src/shared/project-create-plan.js"
import { snapshotGroups } from "../src/shared/project-templates.js"
import { DEFAULT_NODE_GROUPS, DEFAULT_NODE_GROUP_ID, type Project, type ProjectNodeGroupDef } from "../src/shared/project-types.js"

const globals = (): ProjectNodeGroupDef[] => structuredClone(DEFAULT_NODE_GROUPS)
const pick = (...ids: string[]) => globals().filter((g) => ids.includes(g.id))
const base = path.resolve(path.sep, "work", "p1")

const project = (extra: Partial<Project> = {}): Project => ({
  id: "abc123def456", name: "周报", goal: "每周五出报告", repoPath: "", baseBranch: "", featureBranch: "",
  worktreePath: path.join(base, "workspace"), workspaceType: "plain",
  groupIds: ["general"], groupId: "general", createdAt: 1, updatedAt: 2, ...extra,
})

describe("buildProjectListItem（设置页项目详情的数据）", () => {
  it("字段取自项目实际在用的模板：通用任务没有要填的信息，调研有", () => {
    const general = buildProjectListItem(project(), { groups: pick("general"), globals: globals() })
    expect(general.fields).toEqual([])
    const research = buildProjectListItem(project({ groupIds: ["research"], groupId: "research" }), { groups: pick("research"), globals: globals() })
    expect(research.fields.map((f) => f.label)).toContain("交付形式")
  })

  it("多个模板：字段合并、快捷操作按 id 去重，模板名和 id 按顺序给出", () => {
    const item = buildProjectListItem(project({ groupIds: ["general", "report"] }), { groups: pick("general", "report"), globals: globals() })
    expect(item.groupIds).toEqual(["general", "report"])
    expect(item.groupNames).toEqual(["通用任务", "周报月报"])
    expect(item.groupId).toBe("general")
    const ids = item.actions.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("draft-report")
    expect(item.fields.map((f) => f.label)).toContain("汇报对象")
  })

  it("项目里填过的资料原样带出（包括模板里没有的），不会被字段表过滤掉", () => {
    const item = buildProjectListItem(
      project({ metadata: { 汇报对象: "老板", 临时备注: "别忘了" } }),
      { groups: pick("report"), globals: globals() },
    )
    expect(item.metadata).toEqual({ 汇报对象: "老板", 临时备注: "别忘了" })
  })

  it("链接字段没填就不带出来；填了才带（详情页据此决定显示不显示）", () => {
    const empty = buildProjectListItem(project(), { groups: pick("general"), globals: globals() })
    for (const k of ["storyUrl", "relatedDocs", "productDocUrl", "techDocUrl"] as const) expect(empty).not.toHaveProperty(k)
    const filled = buildProjectListItem(project({ storyUrl: "https://x", techDocUrl: "https://t" }), { groups: pick("general"), globals: globals() })
    expect(filled.storyUrl).toBe("https://x")
    expect(filled.techDocUrl).toBe("https://t")
    expect(filled).not.toHaveProperty("productDocUrl")
  })

  it("普通项目 isCode 为 false，带代码仓库的为 true；目录是项目根目录", () => {
    expect(buildProjectListItem(project(), { groups: pick("general"), globals: globals() }).isCode).toBe(false)
    const dev = buildProjectListItem(project({ workspaceType: undefined, repoPath: "/r", featureBranch: "feature/x" }), { groups: pick("develop"), globals: globals() })
    expect(dev.isCode).toBe(true)
    expect(dev.featureBranch).toBe("feature/x")
    expect(dev.repoPaths).toEqual(["/r"])
    expect(buildProjectListItem(project(), { groups: pick("general"), globals: globals() }).dir).toBe(base)
  })

  it("能不能同步模板：有副本且和全局不同才行", () => {
    const snap = snapshotGroups(pick("report"))
    const changed = globals().map((g) => g.id === "report" ? { ...g, name: "周报月报（新）" } : g)
    const p = project({ groupSnapshot: snap, groupIds: ["report"], groupId: "report" })
    expect(buildProjectListItem(p, { groups: snap, globals: changed }).canSyncSteps).toBe(true)
    expect(buildProjectListItem(p, { groups: snap, globals: globals() }).canSyncSteps).toBe(false)
    expect(buildProjectListItem(p, { groups: snap, globals: globals() }).hasGroupSnapshot).toBe(true)
    // 没副本：永远没有可同步的
    expect(buildProjectListItem(project(), { groups: pick("general"), globals: changed }).canSyncSteps).toBe(false)
  })

  it("有归档时间才是已归档；没有任何「进行中 / 已暂停」这类状态字段", () => {
    const opts = { groups: pick("general"), globals: globals() }
    const live = buildProjectListItem(project(), opts)
    expect(live.archived).toBe(false)
    expect(live).not.toHaveProperty("status")
    expect(buildProjectListItem(project({ archivedAt: 1700000000000 }), opts).archived).toBe(true)
  })
})

describe("changeProjectGroups（改项目的模板）", () => {
  it("模板没变（界面把当前模板原样传回来）：不算改动，也不碰项目的快捷操作副本", () => {
    const snap = snapshotGroups(pick("report"))
    snap[0].nodes[0].prompt = "项目里单独改过的"
    const r = changeProjectGroups({ groupIds: ["report"], groupId: "report", groupSnapshot: snap }, ["report"], globals())
    expect(r).toMatchObject({ ok: true, groupIds: ["report"], groupId: "report", changed: false })
    expect(r.ok && r.groupSnapshot).toBeUndefined()
  })

  it("没记模板的老项目：当前算作默认模板，传回默认模板不算改动，换成别的才算", () => {
    const r = changeProjectGroups({ groupSnapshot: snapshotGroups(pick("general")) }, ["general"], globals())
    expect(r).toMatchObject({ ok: true, changed: false })
    const noSnap = changeProjectGroups({}, [DEFAULT_NODE_GROUP_ID], globals())
    expect(noSnap).toMatchObject({ ok: true, changed: false, groupIds: [DEFAULT_NODE_GROUP_ID] })
    expect(changeProjectGroups({}, ["general"], globals())).toMatchObject({ ok: true, changed: true, groupIds: ["general"] })
  })

  it("换了模板且项目有副本：按新选的模板重新复制；没副本就只改 id", () => {
    const snap = snapshotGroups(pick("general"))
    const withSnap = changeProjectGroups({ groupIds: ["general"], groupId: "general", groupSnapshot: snap }, ["report", "general"], globals())
    expect(withSnap).toMatchObject({ ok: true, changed: true, groupIds: ["report", "general"], groupId: "report" })
    expect(withSnap.ok && withSnap.groupSnapshot?.map((g) => g.id)).toEqual(["report", "general"])
    const without = changeProjectGroups({ groupIds: ["general"], groupId: "general" }, ["research"], globals())
    expect(without).toMatchObject({ ok: true, changed: true, groupIds: ["research"] })
    expect(without.ok && without.groupSnapshot).toBeUndefined()
  })

  it("只是调换了模板顺序也算改动（第一个是主模板）", () => {
    const r = changeProjectGroups({ groupIds: ["general", "report"], groupId: "general" }, ["report", "general"], globals())
    expect(r).toMatchObject({ ok: true, changed: true, groupId: "report" })
  })

  it("不存在的模板：报错，不静默忽略", () => {
    const r = changeProjectGroups({ groupIds: ["general"], groupId: "general" }, ["general", "ghost"], globals())
    expect(r).toEqual({ ok: false, error: "项目模板不存在：ghost" })
  })

  it("重复的 id 去重；空列表回落默认模板", () => {
    const dup = changeProjectGroups({}, ["report", "report"], globals())
    expect(dup).toMatchObject({ ok: true, groupIds: ["report"] })
    const empty = changeProjectGroups({ groupIds: ["report"], groupId: "report" }, [], globals())
    expect(empty).toMatchObject({ ok: true, groupIds: [DEFAULT_NODE_GROUP_ID], groupId: DEFAULT_NODE_GROUP_ID, changed: true })
  })
})

describe("templateUsage（删模板前看有多少项目还依赖它）", () => {
  const snap = snapshotGroups(pick("report"))

  it("有自己快捷操作副本的项目不算在用：删模板、改模板都影响不到它", () => {
    expect(templateUsage([project({ groupSnapshot: snap, groupIds: ["report"], groupId: "report" })])).toEqual({})
  })

  it("没有副本的项目算在它绑的模板头上；绑了几个模板，每个都算一次", () => {
    const usage = templateUsage([
      project({ groupIds: ["report"], groupId: "report" }),
      project({ groupIds: ["report", "general"], groupId: "report" }),
      project({ groupIds: ["general"], groupId: "general" }),
    ])
    expect(usage).toEqual({ report: 2, general: 2 })
  })

  it("只记了 groupId 的老项目照样算；什么都没记的算在默认模板头上", () => {
    expect(templateUsage([project({ groupIds: undefined, groupId: "research" })])).toEqual({ research: 1 })
    expect(templateUsage([project({ groupIds: undefined, groupId: undefined })])).toEqual({ [DEFAULT_NODE_GROUP_ID]: 1 })
  })

  it("同一个模板在一个项目里重复写，只算一次；没有项目就是空表", () => {
    expect(templateUsage([project({ groupIds: ["report", "report"], groupId: "report" })])).toEqual({ report: 1 })
    expect(templateUsage([])).toEqual({})
  })
})
