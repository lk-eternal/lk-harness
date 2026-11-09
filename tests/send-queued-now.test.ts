import { describe, expect, it, vi } from "vitest"
import type { InterruptTurnResult } from "../electron/agent-engine/types"
import {
  interruptRunningEngine, sendQueuedNowFlow,
  type InterruptibleEngine, type QueuedMessageRef, type SendQueuedNowDeps,
} from "../electron/send-queued-now"

/**
 * 「立即发送」的调度流程：软打断优先，不适用/超时才退回「停止 + 重新拉起」。
 * 用事件流水断言顺序（删旧消息 → 停 → 调度），因为顺序错了新 Agent 会把没做完的活再投递一遍。
 */

const KEY = "app_x|chat1::D:/ws"
const msg = (fileId: string, status: "pending" | "processing", sessionKey: string = KEY): QueuedMessageRef => ({ fileId, status, sessionKey })

function setup(opts: {
  queue?: QueuedMessageRef[]
  running?: boolean
  interrupt?: InterruptTurnResult | Error
}) {
  const events: string[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const queue = opts.queue ?? [msg("p1", "pending"), msg("c1", "processing")]
  const deps: SendQueuedNowDeps = {
    getQueue: vi.fn(async () => queue),
    deleteMessage: vi.fn(async (id: string) => { events.push(`delete:${id}`) }),
    normalizeKey: (k) => (k ?? "").toLowerCase(),
    isRunning: vi.fn(() => opts.running ?? true),
    interruptTurn: vi.fn(async () => {
      events.push("interrupt")
      if (opts.interrupt instanceof Error) throw opts.interrupt
      return opts.interrupt ?? "interrupted"
    }),
    stopAgent: vi.fn(async () => { events.push("stop") }),
    dispatch: vi.fn(async () => { events.push("dispatch") }),
    later: (fn, ms) => { timers.push({ fn, ms }) },
    log: vi.fn(),
  }
  return { deps, events, timers }
}

describe("interruptRunningEngine：找谁去打断", () => {
  const engine = (running: boolean, interrupt?: () => Promise<InterruptTurnResult>): InterruptibleEngine => ({
    isRunning: () => running,
    ...(interrupt ? { interruptTurn: vi.fn(interrupt) } : {}),
  })

  it("在跑这个会话的引擎支持软打断：交给它，原样返回它的结果", async () => {
    const idle = engine(false, async () => "interrupted")
    const busy = engine(true, async () => "timeout")
    expect(await interruptRunningEngine("k", [idle, busy], false)).toBe("timeout")
    expect(idle.interruptTurn).not.toHaveBeenCalled() // 没在跑这个会话的引擎不会被惊动
    expect(busy.interruptTurn).toHaveBeenCalledWith("k")
  })

  it("在跑的引擎没实现软打断（比如 LLM 引擎）：unsupported，不去找别的引擎", async () => {
    const other = engine(false, async () => "interrupted")
    expect(await interruptRunningEngine("k", [engine(true), other], false)).toBe("unsupported")
    expect(other.interruptTurn).not.toHaveBeenCalled()
  })

  it("没有引擎在跑但调度器已预留名额：launching；没预留：not-running", async () => {
    expect(await interruptRunningEngine("k", [engine(false, async () => "interrupted")], true)).toBe("launching")
    expect(await interruptRunningEngine("k", [engine(false, async () => "interrupted")], false)).toBe("not-running")
    expect(await interruptRunningEngine("k", [], false)).toBe("not-running")
  })

  it("引擎在跑时，预留名额不改变结果（以引擎为准）", async () => {
    expect(await interruptRunningEngine("k", [engine(true, async () => "no-turn")], true)).toBe("no-turn")
  })
})

describe("没有排队中的消息", () => {
  it("只有已投递待确认的（processing）：报错，什么都不动", async () => {
    const { deps, events } = setup({ queue: [msg("c1", "processing")] })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: false, error: "没有排队中的消息" })
    expect(events).toEqual([])
  })

  it("队列里只有别的会话的消息：同样报错，不会误动别人", async () => {
    const { deps, events } = setup({ queue: [msg("o1", "pending", "app_x|other::D:/ws")] })
    expect((await sendQueuedNowFlow(KEY, deps)).ok).toBe(false)
    expect(events).toEqual([])
  })
})

