/** AI 自排程的提示词注入：lk-harness-schedule 挂在哪些会话，提示词里的「自排程」段就出现在哪些会话。
 * 走真实的协议模板和 admin SKILL.md，只桩掉 Electron / 配置 / daemon 这些与注入无关的依赖。 */
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("electron", async () => {
  const p = await import("node:path")
  const f = await import("node:fs")
  const o = await import("node:os")
  const userData = f.mkdtempSync(p.join(o.tmpdir(), "lsched-userdata-"))
  return { app: { isPackaged: false, getAppPath: () => p.resolve(process.cwd()), getPath: () => userData } }
})
vi.mock("../electron/config-store", () => ({
  getConfig: () => ({ digitalIdentity: "", daemonPort: 19528, channels: [] }),
  getChannel: () => undefined,
}))
vi.mock("../electron/daemon-client", () => ({ readLockFile: () => null }))
vi.mock("../electron/cron-scheduler", () => ({ readTasksFromFile: () => [] }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: () => {} }))

import { assembleProtocolBlocks, clearProtocolTemplateCache, type PromptAssemblyContext } from "../electron/prompt-assembler.js"
import { buildBuiltinMcpServers, shouldMountScheduleMcp, SCHEDULE_MCP_KEY } from "../src/shared/harness-mcp-store.js"

beforeEach(() => clearProtocolTemplateCache())

const SCHEDULE_TOOLS = "schedule_create / schedule_list / schedule_cancel"
const text = (ctx: PromptAssemblyContext) => assembleProtocolBlocks(ctx, 19528).join("\n")
const count = (s: string, sub: string) => s.split(sub).length - 1

const MAIN: PromptAssemblyContext = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true }
const PROJECT: PromptAssemblyContext = { meta: { chatType: "project" }, sessionKey: "ch_a|oc_group::project_p1", includeAdmin: false }

describe("自排程提示词跟着工具挂载走", () => {
  it("项目会话：有自排程段，没有应用自管理段", () => {
    const t = text(PROJECT)
    expect(t).toContain(SCHEDULE_TOOLS)
    expect(t).toContain("lk-harness-schedule")
    expect(t).not.toContain("manage_agent")
    expect(t).not.toContain("应用自管理")
  })

  it("项目会话：只靠 sessionKey 里的 ::project_ 也认（meta 没带 chatType）", () => {
    expect(text({ sessionKey: PROJECT.sessionKey, includeAdmin: false })).toContain(SCHEDULE_TOOLS)
  })

  it("主用户会话：自管理段和自排程段都有，且自排程只出现一次", () => {
    const t = text(MAIN)
    expect(t).toContain("manage_agent")
    expect(count(t, SCHEDULE_TOOLS)).toBe(1)
  })

  it.each([["项目会话", PROJECT], ["主用户会话", MAIN]] as [string, PromptAssemblyContext][])(
    "%s：告诉排程者 fresh 的执行者没事可报时可以静默（否则会把「无事」也写成要汇报的内容）",
    (_n, ctx) => {
      const t = text(ctx)
      const fresh = t.slice(t.indexOf("`mode=fresh`"), t.indexOf("`mode=session`"))
      expect(fresh).toContain("有结论才投回本会话")
      expect(fresh).toContain("静默")
    },
  )

  it("自管理段不再内嵌自排程说明，只留一句指向 schedule_create", () => {
    const t = text(MAIN)
    const adminPart = t.slice(t.indexOf("应用自管理"), t.indexOf("AI 自排程（lk-harness-schedule）"))
    expect(adminPart).toContain("manage_tasks")
    expect(adminPart).toContain("那用 schedule_create")
    expect(adminPart).not.toContain(SCHEDULE_TOOLS)
  })

  it.each([
    ["群聊 / 其他人", { meta: { chatType: "group" }, sessionKey: "ch_a|oc_group", includeAdmin: false }],
    ["私聊（非主用户）", { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_x", includeAdmin: false }],
    ["临时会话", { meta: { chatType: "temp" }, sessionKey: "temp_abc", includeAdmin: false }],
    ["独立定时任务", { meta: { chatType: "task" }, sessionKey: "task_1", includeAdmin: false }],
  ] as [string, PromptAssemblyContext][])("%s：没挂载自排程，提示词里也没有", (_n, ctx) => {
    const t = text(ctx)
    expect(t).not.toContain("schedule_create")
    expect(t).not.toContain("lk-harness-schedule")
  })

  it("没有会话 key（没有调用者身份）：不挂载，也不提", () => {
    expect(text({ meta: { chatType: "project" }, includeAdmin: false })).not.toContain("schedule_create")
  })

  it("提示词判定与挂载判定一致：同一组条件，挂了就提、没挂就不提", () => {
    const cases: PromptAssemblyContext[] = [MAIN, PROJECT, { meta: { chatType: "group" }, sessionKey: "ch_a|oc_g", includeAdmin: false }, { meta: { chatType: "task" }, sessionKey: "t1", includeAdmin: false }]
    for (const ctx of cases) {
      const mounted = SCHEDULE_MCP_KEY in buildBuiltinMcpServers(
        19528,
        ctx.includeAdmin === true,
        ctx.meta?.chatType === "task" ? "task" : "interactive",
        ctx.meta?.chatType === "project" || !!ctx.sessionKey?.includes("::project_"),
        ctx.sessionKey,
      )
      expect(text(ctx).includes(SCHEDULE_TOOLS), JSON.stringify(ctx)).toBe(mounted)
    }
  })
})

describe("shouldMountScheduleMcp", () => {
  const base = { includeAdmin: false, includeProject: false, endpoint: "interactive" as const, sessionKey: "s1" }
  it("主用户会话、项目会话可挂载", () => {
    expect(shouldMountScheduleMcp({ ...base, includeAdmin: true })).toBe(true)
    expect(shouldMountScheduleMcp({ ...base, includeProject: true })).toBe(true)
  })
  it("两者都不是不挂", () => {
    expect(shouldMountScheduleMcp(base)).toBe(false)
  })
  it("task 端点不挂；没有调用者会话（或全空白）不挂", () => {
    expect(shouldMountScheduleMcp({ ...base, includeAdmin: true, endpoint: "task" })).toBe(false)
    expect(shouldMountScheduleMcp({ ...base, includeAdmin: true, sessionKey: undefined })).toBe(false)
    expect(shouldMountScheduleMcp({ ...base, includeProject: true, sessionKey: "   " })).toBe(false)
  })
})

describe("buildBuiltinMcpServers 的自排程挂载", () => {
  it("项目会话挂 lk-harness-schedule，并带上调用者会话头", () => {
    const s = buildBuiltinMcpServers(19528, false, "interactive", true, "ch_a|oc_g::project_p1")
    expect(s[SCHEDULE_MCP_KEY]).toEqual({
      url: "http://127.0.0.1:19528/mcp-schedule",
      headers: { "X-Harness-Session-Key": "ch_a|oc_g::project_p1" },
    })
  })
  it("普通会话不挂", () => {
    expect(SCHEDULE_MCP_KEY in buildBuiltinMcpServers(19528, false, "interactive", false, "ch_a|oc_g")).toBe(false)
  })
})
