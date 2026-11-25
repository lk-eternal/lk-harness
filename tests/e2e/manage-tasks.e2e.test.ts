/**
 * 端到端（真实 daemon 进程）：对话里让 AI 用 manage_tasks 建定时任务。
 *
 * manage_tasks 建的任务和设置页一样，只有「独立运行 + 通知我」一种：AI 不选独立 / 通知谁 / 模型，
 * 通道默认是调用者所在的通道，模型写入通道现在的供应商 + 主模型，应用内的结果发到这个任务专属的会话（第一次投递时建）。
 *
 * 复现过的事故：用户在「应用内对话」里让 AI 建任务，工具没有通道参数，daemon 取「第一个通道」——恰好是飞书通道，
 * 结果发进了飞书私聊，而 AI 还回复「已在当前会话中运行」。所以这里仍用两个「应用内」通道（排第一的 ch_first 扮演那个飞书通道），
 * 走真实的 /mcp-admin 和手动触发，断言：任务挂在调用者所在的通道、不再默认投进调用者自己的会话、工具返回里如实说明去向和模型。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configDir } from "../../src/shared/data-paths"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon({
    leadingChannels: [{ id: "ch_first", name: "排第一的通道" }],
    testChannelExtra: { agentResourceId: "res_main", model: "main-model", modelParams: "effort=high" },
  })
})
afterEach(async () => { await d?.stop() })

/** 不会自己触发的 cron（1 月 1 日 0 点）：任务只由测试手动触发 */
const NEVER = "0 0 1 1 *"

const tasksFile = () => path.join(configDir(d.dataDir), "scheduled-tasks.json")
const readTasks = (): Array<Record<string, any>> => {
  try { return JSON.parse(fs.readFileSync(tasksFile(), "utf8")) } catch { return [] }
}
const writeTasks = (tasks: Record<string, unknown>[]) => {
  fs.mkdirSync(configDir(d.dataDir), { recursive: true })
  fs.writeFileSync(tasksFile(), JSON.stringify(tasks))
}

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
const manageTasks = (invoker: string | undefined, args: Record<string, unknown>) => mcp("/mcp-admin", invoker, "manage_tasks", args)

/** 扮演 Agent 非阻塞领取某会话的消息 */
const pollKey = async (key: string): Promise<string[]> => {
  const r = await (await fetch(`${d.base}/api/poll-message?sessionKey=${encodeURIComponent(key)}&wait=false`)).json() as { messages?: Array<{ text: string }> }
  return (r.messages ?? []).map((m) => m.text)
}

const ADD = { action: "add", name: "测试定时任务", cron: NEVER, content: "定时任务测试内容" }

describe("manage_tasks 建任务：一律独立运行 + 通知我，通道 = 调用者所在的通道", () => {
  it("事故复现：调用者在 ch_test，排第一的是 ch_first——任务挂在 ch_test，由任务自己的会话执行，不进调用者的会话、不进 ch_first", async () => {
    const out = await manageTasks(d.sessionKey, ADD)
    expect(out).toContain("已创建")

    const saved = readTasks()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ independent: true, notify: "im", channelId: "ch_test" })

    const r = await d.post("/api/task-trigger", { taskId: saved[0].id })
    expect(r.ok).toBe(true)
    const own = await pollKey(saved[0].id)
    expect(own).toHaveLength(1)
    expect(own[0]).toContain("定时任务测试内容")
    expect(await pollKey(d.sessionKey)).toEqual([])
    expect(await pollKey(d.leading[0].sessionKey)).toEqual([])
  })

  it("AI 不选模型：写入通道现在的供应商 + 主模型 + 参数，返回里如实说明", async () => {
    const out = await manageTasks(d.sessionKey, ADD)
    expect(readTasks()[0]).toMatchObject({ resourceId: "res_main", model: "main-model", modelParams: "effort=high" })
    expect(out).toContain("模型：main-model")
  })

  it("通道没配主模型：不编模型，返回里说明运行时按通道默认", async () => {
    const out = await manageTasks(d.leading[0].sessionKey, ADD)
    const saved = readTasks()[0]
    expect(saved.model).toBeUndefined()
    expect(saved.resourceId).toBeUndefined()
    expect(out).toContain("模型：没有显式写入")
  })

  it("旧调用方还传 independent / notify：忽略，照样建成独立运行 + 通知我", async () => {
    await manageTasks(d.sessionKey, { ...ADD, independent: false, notify: "agent" })
    expect(readTasks()[0]).toMatchObject({ independent: true, notify: "im" })
  })

  it("应用内通道：建的时候不写会话（不再默认投给调用者自己的会话），第一次触发时建这个任务专属的会话", async () => {
    await manageTasks(d.sessionKey, ADD)
    expect(readTasks()[0].notifyChatId).toBeUndefined()

    await d.post("/api/task-trigger", { taskId: readTasks()[0].id })
    const key = readTasks()[0].notifyChatId as string
    expect(key).toMatch(/^ch_test\|app_main::.+temp_\d+$/)
    expect(key).not.toBe(d.sessionKey)
  })

  it("工具返回如实说明去向：通道、专属会话；不出现警告，也不说成「当前会话」", async () => {
    const out = await manageTasks(d.sessionKey, ADD)
    expect(out).toContain("通道：「测试」（应用内对话）")
    expect(out).toContain("通过「测试」发到这个任务专属的会话")
    expect(out).not.toContain("⚠")
    expect(out).not.toContain("当前所在的会话")
  })

  it("调用者是主会话之外的会话（别的目录）：任务照样挂在它所在的通道，结果不往它的会话里塞", async () => {
    const other = `ch_test|app_main::${path.join(d.dataDir, "other-ws")}`
    await manageTasks(other, ADD)
    expect(readTasks()[0]).toMatchObject({ channelId: "ch_test" })
    expect(readTasks()[0].notifyChatId).toBeUndefined()
  })

  it("调用者在排第一的通道：挂在它自己的通道，而不是别的通道", async () => {
    await manageTasks(d.leading[0].sessionKey, ADD)
    expect(readTasks()[0]).toMatchObject({ channelId: "ch_first" })
  })

  it("没有调用者身份（旧调用方）：退回第一个通道", async () => {
    const out = await manageTasks(undefined, ADD)
    expect(readTasks()[0]).toMatchObject({ channelId: "ch_first" })
    expect(out).toContain("通道：「排第一的通道」")
  })

  it("chat_id 只对飞书通道有效：应用内通道填了报错，不建任务", async () => {
    const out = await manageTasks(d.sessionKey, { ...ADD, chat_id: "oc_group" })
    expect(out).toContain("只对飞书通道有效")
    expect(readTasks()).toEqual([])
  })
})

