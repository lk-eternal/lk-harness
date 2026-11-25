/** AI 自排程的提示词注入：lk-harness-schedule 挂在哪些会话，提示词「能力」里的自排程组就出现在哪些会话。
 * 走真实的提示词组装，只桩掉 Electron / 配置 / daemon 这些与注入无关的依赖。 */
import { describe, it, expect, vi } from "vitest"

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

import { assembleProtocolBlocks, type PromptAssemblyContext } from "../electron/prompt-assembler.js"
import { buildBuiltinMcpServers, shouldMountScheduleMcp, SCHEDULE_MCP_KEY } from "../src/shared/harness-mcp-store.js"
import { joinPromptBlocks } from "../src/shared/prompt-markup.js"

const SCHEDULE_GROUP = "## AI 自排程（lk-harness-schedule）"
const ADMIN_GROUP = "## 应用自管理（lk-harness-admin）"
const text = (ctx: PromptAssemblyContext) => joinPromptBlocks(assembleProtocolBlocks(ctx))
const count = (s: string, sub: string) => s.split(sub).length - 1

const MAIN: PromptAssemblyContext = { meta: { chatType: "p2p" }, sessionKey: "ch_a|oc_main", includeAdmin: true }
const PROJECT: PromptAssemblyContext = { meta: { chatType: "project" }, sessionKey: "ch_a|oc_group::project_p1", includeAdmin: false }

describe("自排程提示词跟着工具挂载走", () => {
  it("项目会话：有自排程组，没有应用自管理组", () => {
    const t = text(PROJECT)
    expect(t).toContain(SCHEDULE_GROUP)
    expect(t).not.toContain("lk-harness-admin")
  })

  it("项目会话：只靠 sessionKey 里的 ::project_ 也认（meta 没带 chatType）", () => {
    expect(text({ sessionKey: PROJECT.sessionKey, includeAdmin: false })).toContain(SCHEDULE_GROUP)
  })

  it("主用户会话：自管理组和自排程组都有，且自排程只出现一次", () => {
    const t = text(MAIN)
    expect(t).toContain(ADMIN_GROUP)
    expect(count(t, SCHEDULE_GROUP)).toBe(1)
  })

  it("自管理组指向自排程组：全局定时任务归自管理，给当前会话自己定时用 lk-harness-schedule", () => {
    const t = text(MAIN)
    const adminPart = t.slice(t.indexOf(ADMIN_GROUP), t.indexOf(SCHEDULE_GROUP))
    expect(adminPart).toContain("全局定时任务")
    expect(adminPart).toContain("用 lk-harness-schedule")
  })

  it("没挂自排程（没有会话 key）的主用户会话：自管理组不指向一个不存在的工具", () => {
    const t = text({ meta: { chatType: "p2p" }, includeAdmin: true })
    expect(t).toContain(ADMIN_GROUP)
    expect(t).not.toContain("lk-harness-schedule")
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
      expect(text(ctx).includes(SCHEDULE_GROUP), JSON.stringify(ctx)).toBe(mounted)
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
      headers: { "X-Harness-Session-Key": "ch_a%7Coc_g%3A%3Aproject_p1" },
    })
  })
  it("普通会话不挂", () => {
    expect(SCHEDULE_MCP_KEY in buildBuiltinMcpServers(19528, false, "interactive", false, "ch_a|oc_g")).toBe(false)
  })
})
