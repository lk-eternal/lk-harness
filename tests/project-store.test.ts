import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createProject,
  findProjectByGroupChat,
  getCurrentProject,
  getNodeGroups,
  getProject,
  saveProject,
  setProjectArchived,
  getProjectNodes,
  initProjectStore,
  listProjects,
  resolveProjectRef,
  projectNodeLabel,
  resolveNodeGroup,
  parseNodeGroupExport,
  resolveUniqueNodeGroupId,
  saveNodeGroups,
  setCurrentProjectId,
  registerArtifact,
  projectGroupIds,
  projectGroups,
  projectNodes,
  projectNodeOf,
  projectNodeLabelOf,
  mergeProjectMetadata,
} from "../src/shared/project-store.js"
import {
  canEnterProjectFromChat,
  DEFAULT_NEW_PROJECT_GROUP_ID,
  DEFAULT_NODE_GROUP_ID,
  projectGroupChatMatches,
} from "../src/shared/project-types.js"
import { snapshotGroups } from "../src/shared/project-templates.js"

describe("project-store", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-proj-"))
    initProjectStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates project and sets current", () => {
    const p = createProject({
      name: "login",
      goal: "add login",
      repoPath: "D:/repos/foo",
      baseBranch: "main",
      featureBranch: "feature/login",
      worktreePath: "D:/claw/login",
    })
    expect(p.id).toBeTruthy()
    expect(getCurrentProject()?.id).toBe(p.id)
    expect(listProjects()).toHaveLength(1)
  })

  it("registerArtifact writes lastArtifact* and migrates away actions", () => {
    const p = createProject({
      name: "a",
      goal: "g",
      repoPath: "/r",
      baseBranch: "main",
      featureBranch: "f",
      worktreePath: "/w",
    })
    const r = registerArtifact(p.id, {
      artifactPath: ".lk-harness/artifacts/plan.md",
      summary: "规划完成",
      mrUrl: "https://gitlab.example/mr/1",
      feishuDocUrl: "https://feishu.example/doc/1",
    })
    expect(r.ok).toBe(true)
    const got = getProject(p.id)!
    expect(got.lastArtifactPath).toBe(".lk-harness/artifacts/plan.md")
    expect(got.lastArtifactSummary).toBe("规划完成")
    expect(got.lastMrUrl).toBe("https://gitlab.example/mr/1")
    expect(got.lastFeishuDocUrl).toBe("https://feishu.example/doc/1")
    expect(got.lastArtifactAt).toBeTruthy()
    expect(got.actions).toBeUndefined()

    // 存量 actions[] 读入时迁移到 lastArtifact*
    const legacyPath = path.join(dir, "projects", `${p.id}.json`)
    const raw = JSON.parse(fs.readFileSync(legacyPath, "utf-8"))
    raw.actions = [{
      id: "old1",
      type: "build",
      status: "accepted",
      artifactPath: "legacy.md",
      summary: "旧产物",
      startedAt: 1,
      completedAt: 2,
    }]
    delete raw.lastArtifactPath
    delete raw.lastArtifactSummary
    delete raw.lastMrUrl
    delete raw.lastFeishuDocUrl
    delete raw.lastArtifactAt
    fs.writeFileSync(legacyPath, JSON.stringify(raw), "utf-8")
    const migrated = getProject(p.id)!
    expect(migrated.lastArtifactPath).toBe("legacy.md")
    expect(migrated.lastArtifactSummary).toBe("旧产物")
    expect(migrated.actions).toBeUndefined()
  })

  describe("归档（没有「进行中 / 已暂停 / 已完成」状态，做完了就归档或删除）", () => {
    const make = (name: string, groupChatId?: string) => createProject({
      name, goal: "g", repoPath: "/r", baseBranch: "main", featureBranch: "f", worktreePath: "/w",
      ...(groupChatId ? { groupChatId } : {}),
    })
    const fileOf = (id: string) => path.join(dir, "projects", `${id}.json`)
    const rawOf = (id: string) => JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as Record<string, unknown>

    it("新项目没有归档时间，也不带 status", () => {
      const p = make("a")
      expect(p.archivedAt).toBeUndefined()
      expect(rawOf(p.id)).not.toHaveProperty("status")
    })

    it("归档 → 有归档时间；取消归档 → 清掉；已经是想要的状态时原样返回，不改归档时间", async () => {
      const p = make("a")
      const archived = setProjectArchived(p.id, true)!
      expect(archived.archivedAt).toBeGreaterThan(0)
      expect(getProject(p.id)?.archivedAt).toBe(archived.archivedAt)

      await new Promise((r) => setTimeout(r, 5))
      expect(setProjectArchived(p.id, true)?.archivedAt).toBe(archived.archivedAt)

      const back = setProjectArchived(p.id, false)!
      expect(back.archivedAt).toBeUndefined()
      expect(rawOf(p.id)).not.toHaveProperty("archivedAt")
      expect(setProjectArchived(p.id, false)?.archivedAt).toBeUndefined()
    })

    it("项目不存在：返回 undefined", () => {
      expect(setProjectArchived("nope", true)).toBeUndefined()
    })

    it("旧数据 status=done 读出来就是已归档（归档时间取最后更新时间），status 字段不再带出，下次保存后从文件里消失", () => {
      const p = make("old")
      const raw = rawOf(p.id)
      raw.status = "done"
      raw.updatedAt = 1700000000000
      fs.writeFileSync(fileOf(p.id), JSON.stringify(raw), "utf-8")

      const got = getProject(p.id)!
      expect(got.archivedAt).toBe(1700000000000)
      expect(got).not.toHaveProperty("status")
      expect(listProjects().find((x) => x.id === p.id)?.archivedAt).toBe(1700000000000)

      // 取消归档后文件里既没有 archivedAt 也没有 status，不会再被当成已完成读回去
      setProjectArchived(p.id, false)
      expect(rawOf(p.id)).not.toHaveProperty("status")
      expect(getProject(p.id)?.archivedAt).toBeUndefined()
    })

    it("旧数据 status=paused / active：当普通项目，不会变成已归档", () => {
      for (const status of ["paused", "active"]) {
        const p = make(`old-${status}`)
        const raw = rawOf(p.id)
        raw.status = status
        fs.writeFileSync(fileOf(p.id), JSON.stringify(raw), "utf-8")
        const got = getProject(p.id)!
        expect(got.archivedAt).toBeUndefined()
        expect(got).not.toHaveProperty("status")
      }
    })

    it("已归档的项目不再认领飞书群聊（群里的消息不会路由到它）；取消归档后恢复", () => {
      const p = make("grp", "ch_a|oc_grp")
      expect(findProjectByGroupChat("ch_a|oc_grp")?.id).toBe(p.id)
      setProjectArchived(p.id, true)
      expect(findProjectByGroupChat("ch_a|oc_grp")).toBeUndefined()
      setProjectArchived(p.id, false)
      expect(findProjectByGroupChat("ch_a|oc_grp")?.id).toBe(p.id)
    })
  })

  it("switches current project", () => {
    const a = createProject({
      name: "a", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "fa", worktreePath: "/wa",
    })
    const b = createProject({
      name: "b", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "fb", worktreePath: "/wb",
    })
    expect(getCurrentProject()?.id).toBe(b.id)
    setCurrentProjectId(a.id)
    expect(getCurrentProject()?.id).toBe(a.id)
  })

  it("seeds default node groups without ship", () => {
    const groups = getNodeGroups()
    expect(groups.map((g) => g.id)).toEqual(["develop", "test", "general", "research", "writing", "report", "event"])
    const develop = resolveNodeGroup("develop")
    expect(develop.nodes.map((n) => n.id)).toEqual(["plan", "build", "review", "deploy", "mr", "submit-test", "analyze-bug", "fix-bug", "fill-release-doc"])
    expect(develop.workspace).toBe("worktree")
    expect(resolveNodeGroup("test").nodes).toHaveLength(7)
    expect(resolveNodeGroup("test").workspace).toBe("plain")
    expect(develop.nodes.some((n) => n.id === "ship")).toBe(false)
  })

  it("resolves nodes by project group with fallback", () => {
    expect(getProjectNodes("test").map((n) => n.id)).toContain("test-exec")
    // 未知组回落默认组
    expect(getProjectNodes("nonexistent").map((n) => n.id)).toContain("plan")
    // 跨组兜底找 label（历史 action 的节点可能在别的组）
    expect(projectNodeLabel("test-exec", "develop")).toBe("测试")
  })

  it("migrates legacy flat nodes into develop group", () => {
    fs.writeFileSync(path.join(dir, "projects", "project-nodes.json"), JSON.stringify([
      { id: "plan", label: "规划改", prompt: "自定义要求", builtin: true },
      { id: "ship", label: "交付", builtin: true },
      { id: "my-node", label: "自定义节点" },
    ]), "utf-8")
    const develop = resolveNodeGroup(DEFAULT_NODE_GROUP_ID)
    const plan = develop.nodes.find((n) => n.id === "plan")
    expect(plan?.label).toBe("规划改")
    expect(plan?.prompt).toBe("自定义要求")
    expect(develop.nodes.some((n) => n.id === "ship")).toBe(false)
    expect(develop.nodes.some((n) => n.id === "my-node")).toBe(true)
    // 迁移结果已持久化为组文件
    expect(fs.existsSync(path.join(dir, "projects", "project-node-groups.json"))).toBe(true)
  })

  it("saves and roundtrips custom groups", () => {
    saveNodeGroups([
      { id: "develop", name: "开发", nodes: [{ id: "plan", label: "规划" }] },
      { id: "qa", name: "质检", nodes: [{ id: "check", label: "检查", prompt: "查一切" }] },
    ])
    const groups = getNodeGroups()
    expect(groups).toHaveLength(2)
    expect(getProjectNodes("qa").map((n) => n.id)).toEqual(["check"])
    expect(projectNodeLabel("check", "qa")).toBe("检查")
  })

  it("roundtrips hub tracking fields on groups and nodes", () => {
    saveNodeGroups([{
      id: "develop",
      name: "开发",
      hubId: "group-uuid-1",
      hubRevision: 2,
      hubContentHash: "ghash",
      localRevision: 0,
      nodes: [{
        id: "plan",
        label: "规划",
        hubId: "node-uuid-1",
        hubRevision: 1,
        hubContentHash: "nhash",
        localRevision: 1,
      }],
    }])
    const g = resolveNodeGroup("develop")
    expect(g.hubId).toBe("group-uuid-1")
    expect(g.nodes[0].hubId).toBe("node-uuid-1")
    expect(g.nodes[0].localRevision).toBe(1)
  })

  it("parses node group export envelope and loose format", () => {
    const envelope = parseNodeGroupExport({
      kind: "lk-harness-node-group",
      version: 1,
      group: {
        id: "custom",
        name: "自定义",
        workspace: "plain",
        nodes: [{ id: "step", label: "步骤", prompt: "做某事" }],
      },
    })
    expect(envelope).toEqual({
      id: "custom",
      name: "自定义",
      workspace: "plain",
      nodes: [{ id: "step", label: "步骤", prompt: "做某事" }],
    })
    const loose = parseNodeGroupExport({
      id: "loose",
      name: "Loose",
      nodes: [{ id: "a", label: "A" }],
    })
    expect(loose?.id).toBe("loose")
    expect(loose?.workspace).toBe("worktree")
    expect(parseNodeGroupExport({ kind: "other" })).toBeNull()
    expect(parseNodeGroupExport({ id: "x", name: "X" })).toBeNull()
  })

  it("resolves unique node group id without overwriting existing", () => {
    expect(resolveUniqueNodeGroupId("develop", "开发", ["develop", "test"])).toBe("develop-2")
    expect(resolveUniqueNodeGroupId("develop", "开发", ["develop", "develop-2"])).toBe("develop-3")
    expect(resolveUniqueNodeGroupId("BAD", "My Group", ["develop"])).toBe("my-group")
    expect(resolveUniqueNodeGroupId(undefined, "开发", ["develop"])).toMatch(/^import-[a-f0-9]+$/)
  })

  it("stores groupId on created project", () => {
    const p = createProject({
      name: "g", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "fg", worktreePath: "/wg", groupId: "test",
    })
    expect(getProject(p.id)?.groupId).toBe("test")
    expect(getProject(p.id)?.groupIds).toEqual(["test"])
  })

  it("projectGroupIds supports multi-group and fallback", () => {
    expect(projectGroupIds({ groupIds: ["develop", "test", "develop"] })).toEqual(["develop", "test"])
    expect(projectGroupIds({ groupId: "test" })).toEqual(["test"])
    expect(projectGroupIds({ groupIds: ["bad-id"] })).toEqual([DEFAULT_NODE_GROUP_ID])
    expect(projectGroupIds({})).toEqual([DEFAULT_NODE_GROUP_ID])
  })

  it("createProject writes groupIds from multi input", () => {
    const p = createProject({
      name: "multi", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "f", worktreePath: "/w", groupIds: ["develop", "test"],
    })
    expect(p.groupIds).toEqual(["develop", "test"])
    expect(p.groupId).toBe("develop")
  })

  it("findProjectByGroupChat resolves by chatKey or bare chatId", () => {
    const groupKey = "ch_feishu|oc_group123"
    const p = createProject({
      name: "grp-proj", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "f1", worktreePath: "/w1", groupChatId: groupKey,
    })
    expect(findProjectByGroupChat(groupKey)?.id).toBe(p.id)
    expect(findProjectByGroupChat("oc_group123")?.id).toBe(p.id)
    expect(findProjectByGroupChat("ch_other|oc_group123")?.id).toBe(p.id)
    expect(findProjectByGroupChat("oc_other")).toBeUndefined()
  })

  it("projectGroupChatMatches and canEnterProjectFromChat enforce independent group isolation", () => {
    const groupKey = "ch_feishu|oc_group123"
    const otherKey = "ch_feishu|oc_other456"
    const withGroup = { groupChatId: groupKey }

    expect(projectGroupChatMatches(withGroup, groupKey)).toBe(true)
    expect(projectGroupChatMatches(withGroup, "oc_group123")).toBe(true)
    expect(projectGroupChatMatches(withGroup, otherKey)).toBe(false)
    expect(projectGroupChatMatches(withGroup, undefined)).toBe(false)
    expect(projectGroupChatMatches({}, groupKey)).toBe(false)

    expect(canEnterProjectFromChat({}, groupKey)).toBe(true)
    expect(canEnterProjectFromChat({}, undefined)).toBe(true)
    expect(canEnterProjectFromChat(withGroup, groupKey)).toBe(true)
    expect(canEnterProjectFromChat(withGroup, otherKey)).toBe(false)
    expect(canEnterProjectFromChat(withGroup, undefined)).toBe(false)
  })

  it("resolveProjectRef matches hex id when id starts with digits, not list index", () => {
    const first = createProject({
      name: "first", goal: "g", repoPath: "/r", baseBranch: "main",
      featureBranch: "f1", worktreePath: "/w1",
    })
    expect(resolveProjectRef("1")?.id).toBe(first.id)
    const hexId = "1abc000000000001"
    const secondPath = path.join(dir, "projects", `${hexId}.json`)
    const second = {
      ...first,
      id: hexId,
      name: "digit-prefix-id",
      featureBranch: "f2",
      worktreePath: "/w2",
      updatedAt: first.updatedAt - 60_000,
    }
    fs.writeFileSync(secondPath, JSON.stringify(second), "utf-8")
    saveProject(getProject(first.id)!)
    expect(resolveProjectRef(hexId)?.id).toBe(hexId)
    expect(resolveProjectRef(hexId)?.name).toBe("digit-prefix-id")
    expect(resolveProjectRef("1")?.id).toBe(first.id)
  })

  it("mergeProjectMetadata merges and deletes empty values", () => {
    const p = createProject({
      name: "meta",
      goal: "g",
      repoPath: "D:/r",
      baseBranch: "main",
      featureBranch: "f",
      worktreePath: "D:/w",
    })
    mergeProjectMetadata(p, { deploy_url: "https://x", env: "test" })
    expect(p.metadata).toEqual({ deploy_url: "https://x", env: "test" })
    mergeProjectMetadata(p, { env: "", token: "abc" })
    expect(p.metadata).toEqual({ deploy_url: "https://x", token: "abc" })
    mergeProjectMetadata(p, { deploy_url: "", token: "" })
    expect(p.metadata).toBeUndefined()
  })

  describe("通用模板与项目自己的流程副本", () => {
    const plainInput = {
      name: "调研", goal: "g", repoPath: "", baseBranch: "", featureBranch: "",
      worktreePath: "/w/ws", workspaceType: "plain" as const,
    }

    it("新建项目默认选通用模板，存量项目回落仍是开发流程", () => {
      expect(DEFAULT_NEW_PROJECT_GROUP_ID).toBe("general")
      expect(DEFAULT_NODE_GROUP_ID).toBe("develop")
      expect(resolveNodeGroup("general").nodes.map((n) => n.id)).toEqual(["clarify", "breakdown", "execute", "recap"])
      expect(resolveNodeGroup("general").workspace).toBe("plain")
      // 没记流程组的存量项目：节点还是开发流程
      expect(projectNodes({}).map((n) => n.id)).toContain("build")
    })

    it("存量用户升级后补种通用模板，用户删掉的模板不会复活", () => {
      fs.writeFileSync(path.join(dir, "projects", "project-node-groups.json"), JSON.stringify({
        version: 2,
        groups: [{ id: "develop", name: "开发", nodes: [{ id: "plan", label: "规划" }] }],
        seeded: ["group:develop", "group:test", "plan"],
      }), "utf-8")
      const ids = getNodeGroups().map((g) => g.id)
      expect(ids).toEqual(["develop", "general", "research", "writing", "report", "event"])
      expect(ids).not.toContain("test") // 用户早先删掉的测试组不复活

      saveNodeGroups(getNodeGroups().filter((g) => g.id !== "general"))
      expect(getNodeGroups().map((g) => g.id)).not.toContain("general")
    })

    it("模板说明和建项字段能存取，导入导出也不丢", () => {
      const research = resolveNodeGroup("research")
      expect(research.description).toBeTruthy()
      expect(research.fields?.map((f) => f.label)).toEqual(["交付形式", "使用对象", "截止时间"])

      saveNodeGroups([{
        id: "my", name: "我的", description: "  自用  ",
        fields: [
          { label: "客户", required: true },
          { label: "客户" }, // 重名丢掉
          { label: "  " }, // 没名字丢掉
          { label: "备注", multiline: true, placeholder: "随便写" },
        ],
        nodes: [{ id: "a", label: "A" }],
      }])
      const got = resolveNodeGroup("my")
      expect(got.description).toBe("自用")
      expect(got.fields).toEqual([{ label: "客户", required: true }, { label: "备注", multiline: true, placeholder: "随便写" }])

      const parsed = parseNodeGroupExport({ kind: "lk-harness-node-group", version: 1, group: got })
      expect(parsed?.description).toBe("自用")
      expect(parsed?.fields).toHaveLength(2)
    })

    it("项目有流程副本时只认副本，改全局组不影响它；没副本的存量项目实时读全局组", () => {
      const snapshot = snapshotGroups([resolveNodeGroup("research")])
      const withSnap = createProject({ ...plainInput, groupIds: ["research"], groupSnapshot: snapshot })
      const live = createProject({ ...plainInput, name: "存量", worktreePath: "/w/ws2", groupIds: ["research"] })

      const groups = getNodeGroups().map((g) =>
        g.id === "research" ? { ...g, nodes: [{ id: "scope", label: "全局改名了" }] } : g)
      saveNodeGroups(groups)

      expect(projectNodes(getProject(withSnap.id)!).map((n) => n.id)).toEqual(["scope", "gather", "analyze", "write-report"])
      expect(projectNodeLabelOf(getProject(withSnap.id)!, "scope")).toBe("界定问题")
      expect(projectNodes(getProject(live.id)!).map((n) => n.id)).toEqual(["scope"])
      expect(projectNodeLabelOf(getProject(live.id)!, "scope")).toBe("全局改名了")
    })

    it("多个流程组的步骤按顺序合并、同 id 只留第一个，找不到的步骤回落全局找", () => {
      const p = { groupIds: ["general", "research"] }
      expect(projectGroups(p).map((g) => g.id)).toEqual(["general", "research"])
      const custom = { groupSnapshot: [
        { id: "x", name: "X", nodes: [{ id: "s1", label: "一" }, { id: "s2", label: "二" }] },
        { id: "y", name: "Y", nodes: [{ id: "s2", label: "重复" }, { id: "s3", label: "三" }] },
      ] }
      expect(projectNodes(custom).map((n) => `${n.id}:${n.label}`)).toEqual(["s1:一", "s2:二", "s3:三"])
      // 副本里已经没有的步骤（历史产物来自旧步骤）回落全局找
      expect(projectNodeOf(custom, "build")?.label).toBe("实现")
      expect(projectNodeOf(custom, "no-such")).toBeUndefined()
    })

    it("createProject 透传流程副本、外部目录标记和 metadata；不带就不写这些字段", () => {
      const snapshot = snapshotGroups([resolveNodeGroup("writing")])
      const p = createProject({
        ...plainInput, groupIds: ["writing"], groupSnapshot: snapshot,
        externalWorkspace: true, metadata: { 读者: "老板" },
      })
      const got = getProject(p.id)!
      expect(got.groupSnapshot?.[0].id).toBe("writing")
      expect(got.externalWorkspace).toBe(true)
      expect(got.metadata).toEqual({ 读者: "老板" })

      const bare = getProject(createProject({ ...plainInput, name: "b", worktreePath: "/w/b" }).id)!
      expect("groupSnapshot" in bare).toBe(false)
      expect("externalWorkspace" in bare).toBe(false)
      expect("metadata" in bare).toBe(false)
    })
  })

})
