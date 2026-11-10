/**
 * 端到端（真实 daemon 进程）：定时任务结果投递 + AI 自排程。
 *
 * 这条链路横跨「任务文件 → 触发 → 文件队列 → Agent 会话 → MCP 工具 → 通知目标」，单测只能分别覆盖纯规则；
 * 这里用真实 daemon、真实 HTTP / MCP 请求把它们串起来，Agent 的角色由测试扮演（领取消息、调工具、确认完成）。
 *
 * 通道只有一个「应用内」通道 ch_test：IM 通知落在应用聊天记录里，能直接断言。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configDir } from "../../src/shared/data-paths"
import { aiScheduleStateFile, readAiScheduleRuns } from "../../src/shared/ai-schedule-state"
import { initProjectStore, saveProject } from "../../src/shared/project-store"
import { projectSessionKey, type Project } from "../../src/shared/project-types"
import { startIsolatedDaemon, waitFor, sleep, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon()
  initProjectStore(d.dataDir)
})
afterEach(async () => { await d?.stop() })

// ── 测试替身：任务文件 / 项目 / Agent 的动作 ─────────────────────────

/** 不会自己触发的 cron（1 月 1 日 0 点）：任务只由测试手动触发 */
const NEVER = "0 0 1 1 *"

const tasksFile = () => path.join(configDir(d.dataDir), "scheduled-tasks.json")
const writeTasks = (tasks: Record<string, unknown>[]) => {
  fs.mkdirSync(configDir(d.dataDir), { recursive: true })
  fs.writeFileSync(tasksFile(), JSON.stringify(tasks))
}
const readTasks = (): Array<Record<string, any>> => {
  try { return JSON.parse(fs.readFileSync(tasksFile(), "utf8")) } catch { return [] }
}
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `任务-${id}`, cron: NEVER, content: `内容-${id}`, enabled: true, independent: true, channelId: "ch_test", ...extra,
})

const GROUP = "ch_test|app_group"
const addProject = (id: string, status: Project["status"] = "active", name = `项目${id}`): string => {
  const sessionKey = projectSessionKey(GROUP, id)
  saveProject({
    id, name, goal: "g", repoPath: "", baseBranch: "main", featureBranch: "", worktreePath: "",
    workspaceType: "plain", status, sessionKey, groupChatId: GROUP, createdAt: Date.now(), updatedAt: Date.now(),
  })
  return sessionKey
}

/** 扮演 Agent 领取某会话的消息（非阻塞：领取不删，要 confirm 才算处理完） */
const pollKey = async (key: string): Promise<string[]> => {
  const r = await (await fetch(`${d.base}/api/poll-message?sessionKey=${encodeURIComponent(key)}&wait=false`)).json() as { messages?: Array<{ text: string }> }
  return (r.messages ?? []).map((m) => m.text)
}
/** 扮演「回合成功结束」：确认该会话已领取的消息 */
const confirm = (key: string) => d.post("/api/confirm-claimed", { session_key: key })
const trigger = (taskId: string) => d.post("/api/task-trigger", { taskId })

/** 调 MCP 工具（无状态 streamable HTTP，直接发 JSON-RPC），invoker 走和真实 Agent 一样的请求头 */
async function mcp(endpoint: string, invoker: string | undefined, tool: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(d.base + endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(invoker ? { "X-Harness-Session-Key": invoker } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  })
  const raw = await res.text()
  const line = raw.split("\n").find((l) => l.startsWith("data:"))
  const payload = JSON.parse(line ? line.slice(5).trim() : raw)
  if (payload.error) throw new Error(`MCP 错误: ${JSON.stringify(payload.error)}`)
  return (payload.result.content as Array<{ text: string }>).map((c) => c.text).join("\n")
}
const sendResult = (taskId: string, args: Record<string, unknown>) => mcp("/mcp-task", taskId, "send_result", args)
const schedule = (invoker: string | undefined, tool: string, args: Record<string, unknown> = {}) => mcp("/mcp-schedule", invoker, tool, args)

/**
 * 应用聊天记录里有没有出现某段文字（应用内通道的「IM 通知」落在这里）。
 * 发给聊天（chatKey）的文字记在以 chatKey 为 key 的记录里，所以主会话和 chatKey 两处都看。
 */
