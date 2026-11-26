import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"
import type { SessionScheduleContext } from "../src/shared/session-schedule.js"

const state = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  writes: 0,
  lock: { port: 4321 } as { port: number } | null,
  posts: [] as { url: string; body: { taskId: string } }[],
  cancelResult: { ok: true } as { ok: boolean; error?: string },
  cancelThrows: null as Error | null,
  logs: [] as string[],
}))

vi.mock("../electron/cron-scheduler", () => ({
  readTasksFromFile: () => state.tasks.map((t) => ({ ...t })),
  writeTasksToFile: (tasks: ScheduledTask[]) => {
    state.writes++
    state.tasks = tasks
  },
}))
vi.mock("../electron/config-store", () => ({ getChannels: () => [{ id: "ch_app", enabled: true }] }))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: () => state.lock,
  // 模拟 daemon 的取消：成功就把这条排程从任务文件里去掉
  httpPost: async (url: string, body: { taskId: string }) => {
    state.posts.push({ url, body })
    if (state.cancelThrows) throw state.cancelThrows
    if (state.cancelResult.ok) state.tasks = state.tasks.filter((t) => t.id !== body.taskId)
    return state.cancelResult
  },
}))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: (msg: string) => { state.logs.push(msg) } }))

import { cancelAiTask, listBoundTasks, removeBoundTasks } from "../electron/session-tasks"

const SESSION = "ch_app|app_main::D:\\other"
const ctx: SessionScheduleContext = { sessionKey: SESSION }

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  ({ id: "t1", name: "任务", cron: "*/10 * * * *", content: "做点事", enabled: true, ...over })
const aiTask = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  task({ id: "ai-1", name: "AI 排程", createdBy: "ai", ownerSessionKey: SESSION, maxRuns: 5, ...over })
const dedicated = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  task({ id: "u-1", name: "每日新闻", independent: true, notify: "im", channelId: "ch_app", notifyChatId: SESSION, ...over })

beforeEach(() => {
  state.tasks = []
  state.writes = 0
  state.lock = { port: 4321 }
  state.posts = []
  state.cancelResult = { ok: true }
  state.cancelThrows = null
  state.logs = []
})

describe("listBoundTasks", () => {
  it("列出挂在会话上的任务名和来源，别的会话的不列", () => {
    state.tasks = [aiTask(), dedicated(), aiTask({ id: "ai-other", ownerSessionKey: "ch_app|app_main::D:\\else" })]
    expect(listBoundTasks([ctx])).toEqual([
      { id: "ai-1", name: "AI 排程", origin: "ai" },
      { id: "u-1", name: "每日新闻", origin: "user" },
    ])
  })
})

describe("removeBoundTasks", () => {
  it("AI 排程走 daemon 取消，设置页任务从文件里删，别的会话的任务原样保留", async () => {
    const other = dedicated({ id: "u-2", name: "别的", notifyChatId: "ch_app|app_main::D:\\else" })
    state.tasks = [aiTask(), dedicated(), other]

    const removed = await removeBoundTasks([ctx])

    expect(removed).toEqual([
      { id: "ai-1", name: "AI 排程", origin: "ai" },
      { id: "u-1", name: "每日新闻", origin: "user" },
    ])
    expect(state.posts).toEqual([{ url: "http://127.0.0.1:4321/api/ai-task-cancel", body: { taskId: "ai-1" } }])
    expect(state.tasks.map((t) => t.id)).toEqual(["u-2"])
  })

  it("已作废但还没被清理的 AI 排程也跟着删", async () => {
    state.tasks = [aiTask({ enabled: false })]
    expect((await removeBoundTasks([ctx])).map((t) => t.id)).toEqual(["ai-1"])
  })

  it("没有挂着的任务：不请求 daemon、不写文件", async () => {
    state.tasks = [aiTask({ ownerSessionKey: "ch_app|app_main::D:\\else" })]
    expect(await removeBoundTasks([ctx])).toEqual([])
    expect(state.posts).toEqual([])
    expect(state.writes).toBe(0)
  })

  it("取消失败的 AI 排程记日志、不算删掉，设置页任务照常删", async () => {
    state.cancelResult = { ok: false, error: "取消失败" }
    state.tasks = [aiTask(), dedicated()]

    const removed = await removeBoundTasks([ctx])

    expect(removed.map((t) => t.id)).toEqual(["u-1"])
    expect(state.tasks.map((t) => t.id)).toEqual(["ai-1"])
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toContain("AI 排程")
    expect(state.logs[0]).toContain("取消失败")
  })
})

describe("cancelAiTask", () => {
  it("排程不存在：报错，不请求 daemon", async () => {
    expect(await cancelAiTask("nope")).toEqual({ ok: false, error: "排程不存在（可能已结束并被清理）" })
    expect(state.posts).toEqual([])
  })

  it("设置页任务不当 AI 排程取消", async () => {
    state.tasks = [dedicated()]
    expect((await cancelAiTask("u-1")).ok).toBe(false)
    expect(state.tasks.map((t) => t.id)).toEqual(["u-1"])
  })

  it("daemon 不在：直接从文件里去掉", async () => {
    state.lock = null
    state.tasks = [aiTask(), dedicated()]
    expect(await cancelAiTask("ai-1")).toEqual({ ok: true })
    expect(state.posts).toEqual([])
    expect(state.tasks.map((t) => t.id)).toEqual(["u-1"])
  })

  it("请求 daemon 抛错：把原因带回去，不动文件", async () => {
    state.cancelThrows = new Error("timeout")
    state.tasks = [aiTask()]
    expect(await cancelAiTask("ai-1")).toEqual({ ok: false, error: "timeout" })
    expect(state.tasks.map((t) => t.id)).toEqual(["ai-1"])
  })
})