describe("manage_tasks update：旧版交付方式的任务改成新方式", () => {
  const legacy = (extra: Record<string, unknown> = {}) => ({
    id: "old1", name: "旧任务", cron: NEVER, content: "旧内容", enabled: true, channelId: "ch_test",
    independent: false, notify: "agent", ...extra,
  })

  it("update 一个旧版任务：转成独立运行 + 通知我，补上通道的默认模型，并在返回里注明", async () => {
    writeTasks([legacy({ targetProjectId: "p_x", notifyChatId: d.sessionKey })])
    const out = await manageTasks(d.sessionKey, { action: "update", id: "old1", name: "旧任务改名" })
    expect(readTasks()[0]).toMatchObject({
      name: "旧任务改名", independent: true, notify: "im", resourceId: "res_main", model: "main-model",
    })
    expect(readTasks()[0].targetProjectId).toBeUndefined()
    expect(readTasks()[0].notifyChatId).toBeUndefined() // 通知 AI 的会话键对「通知我」没有意义
    expect(out).toContain("旧版交付方式")
  })

  it("update 已经是新方式的任务：不提旧版；已有的模型不被通道默认覆盖", async () => {
    writeTasks([legacy({ independent: true, notify: "im", model: "my-model", resourceId: "res_mine" })])
    const out = await manageTasks(d.sessionKey, { action: "update", id: "old1", cron: "5 9 * * *" })
    expect(readTasks()[0]).toMatchObject({ cron: "5 9 * * *", model: "my-model", resourceId: "res_mine" })
    expect(out).not.toContain("旧版交付方式")
  })

  it("应用内通道：update 传 chat_id 空串不会清掉任务的专属会话键", async () => {
    const key = `ch_test|app_main::${path.join(d.dataDir, "workspaces", "temp_1700000000999")}`
    writeTasks([legacy({ independent: true, notify: "im", model: "m", notifyChatId: key })])
    await manageTasks(d.sessionKey, { action: "update", id: "old1", chat_id: "" })
    expect(readTasks()[0].notifyChatId).toBe(key)
  })

  it("应用内通道：update 传非空 chat_id 报错，任务不变", async () => {
    writeTasks([legacy()])
    const out = await manageTasks(d.sessionKey, { action: "update", id: "old1", chat_id: "oc_group", name: "不该生效" })
    expect(out).toContain("只对飞书通道有效")
    expect(readTasks()[0]).toMatchObject({ name: "旧任务", independent: false, notify: "agent" })
  })
})

describe("manage_tasks list / toggle：也带上去向", () => {
  it("list：每个任务写明通道、去向和模型", async () => {
    await manageTasks(d.sessionKey, ADD)
    const out = await manageTasks(d.sessionKey, { action: "list" })
    expect(out).toContain("测试定时任务")
    expect(out).toContain("通道：「测试」")
    expect(out).toContain("这个任务专属的会话")
    expect(out).toContain("模型：main-model")
  })

  it("toggle：启用时再说一遍去向，禁用时不啰嗦；toggle 不改任务的交付方式", async () => {
    writeTasks([{ id: "old2", name: "旧任务2", cron: NEVER, content: "x", enabled: true, channelId: "ch_test", independent: false, notify: "agent" }])

    const off = await manageTasks(d.sessionKey, { action: "toggle", id: "old2" })
    expect(off).toContain("已禁用")
    expect(off).not.toContain("通道：")

    const on = await manageTasks(d.sessionKey, { action: "toggle", id: "old2" })
    expect(on).toContain("已启用")
    expect(on).toContain("通道：「测试」")
    expect(readTasks()[0]).toMatchObject({ independent: false, notify: "agent" })
  })
})