const chatHas = async (needle: string) => {
  for (const sessionKey of [d.sessionKey, "ch_test|app_main"]) {
    const r = await d.post("/api/app-chat/history", { sessionKey })
    if (JSON.stringify(r.items ?? []).includes(needle)) return true
  }
  return false
}

// ── 手动触发：路由 ───────────────────────────────────────────────────

describe("手动触发（立即执行）：任务投到绑定的 Agent 会话", () => {
  it("非独立运行 + 不指定项目：内容直接进主会话队列", async () => {
    writeTasks([task("t-main", { independent: false })])
    expect((await trigger("t-main")).ok).toBe(true)
    const msgs = await pollKey(d.sessionKey)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("内容-t-main")
  })

  it("非独立运行 + 指定项目：进项目会话队列，主会话不受打扰", async () => {
    const pk = addProject("p1")
    writeTasks([task("t-proj", { independent: false, targetProjectId: "p1" })])
    expect((await trigger("t-proj")).ok).toBe(true)
    const msgs = await pollKey(pk)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("内容-t-proj")
    expect(await pollKey(d.sessionKey)).toEqual([])
  })

  it("目标项目已暂停：不投递，直接告诉用户原因", async () => {
    const pk = addProject("p-paused", "paused", "暂停的项目")
    writeTasks([task("t-paused", { independent: false, targetProjectId: "p-paused" })])
    const r = await trigger("t-paused")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("已暂停")
    expect(await pollKey(pk)).toEqual([])
  })

  it("目标项目已不存在：报错而不是悄悄丢", async () => {
    writeTasks([task("t-gone", { independent: false, targetProjectId: "nope" })])
    const r = await trigger("t-gone")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("不存在")
  })

  it("独立运行：进任务自己的会话队列（key = 任务 id），不进主会话", async () => {
    writeTasks([task("t-ind", { notify: "none" })])
    expect((await trigger("t-ind")).ok).toBe(true)
    const msgs = await pollKey("t-ind")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("内容-t-ind")
    expect(await pollKey(d.sessionKey)).toEqual([])
  })

  it("任务不存在：报错", async () => {
    writeTasks([])
    const r = await trigger("ghost")
    expect(r.ok).toBe(false)
  })

  it("通知到 IM，但发送通道不存在：不启动任务（跑了结果也送不到）", async () => {
    writeTasks([task("t-nochan", { notify: "im", notifyChannelId: "ch_missing" })])
    const r = await trigger("t-nochan")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("结果发送目标")
    expect(await pollKey("t-nochan")).toEqual([])
  })
})

// ── send_result：独立任务交付结果 ────────────────────────────────────

