import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { resetSessionFlow, type ResetSessionDeps } from "../electron/reset-session"
import type { QueuedMessageRef } from "../electron/send-queued-now"
import {
  claimSessionMessages,
  deleteQueueMessage as deleteFileQueueMessage,
  getDistinctSessions,
  getQueueLength,
  getQueueMessages as getFileQueueMessages,
  initFileQueue,
  pushToFileQueue,
} from "../src/file-queue"

/**
 * 「AI 调 reset 之后消息还在，又投递了重置的消息，一直重复」。
 *
 * 队列对「已投递给 Agent、还没确认处理完」的消息（processing）是至少一次投递：Agent 掉线后调度器看到它们还在，
 * 就拉起新 Agent 重投。重置不是掉线，却把 Agent 在处理的那条（「重置一下会话」）留在了 processing 里，
 * 新 Agent 一起来又领到它、又重置，用户新发的消息还被卷进同一批重投。
 * 这里锁住：重置把已投递给旧 Agent 的消息丢掉（先于停止），没投递的照留，别的会话不碰。
 */

const KEY = "ch_a|oc_111::D:\\ws\\a"
const msg = (fileId: string, status: "pending" | "processing", sessionKey: string = KEY): QueuedMessageRef => ({ fileId, status, sessionKey })

function setup(opts: {
  queue?: QueuedMessageRef[]
  running?: boolean
  getQueueError?: Error
  deleteResult?: (fileId: string) => boolean | Error
} = {}) {
  const events: string[] = []
  const queue = opts.queue ?? [msg("p1", "pending"), msg("c1", "processing")]
  const deps: ResetSessionDeps = {
    getQueue: vi.fn(async () => {
      if (opts.getQueueError) throw opts.getQueueError
      return queue
    }),
    deleteMessage: vi.fn(async (id: string) => {
      const r = opts.deleteResult?.(id) ?? true
      if (r instanceof Error) throw r
      if (r) events.push(`delete:${id}`)
      return r
    }),
    normalizeKey: (k) => (k ?? "").toLowerCase(),
    isRunning: vi.fn(() => opts.running ?? true),
    stopAgent: vi.fn(async () => { events.push("stop") }),
    resetContext: vi.fn(() => { events.push("reset-context") }),
    log: vi.fn(),
  }
  return { deps, events }
}

describe("resetSessionFlow：丢已投递的，先丢再停再清上下文", () => {
  it("顺序：丢掉已投递的消息 → 停 Agent → 清上下文（旧 Agent 一退出调度器就会看队列，停完再丢来不及）", async () => {
    const { deps, events } = setup()
    expect(await resetSessionFlow(KEY, deps)).toEqual({ stopped: true, dropped: 1 })
    expect(events).toEqual(["delete:c1", "stop", "reset-context"])
    expect(deps.stopAgent).toHaveBeenCalledWith(KEY)
    expect(deps.resetContext).toHaveBeenCalledWith(KEY)
  })

  it("只丢已投递（processing）的：还在排队（pending）的是重置之后才该处理的，留着", async () => {
    const { deps, events } = setup({ queue: [msg("p1", "pending"), msg("p2", "pending"), msg("c1", "processing"), msg("c2", "processing")] })
    expect((await resetSessionFlow(KEY, deps)).dropped).toBe(2)
    expect(events.filter((e) => e.startsWith("delete:"))).toEqual(["delete:c1", "delete:c2"])
    expect(deps.deleteMessage).not.toHaveBeenCalledWith("p1")
    expect(deps.deleteMessage).not.toHaveBeenCalledWith("p2")
  })

  it("别的会话的已投递消息不碰", async () => {
    const other = "ch_a|oc_222::D:\\ws\\b"
    const { deps, events } = setup({ queue: [msg("c1", "processing"), msg("o1", "processing", other), msg("o2", "pending", other)] })
    expect((await resetSessionFlow(KEY, deps)).dropped).toBe(1)
    expect(events).toEqual(["delete:c1", "stop", "reset-context"])
  })

  it("会话键写法不同（大小写）也认得是同一个会话", async () => {
    const { deps } = setup({ queue: [msg("c1", "processing", KEY.toUpperCase())] })
    expect((await resetSessionFlow(KEY, deps)).dropped).toBe(1)
  })

  it("Agent 没在跑（掉线后留下的残留）：照样丢残留、清上下文，不去停", async () => {
    const { deps, events } = setup({ running: false })
    expect(await resetSessionFlow(KEY, deps)).toEqual({ stopped: false, dropped: 1 })
    expect(deps.stopAgent).not.toHaveBeenCalled()
    expect(events).toEqual(["delete:c1", "reset-context"])
  })

  it("没有已投递的消息：不丢任何东西，停和清上下文照做", async () => {
    const { deps, events } = setup({ queue: [msg("p1", "pending")] })
    expect(await resetSessionFlow(KEY, deps)).toEqual({ stopped: true, dropped: 0 })
    expect(events).toEqual(["stop", "reset-context"])
    expect(deps.log).not.toHaveBeenCalled()
  })

  it("读不到队列（daemon 不可达）：不挡住重置，停和清上下文照做，并留一条警告", async () => {
    const { deps, events } = setup({ getQueueError: new Error("ECONNREFUSED") })
    expect(await resetSessionFlow(KEY, deps)).toEqual({ stopped: true, dropped: 0 })
    expect(events).toEqual(["stop", "reset-context"])
    expect(deps.log).toHaveBeenCalledWith("WARN", expect.stringContaining("ECONNREFUSED"))
  })

  it("某一条删不掉（抛错或返回 false）：不挡住别的，只统计删掉的", async () => {
    const { deps, events } = setup({
      queue: [msg("c1", "processing"), msg("c2", "processing"), msg("c3", "processing")],
      deleteResult: (id) => (id === "c1" ? new Error("EBUSY") : id === "c2" ? false : true),
    })
    expect(await resetSessionFlow(KEY, deps)).toEqual({ stopped: true, dropped: 1 })
    expect(events).toEqual(["delete:c3", "stop", "reset-context"])
  })

  it("丢掉了消息才记日志，说明丢了几条", async () => {
    const { deps } = setup({ queue: [msg("c1", "processing"), msg("c2", "processing")] })
    await resetSessionFlow(KEY, deps)
    expect(deps.log).toHaveBeenCalledWith("INFO", expect.stringContaining("2 条"))
  })
})

