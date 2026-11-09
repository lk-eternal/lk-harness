import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAgentOutboundTools } from "../src/daemon.js"
import { registerProjectAgentTools } from "../src/server-project.js"
import { registerAdminTools } from "../src/server-admin.js"
import { registerScheduleTools, type ScheduleApi } from "../src/server-schedule.js"
import { getBuiltinMcpManifest } from "../src/shared/builtin-mcp-manifest.js"

type Register = (s: McpServer, opts?: unknown) => void

function namesOf(register: Register, opts?: { taskResult?: boolean }): string[] {
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

const groupNames = (key: string): string[] =>
  (getBuiltinMcpManifest().find((g) => g.key === key)?.tools ?? []).map((t) => t.name).sort()

describe("builtin manifest 与代码注册一致（单一真相锁死）", () => {
  it("interactive 端点：通用 4 工具，无 send_result、无 project_*", () => {
    expect(namesOf(registerAgentOutboundTools as Register, { taskResult: false })).toEqual(
      ["render_branch_diff", "send_file", "send_image", "send_question"],
    )
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