describe("send_result：独立任务交付结果", () => {
  it("不通知：接受并记账，但哪儿都不发；重复提交被拒", async () => {
    writeTasks([task("r-none", { notify: "none" })])
    await trigger("r-none")
    expect(await sendResult("r-none", { text: "结论 N" })).toContain("结果已处理")
    expect(await sendResult("r-none", { text: "再来一次" })).toContain("已经提交过")
    expect(await pollKey(d.sessionKey)).toEqual([])
    expect(await chatHas("结论 N")).toBe(false)
  })

  it("通知到 Agent 会话（主会话）：结果作为一条汇报消息进主会话队列", async () => {
    writeTasks([task("r-agent", { notify: "agent" })])
    await trigger("r-agent")
    expect(await sendResult("r-agent", { text: "发现 3 个新缺陷" })).toContain("结果已处理")
    const msgs = await pollKey(d.sessionKey)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("⏰ 定时任务「任务-r-agent」汇报")
    expect(msgs[0]).toContain("发现 3 个新缺陷")
  })

  it("通知到 Agent 会话（项目会话）：进项目队列", async () => {
    const pk = addProject("p-res")
    writeTasks([task("r-proj", { notify: "agent", targetProjectId: "p-res" })])
    await trigger("r-proj")
    await sendResult("r-proj", { text: "项目内的发现" })
    const msgs = await pollKey(pk)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("项目内的发现")
    expect(await pollKey(d.sessionKey)).toEqual([])
  })

  it("通知到 Agent 会话但项目已暂停：send_result 失败并如实告诉 AI；失败不算提交，条件恢复后能重试", async () => {
    const pk = addProject("p-pause2")
    writeTasks([task("r-pause", { notify: "agent", targetProjectId: "p-pause2" })])
    await trigger("r-pause")
    addProject("p-pause2", "paused")
    const out = await sendResult("r-pause", { text: "x" })
    expect(out).toContain("[send_failed]")
    expect(out).toContain("已暂停")
    expect(await pollKey(pk)).toEqual([])

    addProject("p-pause2", "active")
    expect(await sendResult("r-pause", { text: "恢复后重试" })).toContain("结果已处理")
    const msgs = await pollKey(pk)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("恢复后重试")
  })

  it("通知到 IM（不填聊天 ID）：发到所属通道主用户的私聊", async () => {
    writeTasks([task("r-im", { notify: "im" })])
    await trigger("r-im")
    expect(await sendResult("r-im", { text: "IM 结论" })).toContain("结果已处理")
    expect(await waitFor(() => chatHas("IM 结论"))).toBe(true)
    expect(await chatHas("任务-r-im")).toBe(true)
  })

  it("旧任务（没有 notify 字段）：有聊天 ID 视为通知到 IM，照常送达", async () => {
    writeTasks([task("r-legacy", { notifyChatId: "app_main" })])
    await trigger("r-legacy")
    expect(await sendResult("r-legacy", { text: "旧任务结论" })).toContain("结果已处理")
    expect(await waitFor(() => chatHas("旧任务结论"))).toBe(true)
  })

  it("quiet：记账但不发任何消息", async () => {
    writeTasks([task("r-quiet", { notify: "agent" })])
    await trigger("r-quiet")
    expect(await sendResult("r-quiet", { quiet: true })).toContain("没有需要通知")
    expect(await pollKey(d.sessionKey)).toEqual([])
    expect(await sendResult("r-quiet", { text: "补一条" })).toContain("已经提交过")
  })

  it("既没 text 也不是 quiet：拒绝，AI 还能重试", async () => {
    writeTasks([task("r-empty", { notify: "agent" })])
    await trigger("r-empty")
    expect(await sendResult("r-empty", {})).toContain("[send_failed]")
    expect(await sendResult("r-empty", { text: "   " })).toContain("[send_failed]")
    expect(await sendResult("r-empty", { text: "这次有了" })).toContain("结果已处理")
  })

  it("不是独立任务的会话（主会话 / 非独立任务）调用：拒绝", async () => {
    writeTasks([task("r-dep", { independent: false })])
    expect(await sendResult(d.sessionKey, { text: "x" })).toContain("只能在独立运行的定时任务会话里调用")
    expect(await sendResult("r-dep", { text: "x" })).toContain("只能在独立运行的定时任务会话里调用")
    expect(await mcp("/mcp-task", undefined, "send_result", { text: "x" })).toContain("[send_failed]")
  })

  it("下一次运行重新计数：上一次提交过不影响下一次", async () => {
    writeTasks([task("r-twice", { notify: "agent" })])
    await trigger("r-twice")
    await pollKey("r-twice")
    expect(await sendResult("r-twice", { text: "第一次" })).toContain("结果已处理")
    await confirm("r-twice") // 第一次运行结束
    await pollKey(d.sessionKey); await confirm(d.sessionKey)

    await trigger("r-twice")
    await pollKey("r-twice")
    expect(await sendResult("r-twice", { text: "第二次" })).toContain("结果已处理")
    // 同一次运行没结束就再提交仍然被拒
    expect(await sendResult("r-twice", { text: "第二次补充" })).toContain("已经提交过")
  })
})

// ── 兜底：AI 没提交结果 ──────────────────────────────────────────────

