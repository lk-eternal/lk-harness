import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildNodeActionPrompt } from "../src/shared/project-node-guides.js"
import { createProject, initProjectStore, resolveNodeGroup, saveNodeGroups, getNodeGroups } from "../src/shared/project-store.js"
import { snapshotGroups } from "../src/shared/project-templates.js"
import { buildActionPrompt, buildProjectSessionPrompt } from "../electron/project-prompts.js"
import { DEFAULT_GIT_PRINCIPLES } from "../src/shared/project-git-principles.js"
import type { Project } from "../src/shared/project-types.js"

describe("项目提示词：接了代码仓库的项目与普通项目分开", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-guides-"))
    initProjectStore(dir)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const dev = (extra: Partial<Project> = {}) => createProject({
    name: "登录改造", goal: "g", worktreePath: "/w/login/repo", groupIds: ["develop"],
    metadata: { 代码仓库: "/w/login/repo（工作分支 feature/x；基线分支 main；测试分支 test）" }, ...extra,
  })
  const plain = (groupIds: string[], extra: Partial<Project> = {}) => createProject({
    name: "竞品调研", goal: "g", worktreePath: "/w/research/workspace", groupIds, ...extra,
  })
  /** 提示词里不该再出现的旧说法：AI 只看到普通的项目信息和目录，不区分「工作目录 / 本机仓库 / 主仓」 */
  const OLD_WORDING = ["AI 工作目录", "本机仓库", "主仓", "分支红线", "分支与红线", "开发负责人", "feature 分支:"]

  it("接了代码仓库的项目：步骤提示词里只提一句「遵守 Git 基本原则」，仓库和分支就是普通的项目信息", () => {
    const p = dev()
    const text = buildNodeActionPrompt(p, "plan", "按钮点击")
    expect(text).toContain("[PROJECT_ACTION] 规划步骤")
    expect(text).toContain("Git 操作遵守会话开头给出的「Git 基本原则」")
    expect(text).toContain("写当前目录下的 .lk-harness/artifacts/")
    for (const old of OLD_WORDING) expect(text, old).not.toContain(old)
  })

  it("普通项目的步骤提示词没有分支红线、MR、飞书、Git 提醒，成果写当前目录", () => {
    const p = plain(["research"])
    const text = buildNodeActionPrompt(p, "scope", "按钮点击")
    expect(text).toContain("[PROJECT_ACTION] 界定问题步骤")
    expect(text).toContain("界定调研问题")
    expect(text).toContain("本步骤要求")
    expect(text).toContain("当前目录下的 .lk-harness/artifacts/")
    expect(text).not.toMatch(/分支|MR|飞书|feature|git |Git/)
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

  it("会话提示词：普通项目不提分支、MR、飞书文档参数，也不带 Git 基本原则", () => {
    const text = buildProjectSessionPrompt(plain(["general"], { metadata: { 交付形式: "5 页 PPT" } }))
    expect(text).toContain("项目信息:")
    expect(text).toContain("- 交付形式: 5 页 PPT")
    expect(text).toContain("项目目录: /w/research")
    expect(text).not.toMatch(/分支|mr_url|feishu_doc_url|开发负责人|feature|Git 基本原则/)
    expect(text).not.toContain("不要改动或删除用户原有文件")
  })

  it("会话提示词：外部文件夹项目提醒别动用户原有文件", () => {
    const text = buildProjectSessionPrompt(plain(["general"], { externalWorkspace: true }))
    expect(text).toContain("不要改动或删除用户原有文件")
  })

  it("会话提示词：接了代码仓库的项目——仓库和分支是项目信息里的几行字，后面跟着 Git 基本原则；不再有旧说法", () => {
    const text = buildProjectSessionPrompt(dev())
    expect(text).toContain("- 代码仓库: /w/login/repo（工作分支 feature/x；基线分支 main；测试分支 test）")
    expect(text).toContain("项目目录: /w/login")
    expect(text).toContain(DEFAULT_GIT_PRINCIPLES)
    expect(text).toContain("mr_url?, feishu_doc_url?")
    for (const old of OLD_WORDING) expect(text, old).not.toContain(old)
    // Git 基本原则在项目信息之后、工作方式之前
    expect(text.indexOf("项目信息:")).toBeLessThan(text.indexOf("Git 基本原则"))
    expect(text.indexOf("Git 基本原则")).toBeLessThan(text.indexOf("工作方式:"))
  })

  it("Git 基本原则：没设过用默认；设了别的用设的；清空就不带（节点里也不再提它）", () => {
    const p = dev()
    expect(buildProjectSessionPrompt(p, { gitPrinciples: undefined })).toContain(DEFAULT_GIT_PRINCIPLES)
    const custom = buildProjectSessionPrompt(p, { gitPrinciples: "只在 feature 分支上提交，别碰别的。" })
    expect(custom).toContain("只在 feature 分支上提交，别碰别的。")
    expect(custom).not.toContain(DEFAULT_GIT_PRINCIPLES)
    for (const off of ["", "  \n "]) {
      const text = buildProjectSessionPrompt(p, { gitPrinciples: off })
      expect(text).not.toContain("Git 基本原则")
      expect(text).toContain("- 代码仓库:")
    }
    expect(buildActionPrompt(p, "plan", "t", { gitPrinciples: "" })).not.toContain("Git 基本原则")
    expect(buildActionPrompt(p, "plan", "t", { gitPrinciples: undefined })).toContain("Git 基本原则")
    expect(buildActionPrompt(p, "plan", "t")).toContain("Git 基本原则")
  })

  it("项目信息里的仓库行被用户删掉后，就当没接仓库：不带 Git 基本原则", () => {
    const p = dev({ metadata: { 客户: "A" } })
    expect(buildProjectSessionPrompt(p)).not.toContain("Git 基本原则")
    expect(buildNodeActionPrompt(p, "plan", "t")).not.toContain("Git 基本原则")
    // 多个仓库的行（代码仓库 · 名字）同样算
    const multi = dev({ metadata: { "代码仓库 · api": "/w/a/api" } })
    expect(buildProjectSessionPrompt(multi)).toContain("Git 基本原则")
  })
})
