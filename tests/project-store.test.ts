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
  mergeProjectMetadata,
} from "../src/shared/project-store.js"
import {
  canEnterProjectFromChat,
  DEFAULT_NODE_GROUP_ID,
  projectGroupChatMatches,
} from "../src/shared/project-types.js"

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
    expect(groups.map((g) => g.id)).toEqual(["develop", "test"])
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

})
