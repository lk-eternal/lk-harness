import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAgentOutboundTools } from "../src/daemon.js"
import { registerProjectAgentTools } from "../src/server-project.js"
import { registerAdminTools } from "../src/server-admin.js"
import { registerScheduleTools, type ScheduleApi } from "../src/server-schedule.js"
import { registerMemoryTools } from "../src/server-memory.js"
import { getBuiltinMcpManifest } from "../src/shared/builtin-mcp-manifest.js"

type Register = (s: McpServer, opts?: unknown) => void

function namesOf(register: Register, opts?: { taskResult?: boolean; visitor?: boolean }): string[] {
  const s = new McpServer({ name: "t", version: "0" })
  register(s, opts)
  return Object.keys((s as any)._registeredTools ?? {}).sort()
}

const noopApi: ScheduleApi = {
  create: () => ({ ok: true, text: "" }),
  list: () => ({ ok: true, text: "" }),
  cancel: () => ({ ok: true, text: "" }),
}
const registerSchedule: Register = (s) => registerScheduleTools(s, noopApi, () => undefined)
const registerMemory: Register = (s) => registerMemoryTools(s, "", () => undefined)

const groupNames = (key: string): string[] =>
  (getBuiltinMcpManifest().find((g) => g.key === key)?.tools ?? []).map((t) => t.name).sort()

describe("builtin manifest 与代码注册一致（单一真相锁死）", () => {
  it("interactive 端点：通用 4 工具，无 send_result、无 project_*", () => {
    expect(namesOf(registerAgentOutboundTools as Register, { taskResult: false })).toEqual(
      ["render_branch_diff", "send_file", "send_image", "send_question"],
    )
  })

  it("visitor 端点（其他人的受限会话）：只有 send_question，没有任何能读写本机路径的工具", () => {
    const names = namesOf(registerAgentOutboundTools as Register, { visitor: true })
    expect(names).toEqual(["send_question"])
    for (const n of ["send_image", "send_file", "render_branch_diff", "send_result"]) expect(names).not.toContain(n)
  })

  it("task 端点：interactive 全集＋send_result，且不再有 send_text", () => {
    const names = namesOf(registerAgentOutboundTools as Register, { taskResult: true })
    expect(names).toEqual(["render_branch_diff", "send_file", "send_image", "send_question", "send_result"])
    expect(names).not.toContain("send_text")
  })

  it("project 端点 == manifest 项目组（硬切锁死，4 个）", () => {
    expect(namesOf(registerProjectAgentTools as Register)).toEqual(groupNames("lk-harness-project"))
    expect(groupNames("lk-harness-project")).toHaveLength(4)
  })

  it("admin 端点 == manifest 自管理组（含 manage_project）", () => {
    const names = namesOf(registerAdminTools as Register)
    expect(names).toEqual(groupNames("lk-harness-admin"))
    expect(names).toContain("manage_project")
  })

  it("schedule 端点 == manifest AI 自排程组（3 个）", () => {
    expect(namesOf(registerSchedule)).toEqual(groupNames("lk-harness-schedule"))
    expect(groupNames("lk-harness-schedule")).toEqual(["schedule_cancel", "schedule_create", "schedule_list"])
  })

  it("memory 端点 == manifest 会话记忆组（3 个）", () => {
    expect(namesOf(registerMemory)).toEqual(groupNames("lk-harness-memory"))
    expect(groupNames("lk-harness-memory")).toEqual(["memory_delete", "memory_read", "memory_save"])
  })

  it("schedule_create 的说明同样告诉调用者：fresh 没事可报可静默、prompt 里写明何时汇报", () => {
    const s = new McpServer({ name: "t", version: "0" })
    registerSchedule(s)
    const desc: string = (s as any)._registeredTools.schedule_create.description
    expect(desc).toContain("有结论才投回本会话")
    expect(desc).toContain("静默")
    expect(desc).toContain("写明什么情况下才汇报")
  })

  it("memory_save 的说明交代清楚：记忆跟着会话走、只有重置才清空、满了先合并", () => {
    const s = new McpServer({ name: "t", version: "0" })
    registerMemory(s)
    const desc: string = (s as any)._registeredTools.memory_save.description
    expect(desc).toContain("最近约 15 轮")
    expect(desc).toContain("首轮都会带上")
    expect(desc).toContain("只有重置会话才会清空")
    expect(desc).toContain("满了先合并")
    expect(desc).toContain("memory_delete")
  })

  it("send_question 的说明和参数把用法交代清楚（提示词里不再重复这些）", () => {
    const s = new McpServer({ name: "t", version: "0" })
    registerAgentOutboundTools(s, { taskResult: false })
    const tool = (s as any)._registeredTools.send_question
    expect(tool.description).toContain("答案不会在本次调用里返回")
    expect(tool.description).toContain("一次发完")
    const shape = tool.inputSchema?.shape ?? tool.inputSchema?._def?.shape?.() ?? {}
    expect(shape.text?.description).toContain("不要在题目里写结论")
    expect(shape.options?.description).toContain("不要写序号")
    expect(shape.options?.description).toContain("不要含「、」")
  })

  it("manifest 通用组 ⊆ task 端点实注册", () => {
    const task = namesOf(registerAgentOutboundTools as Register, { taskResult: true })
    for (const n of groupNames("lk-harness")) expect(task).toContain(n)
  })

  it("每个 manifest 工具都有说明文档（设置页展示用）", () => {
    for (const g of getBuiltinMcpManifest()) {
      for (const t of g.tools) expect(t.doc, `${g.key}/${t.name} 缺文档`).toBeDefined()
    }
  })
})