describe("软打断成功：Agent 不重启", () => {
  it("interrupted：只打断，不停止、不删消息（被打断那批由 worker 自己确认），也不立刻调度", async () => {
    const { deps, events, timers } = setup({ interrupt: "interrupted" })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "soft" })
    expect(events).toEqual(["interrupt"])
    expect(deps.stopAgent).not.toHaveBeenCalled()
    expect(deps.deleteMessage).not.toHaveBeenCalled()
    // 保险：稍后补一次调度（Agent 正常在跑时是空操作）
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(1500)
    timers[0].fn()
    expect(events).toEqual(["interrupt", "dispatch"])
  })

  it("no-turn（刚好回合结束/空闲监听）：同样不重启，排队的消息由 Agent 自己领", async () => {
    const { deps, events } = setup({ interrupt: "no-turn" })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "soft" })
    expect(events).toEqual(["interrupt"])
  })

  it("会话 key 大小写/规范化不同也认得是同一个会话", async () => {
    const { deps } = setup({ queue: [msg("p1", "pending", KEY.toUpperCase())], interrupt: "interrupted" })
    expect((await sendQueuedNowFlow(KEY, deps)).via).toBe("soft")
  })
})

describe("Agent 正在拉起：不去打扰", () => {
  it("launching：不停止、不删、不调度（重启只会更慢），拉起后第一次轮询就领走排队的消息", async () => {
    const { deps, events, timers } = setup({ interrupt: "launching" })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "launching" })
    expect(events).toEqual(["interrupt"])
    expect(timers).toHaveLength(0)
  })
})

describe("需要重新拉起", () => {
  it("当时根本没有 Agent 在跑：先确认掉残留的 processing，再调度；不调用打断", async () => {
    const { deps, events } = setup({ running: false })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "relaunch" })
    expect(events).toEqual(["delete:c1", "dispatch"])
    expect(deps.interruptTurn).not.toHaveBeenCalled()
    expect(deps.stopAgent).not.toHaveBeenCalled()
  })

  it.each<InterruptTurnResult>(["exited", "not-running"])("打断时 Agent 退出了（%s）：确认残留、调度重新拉起，不再多此一举地 stop", async (r) => {
    const { deps, events } = setup({ interrupt: r })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "relaunch" })
    expect(events).toEqual(["interrupt", "delete:c1", "dispatch"])
    expect(deps.stopAgent).not.toHaveBeenCalled()
  })

  it("重新拉起时只确认 processing，pending 的排队消息一条都不能删", async () => {
    const { deps } = setup({
      queue: [msg("p1", "pending"), msg("p2", "pending"), msg("c1", "processing"), msg("o1", "processing", "app_x|other::D:/ws")],
      running: false,
    })
    await sendQueuedNowFlow(KEY, deps)
    expect((deps.deleteMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["c1"])
  })
})

describe("软打断不适用或超时：退回旧做法（停止 + 重新拉起）", () => {
  it.each<InterruptTurnResult>(["unsupported", "timeout"])("%s：先确认残留 processing → 停止 → 调度，顺序不能乱", async (r) => {
    const { deps, events, timers } = setup({ interrupt: r })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "hard" })
    expect(events).toEqual(["interrupt", "delete:c1", "stop", "dispatch"])
    expect(timers).toHaveLength(1) // 1.5 秒后再补一次调度
    expect(timers[0].ms).toBe(1500)
  })

  it("打断本身抛错：当作不适用，走旧做法，不把错误抛给界面", async () => {
    const { deps, events } = setup({ interrupt: new Error("boom") })
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "hard" })
    expect(events).toEqual(["interrupt", "delete:c1", "stop", "dispatch"])
  })

  it("删除残留消息失败也不阻断后面的停止和调度", async () => {
    const { deps, events } = setup({ interrupt: "unsupported" })
    ;(deps.deleteMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("daemon 不可达"))
    expect(await sendQueuedNowFlow(KEY, deps)).toEqual({ ok: true, via: "hard" })
    expect(events).toEqual(["interrupt", "stop", "dispatch"])
  })
})