describe("兜底提示：独立任务跑完却没有提交结果", () => {
  /** 扮演一次回合：领取任务消息 → （可选：提交结果）→ 回合成功结束 */
  const runTurn = async (id: string, submit?: Record<string, unknown>) => {
    await trigger(id)
    expect((await pollKey(id)).length).toBeGreaterThan(0)
    if (submit) await sendResult(id, submit)
    await confirm(id)
  }

  it("通知到 Agent：没提交 = 没有要汇报的，不唤醒目标会话（事故：每小时巡检无事也被「没有提交结果」打扰）", async () => {
    writeTasks([task("f-agent", { notify: "agent" })])
    await runTurn("f-agent")
    await sleep(800)
    expect(await pollKey(d.sessionKey)).toEqual([])
    expect(await chatHas("没有提交结果")).toBe(false)
  })

  it("通知到 Agent：没提交之后下一次有结果，照常送达（不会因为上一次静默而吞掉）", async () => {
    writeTasks([task("f-agent-next", { notify: "agent" })])
    await runTurn("f-agent-next")
    await runTurn("f-agent-next", { text: "这次有缺陷" })
    const msgs = await pollKey(d.sessionKey)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("这次有缺陷")
  })

  it("通知到 IM：没提交 → 聊天里收到提示", async () => {
    writeTasks([task("f-im", { notify: "im" })])
    await runTurn("f-im")
    expect(await waitFor(() => chatHas("没有提交结果"))).toBe(true)
  })

  it("不通知：没提交也不发任何东西", async () => {
    writeTasks([task("f-none", { notify: "none" })])
    await runTurn("f-none")
    await sleep(800)
    expect(await pollKey(d.sessionKey)).toEqual([])
    expect(await chatHas("没有提交结果")).toBe(false)
  })

  it("已提交结果：不发兜底（结果本身之外没有多余消息）", async () => {
    writeTasks([task("f-done", { notify: "agent" })])
    await runTurn("f-done", { text: "有结论" })
    await sleep(800)
    const msgs = await pollKey(d.sessionKey)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("有结论")
  })

  it("quiet 提交：不发兜底", async () => {
    writeTasks([task("f-quiet", { notify: "agent" })])
    await runTurn("f-quiet", { quiet: true })
    await sleep(800)
    expect(await pollKey(d.sessionKey)).toEqual([])
  })
})

// ── AI 自排程工具 ────────────────────────────────────────────────────

