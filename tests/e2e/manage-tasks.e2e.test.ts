/**
 * 端到端（真实 daemon 进程）：对话里让 AI 用 manage_tasks 建定时任务。
 *
 * 复现过的事故：用户在「应用内对话」里说「帮我建一个当前会话的定时任务」，AI 调 manage_tasks（independent=false）。
 * 工具没有通道参数，daemon 取「第一个通道」——恰好是飞书通道；非独立任务又是投给所属通道的主会话，
 * 于是每 5 分钟一条测试消息发进了飞书私聊，而 AI 还回复「已在当前会话中运行」。
 *
 * 这里用两个「应用内」通道（排第一的 ch_first 扮演那个飞书通道），走真实的 /mcp-admin 和手动触发，
 * 断言：任务挂在调用者所在的通道、消息进了调用者的会话、工具返回里如实说明去向。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configDir } from "../../src/shared/data-paths"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon({ leadingChannels: [{ id: "ch_first", name: "排第一的通道" }] })
})
afterEach(async () => { await d?.stop() })

/** 不会自己触发的 cron（1 月 1 日 0 点）：任务只由测试手动触发 */
const NEVER = "0 0 1 1 *"

const tasksFile = () => path.join(configDir(d.dataDir), "scheduled-tasks.json")
const readTasks = (): Array<Record<string, any>> => {
  try { return JSON.parse(fs.readFileSync(tasksFile(), "utf8")) } catch { return [] }
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

const ADD = { action: "add", name: "测试定时任务(当前会话)", cron: NEVER, content: "当前会话定时任务测试" }

describe("manage_tasks 建任务：所属通道 = 调用者所在的通道", () => {
  it("事故复现：调用者在 ch_test，排第一的是 ch_first——任务挂在 ch_test，触发后消息进调用者的会话，不进 ch_first", async () => {
    const out = await manageTasks(d.sessionKey, { ...ADD, independent: false })
    expect(out).toContain("已创建")

    const saved = readTasks()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ independent: false, channelId: "ch_test" })

    const r = await d.post("/api/task-trigger", { taskId: saved[0].id })
    expect(r.ok).toBe(true)
    const mine = await pollKey(d.sessionKey)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain("当前会话定时任务测试")
    expect(await pollKey(d.leading[0].sessionKey)).toEqual([])
  })

  it("工具返回如实说明去向：所属通道、主会话就是调用者自己的会话", async () => {
    const out = await manageTasks(d.sessionKey, { ...ADD, independent: false })
    expect(out).toContain("所属通道：「测试」（应用内对话）")
    expect(out).toContain("这个主会话就是你当前所在的会话")
    expect(out).not.toContain("⚠")
  })

  it("调用者是主会话之外的会话：任务仍挂在它所在的通道，但返回里明说「不是当前会话」并指向 schedule_create", async () => {
    const other = `ch_test|app_main::${path.join(d.dataDir, "other-ws")}`
    const out = await manageTasks(other, { ...ADD, independent: false })
    expect(readTasks()[0]).toMatchObject({ channelId: "ch_test" })
    expect(out).toContain("不是你当前所在的会话")
    expect(out).toContain("schedule_create")
  })

  it("调用者在排第一的通道：挂在它自己的通道，而不是别的通道", async () => {
    await manageTasks(d.leading[0].sessionKey, { ...ADD, independent: false })
    expect(readTasks()[0]).toMatchObject({ channelId: "ch_first" })
  })

  it("没有调用者身份（旧调用方）：退回第一个通道，且不对「是不是当前会话」下结论", async () => {
    const out = await manageTasks(undefined, { ...ADD, independent: false })
    expect(readTasks()[0]).toMatchObject({ channelId: "ch_first" })
    expect(out).toContain("所属通道：「排第一的通道」")
    expect(out).not.toContain("当前所在的会话")
  })

  it("独立运行（默认）：通知默认发到所属通道的主用户私聊，返回里不出现主会话的警告", async () => {
    const out = await manageTasks(d.sessionKey, { ...ADD })
    expect(readTasks()[0]).toMatchObject({ independent: true, channelId: "ch_test", notify: "im" })
    expect(out).toContain("通过「测试」发到主用户私聊")
    expect(out).not.toContain("⚠")
  })
})

describe("manage_tasks list / toggle：也带上去向", () => {
  it("list：每个任务写明去向，且按调用者判断是不是当前会话", async () => {
    await manageTasks(d.sessionKey, { ...ADD, independent: false })

    const fromOwner = await manageTasks(d.sessionKey, { action: "list" })
    expect(fromOwner).toContain("测试定时任务(当前会话)")
    expect(fromOwner).toContain("所属通道：「测试」")
    expect(fromOwner).toContain("这个主会话就是你当前所在的会话")

    const fromOther = await manageTasks(d.leading[0].sessionKey, { action: "list" })
    expect(fromOther).toContain("不是你当前所在的会话")
  })

  it("toggle：启用时再说一遍去向（防止闷头把一个会串台的任务打开），禁用时不啰嗦", async () => {
    await manageTasks(d.sessionKey, { ...ADD, independent: false })
    const id = readTasks()[0].id as string

    const off = await manageTasks(d.sessionKey, { action: "toggle", id })
    expect(off).toContain("已禁用")
    expect(off).not.toContain("所属通道")

    const on = await manageTasks(d.sessionKey, { action: "toggle", id })
    expect(on).toContain("已启用")
    expect(on).toContain("所属通道：「测试」")
  })
})
