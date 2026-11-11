import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildNodeActionPrompt } from "../src/shared/project-node-guides.js"
import { createProject, initProjectStore, resolveNodeGroup, saveNodeGroups, getNodeGroups } from "../src/shared/project-store.js"
import { snapshotGroups } from "../src/shared/project-templates.js"
import { buildProjectSessionPrompt } from "../electron/project-prompts.js"
import type { Project } from "../src/shared/project-types.js"

describe("项目提示词：研发项目与普通项目分开", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-guides-"))
    initProjectStore(dir)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const dev = () => createProject({
    name: "登录改造", goal: "g", repoPath: "/r", baseBranch: "main", featureBranch: "feature/x",
    worktreePath: "/w/login/repo", groupIds: ["develop"],
  })
  const plain = (groupIds: string[], extra: Partial<Project> = {}) => createProject({
    name: "竞品调研", goal: "g", repoPath: "", baseBranch: "", featureBranch: "",
    worktreePath: "/w/research/workspace", workspaceType: "plain", groupIds, ...extra,
  })

  it("研发项目的步骤提示词保留分支红线和 MR 措辞（行为不变）", () => {
    const p = dev()
    const text = buildNodeActionPrompt(p, "plan", "按钮点击")
    expect(text).toContain("[PROJECT_ACTION] 规划节点")
    expect(text).toContain("分支与红线")
    expect(text).toContain("MR地址")
    expect(text).toContain("AI 工作目录下的 .lk-harness/artifacts/")
  })

  it("普通项目的步骤提示词没有分支红线、MR、飞书，成果写项目目录", () => {
    const p = plain(["research"])
    const text = buildNodeActionPrompt(p, "scope", "按钮点击")
    expect(text).toContain("[PROJECT_ACTION] 界定问题步骤")
    expect(text).toContain("界定调研问题")
    expect(text).toContain("本步骤要求")
    expect(text).toContain("项目目录下的 .lk-harness/artifacts/")
    expect(text).not.toMatch(/分支|MR|飞书|feature|git /)
  })

  it("项目副本里用户改过的步骤要求优先；没改的步骤跟随代码里的默认提示词", () => {
    const snap = snapshotGroups([resolveNodeGroup("writing")])
    snap[0].nodes.find((n) => n.id === "draft")!.prompt = "只写 300 字，别展开"
    const p = plain(["writing"], { groupSnapshot: snap })

    const draft = buildNodeActionPrompt(p, "draft", "t")
    expect(draft).toContain("只写 300 字，别展开")
    expect(draft).not.toContain("按已确认的大纲")

    expect(buildNodeActionPrompt(p, "outline", "t")).toContain("拟大纲")

    // 改全局模板里的 draft 不影响这个项目（它有自己的副本）
    saveNodeGroups(getNodeGroups().map((g) => g.id === "writing"
      ? { ...g, nodes: g.nodes.map((n) => n.id === "draft" ? { ...n, prompt: "全局改的" } : n) }
      : g))
    expect(buildNodeActionPrompt(p, "draft", "t")).toContain("只写 300 字，别展开")
  })

  it("项目副本里的步骤改名后，标题用副本里的名字", () => {
    const snap = snapshotGroups([resolveNodeGroup("general")])
    snap[0].nodes[0].label = "先聊清楚"
    const p = plain(["general"], { groupSnapshot: snap })
    expect(buildNodeActionPrompt(p, "clarify", "t")).toContain("[PROJECT_ACTION] 先聊清楚步骤")
  })

  it("会话提示词：普通项目不提分支、MR、飞书文档参数，也不当「开发负责人」", () => {
    const text = buildProjectSessionPrompt(plain(["general"], { metadata: { 交付形式: "5 页 PPT" } }))
    expect(text).toContain("项目信息:")
    expect(text).toContain("- 交付形式: 5 页 PPT")
    expect(text).toContain("纯会话型项目，无代码仓")
    expect(text).not.toMatch(/分支|mr_url|feishu_doc_url|开发负责人|feature/)
    expect(text).toContain("不要改动或删除用户原有文件")
  })

  it("会话提示词：研发项目照旧带分支、MR 和飞书文档参数", () => {
    const text = buildProjectSessionPrompt(dev())
    expect(text).toContain("feature 分支: feature/x")
    expect(text).toContain("mr_url?, feishu_doc_url?")
    expect(text).toContain("开发负责人")
  })
})