describe("AI 自排程工具（/mcp-schedule）", () => {
  const OK = { name: "盯缺陷", prompt: "查一下 bug 表有没有新缺陷，有就汇报，没有就 quiet", every_minutes: 30, max_runs: 3 }

  it("主会话创建：落盘为 AI 排程，绑定调用它的会话，默认「新 Agent 执行、结果投回本会话」", async () => {
    const out = await schedule(d.sessionKey, "schedule_create", OK)
    expect(out).toContain("已创建排程")
    const saved = readTasks()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      createdBy: "ai", name: "盯缺陷", independent: true, notify: "agent", maxRuns: 3, enabled: true, cron: "*/30 * * * *",
    })
    expect(saved[0].ownerSessionKey).toContain("app_main")
    expect(saved[0].targetProjectId).toBeUndefined()
    expect(await schedule(d.sessionKey, "schedule_list")).toContain("盯缺陷")
  })

  it("项目会话创建：投回该项目会话（targetProjectId）", async () => {
    const pk = addProject("p-ai")
    expect(await schedule(pk, "schedule_create", OK)).toContain("已创建排程")
    expect(readTasks()[0]).toMatchObject({ createdBy: "ai", targetProjectId: "p-ai", notify: "agent" })
  })

  it("mode=session：到点提醒本会话自己做（非独立）", async () => {
    await schedule(d.sessionKey, "schedule_create", { ...OK, mode: "session" })
    expect(readTasks()[0]).toMatchObject({ independent: false })
    expect(readTasks()[0].notify).toBeUndefined()
  })

  it("护栏：太密 / 没有次数或过期上限 / cron 与 every_minutes 同给 / 无效 cron 都拒绝，不落盘", async () => {
    expect(await schedule(d.sessionKey, "schedule_create", { ...OK, every_minutes: 1 })).toContain("[schedule_failed]")
    expect(await schedule(d.sessionKey, "schedule_create", { name: "x", prompt: "y", every_minutes: 30 })).toContain("[schedule_failed]")
    expect(await schedule(d.sessionKey, "schedule_create", { ...OK, cron: "*/30 * * * *" })).toContain("[schedule_failed]")
    expect(await schedule(d.sessionKey, "schedule_create", { ...OK, every_minutes: undefined, cron: "* * * * * *" })).toContain("[schedule_failed]")
    expect(readTasks()).toEqual([])
  })

  it("每个会话最多 5 个：第 6 个被拒；取消一个后又能建", async () => {
    for (let i = 1; i <= 5; i++) {
      expect(await schedule(d.sessionKey, "schedule_create", { ...OK, name: `排程${i}` })).toContain("已创建排程")
    }
    const sixth = await schedule(d.sessionKey, "schedule_create", { ...OK, name: "排程6" })
    expect(sixth).toContain("[schedule_failed]")
    expect(sixth).toContain("上限")
    expect(readTasks()).toHaveLength(5)

    const id = readTasks()[0].id as string
    expect(await schedule(d.sessionKey, "schedule_cancel", { id })).toContain("已取消")
    expect(readTasks().some((t) => t.id === id)).toBe(false)
    expect(await schedule(d.sessionKey, "schedule_create", { ...OK, name: "排程6" })).toContain("已创建排程")
  })

  it("身份：只有主用户主会话 / 活跃项目会话能排程；定时任务会话、别的聊天、暂停的项目、没有身份都不行", async () => {
    const paused = addProject("p-ai-paused", "paused")
    addProject("p-ai-done", "done")
    writeTasks([task("some-task")])
    const wsDir = d.wsDir
    const cases: Array<[string, string | undefined]> = [
      ["没有身份", undefined],
      ["定时任务会话", "some-task"],
      ["别的聊天的会话", `ch_test|app_other::${wsDir}`],
      ["主用户私聊但别的工作目录", `ch_test|app_main::${path.join(d.dataDir, "elsewhere")}`],
      ["暂停的项目", paused],
      ["已完成的项目", projectSessionKey(GROUP, "p-ai-done")],
      ["不存在的项目", projectSessionKey(GROUP, "p-none")],
    ]
    for (const [label, invoker] of cases) {
      const out = await schedule(invoker, "schedule_create", OK)
      expect(out, label).toContain("[schedule_failed]")
    }
    expect(readTasks().filter((t) => t.createdBy === "ai")).toEqual([])
  })

  it("list / cancel 只看得到自己会话的排程；不能取消别人的，也不能取消用户建的任务", async () => {
    const pk = addProject("p-iso")
    await schedule(d.sessionKey, "schedule_create", { ...OK, name: "主会话的" })
    await schedule(pk, "schedule_create", { ...OK, name: "项目的" })
    const mainId = readTasks().find((t) => t.name === "主会话的")!.id as string
    const projId = readTasks().find((t) => t.name === "项目的")!.id as string
    writeTasks([...readTasks(), task("user-task")])

    const mainList = await schedule(d.sessionKey, "schedule_list")
    expect(mainList).toContain("主会话的")
    expect(mainList).not.toContain("项目的")
    expect(mainList).not.toContain("user-task")

    expect(await schedule(d.sessionKey, "schedule_cancel", { id: projId })).toContain("[schedule_failed]")
    expect(await schedule(d.sessionKey, "schedule_cancel", { id: "user-task" })).toContain("[schedule_failed]")
    expect(readTasks().map((t) => t.id).sort()).toEqual([mainId, projId, "user-task"].sort())
  })

  it("取消正在运行的排程：先停用、不直接删（否则还在跑的 Agent 提交结果时认不出自己）", async () => {
    await schedule(d.sessionKey, "schedule_create", OK)
    const id = readTasks()[0].id as string
    expect((await trigger(id)).ok).toBe(true) // 上一次运行进行中
    const out = await schedule(d.sessionKey, "schedule_cancel", { id })
    expect(out).toContain("已取消")
    expect(out).toContain("还没结束")
    expect(readTasks().find((t) => t.id === id)).toMatchObject({ enabled: false })
    // 还在跑的 Agent 仍然能交结果
    expect(await sendResult(id, { text: "取消前就在跑的那次" })).toContain("结果已处理")
    const msgs = await pollKey(d.sessionKey)
    expect(msgs.some((t) => t.includes("取消前就在跑的那次"))).toBe(true)
  })

  it("设置页取消（/api/ai-task-cancel）：能取消 AI 排程；对用户建的任务无效，绝不误删", async () => {
    await schedule(d.sessionKey, "schedule_create", OK)
    const aiId = readTasks()[0].id as string
    writeTasks([...readTasks(), task("user-keep")])

    expect((await d.post("/api/ai-task-cancel", { taskId: "user-keep" })).ok).toBe(false)
    expect(readTasks().some((t) => t.id === "user-keep")).toBe(true)

    expect((await d.post("/api/ai-task-cancel", { taskId: aiId })).ok).toBe(true)
    expect(readTasks().map((t) => t.id)).toEqual(["user-keep"])
  })
})

