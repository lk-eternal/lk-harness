import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerAgentOutboundTools } from "../src/daemon.js"
import { registerProjectAgentTools } from "../src/server-project.js"
import { registerAdminTools } from "../src/server-admin.js"
import { getBuiltinMcpManifest } from "../src/shared/builtin-mcp-manifest.js"

function namesOf(register: (s: McpServer) => void, opts?: { sendText?: boolean }): string[] {
  const s = new McpServer({ name: "t", version: "0" })
  if (register === registerAgentOutboundTools) {
    (register as (s: McpServer, o?: { sendText?: boolean }) => void)(s, opts)
  } else {
    (register as (s: McpServer) => void)(s)
  }
  return Object.keys((s as any)._registeredTools ?? {}).sort()
}

const groupNames = (key: string): string[] =>
  (getBuiltinMcpManifest().find((g) => g.key === key)?.tools ?? []).map((t) => t.name).sort()

describe("builtin manifest 与代码注册一致（单一真相锁死）", () => {
  it("interactive 端点：通用 4 工具，无 send_text、无 project_*", () => {
    expect(namesOf(registerAgentOutboundTools, { sendText: false })).toEqual(
      ["render_branch_diff", "send_file", "send_image", "send_question"],
    )
  })

  it("task 端点：interactive 全集＋send_text", () => {
    expect(namesOf(registerAgentOutboundTools, { sendText: true })).toEqual(
      ["render_branch_diff", "send_file", "send_image", "send_question", "send_text"],
    )
  })

  it("project 端点 == manifest 项目组（硬切锁死，4 个）", () => {
    expect(namesOf(registerProjectAgentTools)).toEqual(groupNames("lk-harness-project"))
    expect(groupNames("lk-harness-project")).toHaveLength(4)
  })

  it("admin 端点 == manifest 自管理组（含 manage_project）", () => {
    const names = namesOf(registerAdminTools)
    expect(names).toEqual(groupNames("lk-harness-admin"))
    expect(names).toContain("manage_project")
  })

  it("manifest 通用组 ⊆ task 端点实注册", () => {
    const task = namesOf(registerAgentOutboundTools, { sendText: true })
    for (const n of groupNames("lk-harness")) expect(task).toContain(n)
  })
})