// ── 和真实队列一起：把用户看到的循环在数据层复现出来 ─────────────────────────

describe("真实文件队列：重置后不再重投", () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-reset-session-"))
    process.env.APP_DATA_DIR = dataDir
    initFileQueue()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** 生产里的接线：队列读写走真实文件队列，停 Agent / 清上下文只记一笔 */
  function realDeps(events: string[]): ResetSessionDeps {
    return {
      getQueue: async () => getFileQueueMessages(),
      deleteMessage: async (fileId) => deleteFileQueueMessage(fileId),
      normalizeKey: (k) => k ?? "",
      isRunning: () => true,
      stopAgent: async () => { events.push("stop") },
      resetContext: () => { events.push("reset-context") },
      log: () => undefined,
    }
  }

  /** Agent 领走「重置一下会话」，在回复之前调了 reset（还没挂 poll，所以没确认）：这是出问题的现场 */
  function agentIsHandlingResetRequest(): void {
    expect(pushToFileQueue("重置一下会话", "om_reset_req", "feishu", KEY)).toBe(true)
    expect(claimSessionMessages(KEY).map((m) => m.messageId)).toEqual(["om_reset_req"])
  }

  it("问题本身：不处理的话，调度器看它还在会重新拉起，新消息一来两条一起重投", () => {
    agentIsHandlingResetRequest()
    // 调度器按「有没有未处理完的消息」决定要不要拉起 Agent：processing 也算
    expect(getDistinctSessions().map((s) => s.sessionKey)).toEqual([KEY])
    expect(pushToFileQueue("帮我创建一个项目", "om_new_req", "feishu", KEY)).toBe(true)
    expect(claimSessionMessages(KEY).map((m) => m.messageId)).toEqual(["om_reset_req", "om_new_req"])
  })

  it("重置后：队列里没有它了，调度器不会白拉起，新会话只领到之后发的消息", async () => {
    agentIsHandlingResetRequest()
    const events: string[] = []
    expect(await resetSessionFlow(KEY, realDeps(events))).toEqual({ stopped: true, dropped: 1 })

    expect(getQueueLength(KEY)).toBe(0)
    expect(getDistinctSessions()).toEqual([])
    expect(events).toEqual(["stop", "reset-context"])

    expect(pushToFileQueue("帮我创建一个项目", "om_new_req", "feishu", KEY)).toBe(true)
    expect(claimSessionMessages(KEY).map((m) => m.messageId)).toEqual(["om_new_req"])
  })

  it("重置时还在排队、没投递给旧 Agent 的消息：留着，新会话照常领到", async () => {
    agentIsHandlingResetRequest()
    expect(pushToFileQueue("顺便帮我建个项目", "om_queued", "feishu", KEY)).toBe(true)

    expect((await resetSessionFlow(KEY, realDeps([]))).dropped).toBe(1)

    expect(getDistinctSessions().map((s) => s.sessionKey)).toEqual([KEY])
    expect(claimSessionMessages(KEY).map((m) => m.messageId)).toEqual(["om_queued"])
  })

  it("飞书对「重置一下会话」重推同一个 id：认得出是处理过的，不会又排进来", async () => {
    agentIsHandlingResetRequest()
    await resetSessionFlow(KEY, realDeps([]))
    expect(pushToFileQueue("重置一下会话", "om_reset_req", "feishu", KEY)).toBe(false)
    expect(getQueueLength(KEY)).toBe(0)
  })

  it("别的会话正在处理的消息不受影响", async () => {
    const other = "ch_a|oc_222::D:\\ws\\b"
    agentIsHandlingResetRequest()
    expect(pushToFileQueue("别人的活", "om_other", "feishu", other)).toBe(true)
    expect(claimSessionMessages(other).map((m) => m.messageId)).toEqual(["om_other"])

    await resetSessionFlow(KEY, realDeps([]))

    expect(getQueueLength(other)).toBe(1)
    expect(getDistinctSessions().map((s) => s.sessionKey)).toEqual([other])
  })
})