// ── AI 排程触发：关卡 ─────────────────────────────────────────────────

describe("AI 排程触发：次数 / 过期 / 合并 / 目标失效", () => {
  /** AI 排程写进文件（工具有 ≥5 分钟的限制，这里绕过它用每秒触发，缩短等待） */
  const aiTask = (id: string, extra: Record<string, unknown> = {}) => task(id, {
    cron: "* * * * * *", createdBy: "ai", createdAt: Date.now(), ownerSessionKey: d.sessionKey,
    independent: false, maxRuns: 2, ...extra,
  })
  const stateRuns = () => readAiScheduleRuns(aiScheduleStateFile(d.dataDir))

  it("提醒型：到次数后作废并清理；中间没处理完的提醒不叠加", async () => {
    writeTasks([aiTask("ai-limit")])

    // 提醒一直没被会话处理时，不叠第二条
    expect(await waitFor(async () => (await pollKey(d.sessionKey)).length > 0, 10_000, 250)).toBe(true)
    await sleep(2500)
    const pending = await pollKey(d.sessionKey)
    expect(pending.filter((t) => t.includes("⏰ 定时任务"))).toHaveLength(1)
    expect(stateRuns()["ai-limit"]).toBe(1)

    // 处理掉再等：第 2 次触发，之后到上限被清理
    const seen: string[] = [...pending]
    await confirm(d.sessionKey)
    const retired = await waitFor(async () => {
      const msgs = await pollKey(d.sessionKey)
      if (msgs.length) { seen.push(...msgs); await confirm(d.sessionKey) }
      return !readTasks().some((t) => t.id === "ai-limit")
    }, 20_000, 300)
    expect(retired).toBe(true)
    const reminders = seen.filter((t) => t.includes("⏰ 定时任务"))
    expect(reminders).toHaveLength(2)
    expect(reminders[0]).toContain("第 1/2 次")
    expect(reminders[1]).toContain("第 2/2 次")
    expect(stateRuns()["ai-limit"]).toBeUndefined()
  })

  it("已过期：一次都不触发，直接清理", async () => {
    writeTasks([aiTask("ai-expired", { expiresAt: Date.now() - 1000, maxRuns: undefined })])
    expect(await waitFor(() => !readTasks().some((t) => t.id === "ai-expired"), 15_000, 300)).toBe(true)
    expect(await pollKey(d.sessionKey)).toEqual([])
  })

  it("目标项目已完成：作废清理；已暂停：保留但不投递", async () => {
    const donePk = addProject("p-done-ai", "done")
    const pausedPk = addProject("p-paused-ai", "paused")
    writeTasks([
      aiTask("ai-target-done", { targetProjectId: "p-done-ai" }),
      aiTask("ai-target-paused", { targetProjectId: "p-paused-ai" }),
    ])
    expect(await waitFor(() => !readTasks().some((t) => t.id === "ai-target-done"), 15_000, 300)).toBe(true)
    await sleep(1500)
    expect(readTasks().map((t) => t.id)).toEqual(["ai-target-paused"])
    expect(await pollKey(donePk)).toEqual([])
    expect(await pollKey(pausedPk)).toEqual([])
  })

  it("用户建的任务不受 AI 关卡影响：不限次数、不会被清理", async () => {
    writeTasks([task("user-every-sec", { cron: "* * * * * *", independent: false })])
    expect(await waitFor(async () => (await pollKey(d.sessionKey)).length > 0, 10_000, 250)).toBe(true)
    await confirm(d.sessionKey)
    await sleep(2500)
    expect(readTasks().some((t) => t.id === "user-every-sec")).toBe(true)
    expect(stateRuns()["user-every-sec"]).toBeUndefined()
  })
})
