/** 宿主提示词的「身份」和「能力」两块：能力里出现哪些组，必须和 MCP 实际挂载的组一致（共用 harness-mcp-store 的判定）。 */
import { describe, expect, it } from "vitest"
import { IDENTITY_BLOCK, buildCapabilityBlock, type CapabilityScope } from "../src/shared/capability-index.js"
import { buildBuiltinMcpServers, MEMORY_MCP_KEY, SCHEDULE_MCP_KEY } from "../src/shared/harness-mcp-store.js"

const BASE = "## 基础（lk-harness）"
const ADMIN = "## 应用自管理（lk-harness-admin）"
const PROJECT = "## 项目（lk-harness-project）"
const SCHEDULE = "## AI 自排程（lk-harness-schedule）"
const MEMORY = "## 会话记忆（lk-harness-memory）"

const scope = (over: Partial<CapabilityScope> = {}): CapabilityScope => ({
  endpoint: "interactive",
  includeAdmin: false,
  includeProject: false,
  sessionKey: "ch_a|oc_x",
  ...over,
})

describe("身份块", () => {
  it("一行标题加一句话，没有占位符", () => {
    expect(IDENTITY_BLOCK).toBe("# 身份\n你是运行在 LK Harness 应用下的 AI 助手。")
  })
})

describe("能力块：只列工具组，不抄参数", () => {
  it("开头是标题和总说明，交代参数以工具自带说明为准", () => {
    const t = buildCapabilityBlock(scope())
    expect(t.startsWith("# 能力\n\nLK Harness 通过 MCP 提供下面几组工具。")).toBe(true)
    expect(t).toContain("以工具自带说明为准")
  })

  it("每个组之间隔一个空行，不留连续两个空行", () => {
    const t = buildCapabilityBlock(scope({ includeAdmin: true, includeProject: true }))
    expect(t).not.toMatch(/\n\n\n/)
    expect(t).not.toMatch(/^\s|\s$/)
  })

  it("不含工具参数名、占位符、端口", () => {
    const t = buildCapabilityBlock(scope({ includeAdmin: true, includeProject: true }))
    for (const s of ["image_path", "file_path", "multi_select", "{{", "19528", "127.0.0.1"]) expect(t).not.toContain(s)
  })

  it("交互会话：基础组有提问、发图、发文件、分支对比，没有 send_result", () => {
    const t = buildCapabilityBlock(scope())
    expect(t).toContain(BASE)
    for (const s of ["send_question", "send_image", "send_file", "render_branch_diff"]) expect(t).toContain(s)
    expect(t).not.toContain("send_result")
  })

  it("独立任务：基础组多一个 send_result，且不挂记忆和自排程", () => {
    const t = buildCapabilityBlock(scope({ endpoint: "task", includeAdmin: true, sessionKey: "task_1" }))
    expect(t).toContain("send_result")
    expect(t).not.toContain(MEMORY)
    expect(t).not.toContain(SCHEDULE)
  })

  it("访客：只有 send_question，碰不到本机文件的工具也不被提到", () => {
    const t = buildCapabilityBlock(scope({ endpoint: "visitor" }))
    expect(t).toContain("send_question")
    for (const s of ["send_image", "send_file", "render_branch_diff", "send_result", MEMORY, SCHEDULE, ADMIN, PROJECT]) expect(t).not.toContain(s)
  })

  it("自管理、项目组只在对应会话出现", () => {
    expect(buildCapabilityBlock(scope())).not.toContain(ADMIN)
    expect(buildCapabilityBlock(scope())).not.toContain(PROJECT)
    expect(buildCapabilityBlock(scope({ includeAdmin: true }))).toContain(ADMIN)
    expect(buildCapabilityBlock(scope({ includeProject: true }))).toContain(PROJECT)
  })

  it("组的顺序固定：基础、自管理、项目、自排程、记忆", () => {
    const t = buildCapabilityBlock(scope({ includeAdmin: true, includeProject: true }))
    const at = [BASE, ADMIN, PROJECT, SCHEDULE, MEMORY].map((g) => t.indexOf(g))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it("同样的输入，同样的输出（指纹要稳定）", () => {
    const s = scope({ includeAdmin: true })
    expect(buildCapabilityBlock(s)).toBe(buildCapabilityBlock({ ...s }))
  })
})

describe("能力块和实际挂载的 MCP 组一致", () => {
  const cases: [string, CapabilityScope][] = [
    ["主用户会话", scope({ includeAdmin: true })],
    ["项目会话", scope({ includeProject: true })],
    ["普通交互会话", scope()],
    ["独立任务", scope({ endpoint: "task", sessionKey: "task_1" })],
    ["访客", scope({ endpoint: "visitor" })],
    ["主用户但没有会话 key", scope({ includeAdmin: true, sessionKey: undefined })],
  ]
  it.each(cases)("%s", (_n, s) => {
    const mounted = buildBuiltinMcpServers(19528, s.includeAdmin, s.endpoint, s.includeProject, s.sessionKey)
    const t = buildCapabilityBlock(s)
    expect(t.includes(SCHEDULE), "schedule").toBe(SCHEDULE_MCP_KEY in mounted)
    expect(t.includes(MEMORY), "memory").toBe(MEMORY_MCP_KEY in mounted)
  })
})
