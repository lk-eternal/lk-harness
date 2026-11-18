import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAdminTools } from "../src/server-admin"
import { buildProjectHelp, PROJECT_HELP_TOPICS } from "../src/shared/project-ai-help"
import { PROJECT_REPOS_MAX } from "../src/shared/project-app-types"
import { GIT_PRINCIPLES_MAX } from "../src/shared/project-git-principles"
import { ACTION_LABEL_MAX, TEMPLATE_FIELDS_MAX } from "../src/shared/project-template-edit"
import { DEFAULT_NODE_GROUPS } from "../src/shared/project-types"

/**
 * manage_project 的 help 是写给 AI 的操作手册：用户是新手，AI 靠它带着用户配好、建好。
 * 手册说的东西必须是真的：提到的模板、操作、参数名、数字上限，都要和代码里现在的一致，
 * 将来改了功能而忘了改手册，这里会红。
 */

const text = (topic?: string): string => {
  const r = buildProjectHelp(topic)
  if (!r.ok) throw new Error(r.error)
  return r.text
}
const ALL = PROJECT_HELP_TOPICS.map((t) => text(t)).join("\n")

/** 真实注册出来的 manage_project：它的动作清单和参数名是手册该对得上的真相 */
function manageProjectSchema() {
  const s = new McpServer({ name: "t", version: "0" })
  registerAdminTools(s, { hostRpc: { request: async () => ({ ok: false, error: "x" }), settle: () => false, pendingCount: () => 0 } })
  const tool = (s as any)._registeredTools.manage_project as { inputSchema: any; description: string }
  const shape = (tool.inputSchema.shape ?? tool.inputSchema._def?.shape?.() ?? {}) as Record<string, any>
  return { tool, shape }
}

function keysOf(schema: any): string[] {
  let t = schema
  // 剥掉 optional / describe 的包装
  for (let i = 0; i < 6 && t; i++) {
    if (t.shape) return Object.keys(t.shape)
    if (t.unwrap) t = t.unwrap()
    else if (t._def?.innerType) t = t._def.innerType
    else if (t.def?.innerType) t = t.def.innerType
    else break
  }
  return []
}

describe("help 主题", () => {
  it("不给主题是总览；每个主题都有内容，并指向其它主题", () => {
    expect(text()).toBe(text("overview"))
    expect(text("  ")).toBe(text("overview"))
    for (const t of PROJECT_HELP_TOPICS) {
      const body = text(t)
      expect(body.length).toBeGreaterThan(200)
      for (const other of PROJECT_HELP_TOPICS.filter((x) => x !== t)) expect(body).toContain(`help topic=${other}`)
    }
  })

  it("主题不认识：报错并列出可选的", () => {
    const r = buildProjectHelp("billing")
    expect(r.ok).toBe(false)
    expect(r.ok ? "" : r.error).toContain("overview / create / repos / templates / settings / manage")
  })

  it("篇幅受控：总览不超过 4500 字，其余主题不超过 3000 字（每次都进 AI 的上下文）", () => {
    expect(text().length).toBeLessThan(4500)
    for (const t of PROJECT_HELP_TOPICS.filter((x) => x !== "overview")) expect(text(t).length).toBeLessThan(3000)
  })
})

describe("总览讲清了新手上路需要的东西", () => {
  const t = text()

  it("概念、完整建项目流程、用户说法对应的做法、对话方式、做不到的事，都在", () => {
    for (const w of [
      "项目模板", "流程组", "快捷操作", "常用代码仓库", "项目存放位置", "Git 基本原则",
      "帮用户建项目：完整流程", "摸底", "send_question", "chat_mode", "确认", "create",
      "用户说的话", "和用户说话的方式", "这些工具目前做不到",
    ]) expect(t).toContain(w)
  })

  it("GitLab / 共享空间被说成可选：不影响建项目，没提就别主动让用户配", () => {
    expect(t).toMatch(/GitLab[^。]*可选/)
    expect(t).toContain("不影响建项目、改代码、推分支")
    expect(t).toContain("没提就不要主动让他配")
  })

  it("密钥处理：不复述原文、不写进文件、提醒聊天记录会留着", () => {
    expect(t).toContain("不要重复原文")
    expect(t).toContain("不要写进任何文件")
    expect(t).toContain("聊天记录")
  })

  it("提到的内置模板就是代码里的内置模板：数量和名字都对得上", () => {
    expect(t).toContain(`内置 ${DEFAULT_NODE_GROUPS.length} 个`)
    for (const g of DEFAULT_NODE_GROUPS) expect(t).toContain(g.name)
  })

  it("别说术语：手册里教 AI 对用户说「基线分支」「常用仓库」，并明说别说 worktree 之类", () => {
    expect(t).toContain("别说 worktree")
  })
})

describe("手册和真实代码对得上", () => {
  it("手册里点名的 action 都是 manage_project 真有的；真有的 action 手册都讲到了", () => {
    const { shape } = manageProjectSchema()
    const actions: string[] = shape.action.options ?? shape.action._def?.values ?? []
    expect(actions.length).toBeGreaterThanOrEqual(16)
    for (const a of actions) expect(ALL, `手册没讲 action=${a}`).toContain(a)
    for (const m of ALL.matchAll(/action=([a-z_]+)/g)) expect(actions, `手册里的 action=${m[1]} 不存在`).toContain(m[1])
  })

  it("手册里出现的 snake_case 参数名，都是 manage_project 的参数（含 repo / template / settings 里的子参数）", () => {
    const { shape } = manageProjectSchema()
    const known = new Set<string>(["send_question"])
    for (const [k, v] of Object.entries(shape)) {
      known.add(k)
      for (const sub of keysOf(v)) known.add(sub)
    }
    for (const a of shape.action.options as string[]) known.add(a)
    // 数组元素里的键（fields / actions 的子项）
    for (const k of ["id", "label", "prompt", "placeholder", "required", "multiline"]) known.add(k)
    const used = new Set([...ALL.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]))
    for (const w of used) expect(known.has(w), `手册提到的「${w}」不是 manage_project 的参数或动作`).toBe(true)
  })

  it("子参数真的存在：repo / template / settings 里手册点到的键", () => {
    const { shape } = manageProjectSchema()
    expect(keysOf(shape.repo)).toEqual(expect.arrayContaining(["repo_path", "base_branch", "test_branch", "develop_branch", "clone"]))
    expect(keysOf(shape.template)).toEqual(expect.arrayContaining(["name", "description", "needs_repo", "work_branch", "fields", "actions"]))
    expect(keysOf(shape.settings)).toEqual(expect.arrayContaining([
      "worktree_root", "git_principles", "reset_git_principles", "gitlab_host", "gitlab_token", "flow_hub_url", "flow_hub_token", "flow_hub_author",
    ]))
  })

  it("手册里写的数字上限和代码一致", () => {
    expect(text("templates")).toContain(`最多 ${TEMPLATE_FIELDS_MAX} 项`)
    expect(text("templates")).toContain(`≤${ACTION_LABEL_MAX} 字`)
    expect(text("settings")).toContain(`≤${GIT_PRINCIPLES_MAX} 字`)
    expect(text("create")).toContain(`最多 ${PROJECT_REPOS_MAX} 个`)
  })

  it("工具说明（description）里也点出 help：模型第一眼就知道先读手册", () => {
    const { tool } = manageProjectSchema()
    expect(tool.description).toContain("help")
    expect(tool.description).toContain("先读")
    for (const w of ["repo_save", "template_save", "settings_set", "不要让他去设置页"]) expect(tool.description).toContain(w)
  })
})
