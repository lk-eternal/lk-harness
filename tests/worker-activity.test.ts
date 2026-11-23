/**
 * 会话 worker 给「空闲自动重启安装」记 Agent 的动静：开始和结束一个回合各记一笔，worker 退出再记一笔，
 * 但长连接 poll 挂起到点后的继续监听不能记（否则每次超时都会刷新，应用就永远「不安静」、永远不会自动重启）。
 * 同时验证 listSdkWorkerPhases / listLlmWorkerPhases：监听中是 listening，跑回合时是 processing。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  noteAgentActivity: vi.fn(),
  executeSdkTurn: vi.fn(),
  executeLlmPiTurn: vi.fn(),
  onSdkWorkerFinished: vi.fn(),
  onLlmWorkerFinished: vi.fn(),
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
  pushUiLog: vi.fn(),
}))

vi.mock("../electron/agent-activity", () => ({ noteAgentActivity: m.noteAgentActivity }))
vi.mock("../electron/agent-sdk", () => ({
  executeSdkTurn: m.executeSdkTurn,
  finishInterruptedTurn: vi.fn(async () => undefined),
  onSdkWorkerFinished: m.onSdkWorkerFinished,
  unregisterSdkSessionForWorker: vi.fn(async () => undefined),
}))
vi.mock("../electron/agent-llm", () => ({
  executeLlmPiTurn: m.executeLlmPiTurn,
  onLlmWorkerFinished: m.onLlmWorkerFinished,
  registerLlmSession: vi.fn(),
  unregisterLlmSession: vi.fn(async () => undefined),
}))
vi.mock("../electron/poll-host", () => ({
  hostBlockingPoll: m.hostBlockingPoll,
  hostNonBlockingPoll: m.hostNonBlockingPoll,
  hostConfirmClaimed: vi.fn(async () => undefined),
  hostTouchSessionReply: vi.fn(async () => undefined),
  hostSendText: vi.fn(async () => undefined),
  markMessagesProcessed: vi.fn(async () => undefined),
}))
vi.mock("../electron/agent-failure-notice", () => ({ reportAgentFailure: vi.fn(async () => undefined) }))
vi.mock("../electron/prompt-assembler", () => ({
  assembleSdkWorkerTurnPrompt: vi.fn(() => "prompt"),
  assembleTurnPrompt: vi.fn(() => "prompt"),
}))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: vi.fn(), replyTexts: vi.fn(() => []) }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: m.pushUiLog }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn(), isFeishuStreamEnabled: () => false }))
vi.mock("../electron/session-retention", () => ({
  rolloverSessionLedgerIfNeeded: async () => false,
}))

import { listSdkWorkerPhases, startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"
import { listLlmWorkerPhases, startLlmWorkerLoop, stopLlmWorker } from "../electron/llm-session-worker"

/** 挂着不返回，直到被 abort（和真实的阻塞 poll 一样） */
function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

const oneMessage = { messages: [{ text: "你好", messageId: "m1" }] }

/** 写过几次「worker listening」日志：每次从头开始监听写一条；poll 挂起到点后的静默续挂不写 */
const listeningLogs = () => m.pushUiLog.mock.calls.filter((c) => String(c[2]).includes("worker listening")).length
const heartbeatLogs = () => m.pushUiLog.mock.calls.filter((c) => String(c[2]).includes("挂起到点")).length
const idleExitLogs = () => m.pushUiLog.mock.calls.filter((c) => String(c[2]).includes("空闲超过")).length

/** 只假 Date：worker 的「空闲多久」靠 Date.now()，让测试能一步跨过 30 分钟；定时器仍是真的（vi.waitFor 要用） */
const T0 = new Date("2026-11-23T10:00:00Z").getTime()
const atMinute = (min: number) => vi.setSystemTime(T0 + min * 60_000)

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
  m.hostNonBlockingPoll.mockResolvedValue({ messages: [] })
  vi.useFakeTimers({ toFake: ["Date"] })
  atMinute(0)
})

afterEach(() => { vi.useRealTimers() })

describe("SDK worker 记 Agent 的动静", () => {
  const key = "s-activity"
  const session = () => ({
    sessionKey: key,
    run: null,
    abortController: new AbortController(),
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
  })
  const start = (s: ReturnType<typeof session>) =>
    void startSdkWorkerLoop(s as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })

  it("poll 挂起到点后继续监听：不记动静，阶段一直是 listening；退出时记一笔", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls <= 3 ? Promise.resolve({ messages: [], reason: "timeout" }) : hangUntilAbort(signal)
    })
    start(session())
    await vi.waitFor(() => expect(polls).toBe(4))

    expect(listSdkWorkerPhases()).toEqual(["listening"])
    expect(m.noteAgentActivity).not.toHaveBeenCalled()
    // 三次到点续挂都是静默的：冷启动检查和监听日志只在第一次监听时有一份
    expect(m.hostNonBlockingPoll).toHaveBeenCalledTimes(1)
    expect(listeningLogs()).toBe(1)
    expect(heartbeatLogs()).toBe(0)

    await stopSdkWorker(key)
    expect(listSdkWorkerPhases()).toEqual([])
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(1)
  })

  it("到点续挂后来了消息：照常跑一轮；回合结束回去监听时从头开始（重新写监听日志），之后的续挂又是静默的", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      if (polls === 1 || polls === 3) return Promise.resolve({ messages: [], reason: "timeout" })
      return polls === 2 ? Promise.resolve(oneMessage) : hangUntilAbort(signal)
    })
    m.executeSdkTurn.mockResolvedValue({ ok: true })
    start(session())
    await vi.waitFor(() => expect(polls).toBe(4))

    expect(m.executeSdkTurn).toHaveBeenCalledTimes(1)
    expect(listeningLogs()).toBe(2)

    await stopSdkWorker(key)
  })

  it("收到消息开始回合记一笔（阶段 processing），回合结束回去监听再记一笔（阶段 listening）", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls === 1 ? Promise.resolve(oneMessage) : hangUntilAbort(signal)
    })
    let endTurn: () => void = () => undefined
    m.executeSdkTurn.mockImplementation(() => new Promise((resolve) => {
      endTurn = () => resolve({ ok: true })
    }))
    start(session())

    await vi.waitFor(() => expect(m.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(listSdkWorkerPhases()).toEqual(["processing"])
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(1)

    endTurn()
    await vi.waitFor(() => expect(polls).toBe(2))
    expect(listSdkWorkerPhases()).toEqual(["listening"])
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(2)

    await stopSdkWorker(key)
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(3)
  })

  it("回合失败、worker 直接退出：退出时也记一笔，不会留下「刚才还在忙」的空档", async () => {
    m.hostBlockingPoll.mockResolvedValueOnce(oneMessage)
    m.executeSdkTurn.mockResolvedValue({ ok: false, errorDetail: "boom", failureKind: "other" })
    start(session())

    await vi.waitFor(() => expect(listSdkWorkerPhases()).toEqual([]))
    // 回合开始一笔 + 退出一笔
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(2)
  })

  describe("空闲 30 分钟干净退出", () => {
    // 某条用例失败时 worker 可能还挂着，停掉它免得连累后面的用例。
    // 用例里 poll 超过 5 次就改成挂起不返回：万一退出逻辑坏了，worker 会一直续挂，这样是超时失败，而不是死循环卡住
    afterEach(async () => { await stopSdkWorker(key) })

    it("空闲不满 30 分钟：到点空返回只续挂，worker 不退出", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls > 3) return hangUntilAbort(signal)
        atMinute(polls * 9) // 9、18、27 分钟各到点一次
        return Promise.resolve({ messages: [], reason: "timeout" })
      })
      start(session())
      await vi.waitFor(() => expect(polls).toBe(4))

      expect(listSdkWorkerPhases()).toEqual(["listening"])
      expect(m.onSdkWorkerFinished).not.toHaveBeenCalled()
      expect(idleExitLogs()).toBe(0)
    })

    it("空闲满 30 分钟后的到点空返回：干净退出（不算异常），不再挂 poll，不起回合", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls > 5) return hangUntilAbort(signal)
        atMinute(polls === 1 ? 29 : 30) // 29 分钟还续挂，刚好 30 分钟退出
        return Promise.resolve({ messages: [], reason: "timeout" })
      })
      start(session())
      await vi.waitFor(() => expect(m.onSdkWorkerFinished).toHaveBeenCalledTimes(1))

      expect(polls).toBe(2)
      expect(m.executeSdkTurn).not.toHaveBeenCalled()
      expect(idleExitLogs()).toBe(1)
      expect(m.onSdkWorkerFinished.mock.calls[0][1]).toBe(false) // errored=false：不会报红字、不会累计失败次数
      expect(listSdkWorkerPhases()).toEqual([])
    })

    it("空闲从上一轮回合结束起算，不是从 worker 启动起算", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls > 5) return hangUntilAbort(signal)
        if (polls === 1) { atMinute(25); return Promise.resolve(oneMessage) } // 25 分钟时来了消息，回合当场结束
        atMinute(polls === 2 ? 25 + 29 : 25 + 30) // 回合结束后空闲 29 分钟续挂，30 分钟退出
        return Promise.resolve({ messages: [], reason: "timeout" })
      })
      m.executeSdkTurn.mockResolvedValue({ ok: true })
      start(session())
      await vi.waitFor(() => expect(m.onSdkWorkerFinished).toHaveBeenCalledTimes(1))

      expect(polls).toBe(3) // 从启动起算的话第 2 次（54 分钟）就退出了
      expect(m.executeSdkTurn).toHaveBeenCalledTimes(1)
      expect(idleExitLogs()).toBe(1)
      expect(m.onSdkWorkerFinished.mock.calls[0][1]).toBe(false)
    })

    it("空闲很久之后来了消息：照常处理，不会因为空闲时间到了而丢掉它", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls === 1) { atMinute(40); return Promise.resolve(oneMessage) }
        return hangUntilAbort(signal)
      })
      m.executeSdkTurn.mockResolvedValue({ ok: true })
      start(session())
      await vi.waitFor(() => expect(polls).toBe(2))

      expect(m.executeSdkTurn).toHaveBeenCalledTimes(1)
      expect(idleExitLogs()).toBe(0)
      expect(listSdkWorkerPhases()).toEqual(["listening"])
    })
  })
})

describe("LLM worker 记 Agent 的动静", () => {
  const key = "l-activity"
  const session = () => ({
    sessionKey: key,
    abort: new AbortController(),
    lastActivityAt: 0,
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
  })
  const start = (s: ReturnType<typeof session>) =>
    void startLlmWorkerLoop(s as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })

  it("poll 挂起到点后继续监听：不记动静，阶段一直是 listening；退出时记一笔", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls <= 3 ? Promise.resolve({ messages: [], reason: "timeout" }) : hangUntilAbort(signal)
    })
    start(session())
    await vi.waitFor(() => expect(polls).toBe(4))

    expect([...listLlmWorkerPhases().values()]).toEqual(["listening"])
    expect(m.noteAgentActivity).not.toHaveBeenCalled()
    // 三次到点续挂都是静默的：冷启动检查和监听日志只在第一次监听时有一份
    expect(m.hostNonBlockingPoll).toHaveBeenCalledTimes(1)
    expect(listeningLogs()).toBe(1)
    expect(heartbeatLogs()).toBe(0)

    await stopLlmWorker(key)
    expect(listLlmWorkerPhases().size).toBe(0)
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(1)
  })

  it("到点续挂后来了消息：照常跑一轮；回合结束回去监听时从头开始（重新写监听日志），之后的续挂又是静默的", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      if (polls === 1 || polls === 3) return Promise.resolve({ messages: [], reason: "timeout" })
      return polls === 2 ? Promise.resolve(oneMessage) : hangUntilAbort(signal)
    })
    m.executeLlmPiTurn.mockResolvedValue({ ok: true, replyText: "好的" })
    start(session())
    await vi.waitFor(() => expect(polls).toBe(4))

    expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1)
    expect(listeningLogs()).toBe(2)

    await stopLlmWorker(key)
  })

  it("收到消息开始回合记一笔（阶段 processing），回合结束回去监听再记一笔（阶段 listening）", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls === 1 ? Promise.resolve(oneMessage) : hangUntilAbort(signal)
    })
    let endTurn: () => void = () => undefined
    m.executeLlmPiTurn.mockImplementation(() => new Promise((resolve) => {
      endTurn = () => resolve({ ok: true, replyText: "好的" })
    }))
    start(session())

    await vi.waitFor(() => expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1))
    expect([...listLlmWorkerPhases().values()]).toEqual(["processing"])
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(1)

    endTurn()
    await vi.waitFor(() => expect(polls).toBe(2))
    expect([...listLlmWorkerPhases().values()]).toEqual(["listening"])
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(2)

    await stopLlmWorker(key)
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(3)
  })

  it("回合报错但会话还能用（resumable）：worker 不退出，回到监听时记一笔", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls === 1 ? Promise.resolve(oneMessage) : hangUntilAbort(signal)
    })
    m.executeLlmPiTurn.mockResolvedValue({ ok: false, error: "网关报错" })
    start(session())

    await vi.waitFor(() => expect(polls).toBe(2))
    expect([...listLlmWorkerPhases().values()]).toEqual(["listening"])
    expect(m.noteAgentActivity).toHaveBeenCalledTimes(2)

    await stopLlmWorker(key)
  })

  describe("空闲 30 分钟干净退出", () => {
    // 同 SDK 那组：失败时停掉残留的 worker；poll 超过 5 次就挂起不返回，退出逻辑坏了是超时失败而不是死循环
    afterEach(async () => { await stopLlmWorker(key) })

    it("空闲不满 30 分钟：到点空返回只续挂，worker 不退出", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls > 3) return hangUntilAbort(signal)
        atMinute(polls * 9) // 9、18、27 分钟各到点一次
        return Promise.resolve({ messages: [], reason: "timeout" })
      })
      start(session())
      await vi.waitFor(() => expect(polls).toBe(4))

      expect([...listLlmWorkerPhases().values()]).toEqual(["listening"])
      expect(m.onLlmWorkerFinished).not.toHaveBeenCalled()
      expect(idleExitLogs()).toBe(0)
    })

    it("空闲满 30 分钟后的到点空返回：干净退出（不算异常），不再挂 poll，不起回合", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls > 5) return hangUntilAbort(signal)
        atMinute(polls === 1 ? 29 : 30) // 29 分钟还续挂，刚好 30 分钟退出
        return Promise.resolve({ messages: [], reason: "timeout" })
      })
      start(session())
      await vi.waitFor(() => expect(m.onLlmWorkerFinished).toHaveBeenCalledTimes(1))

      expect(polls).toBe(2)
      expect(m.executeLlmPiTurn).not.toHaveBeenCalled()
      expect(idleExitLogs()).toBe(1)
      expect(m.onLlmWorkerFinished.mock.calls[0][1]).toBe(false) // errored=false
      expect(listLlmWorkerPhases().size).toBe(0)
    })

    it("空闲从上一轮回合结束起算，不是从 worker 启动起算", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls > 5) return hangUntilAbort(signal)
        if (polls === 1) { atMinute(25); return Promise.resolve(oneMessage) } // 25 分钟时来了消息，回合当场结束
        atMinute(polls === 2 ? 25 + 29 : 25 + 30) // 回合结束后空闲 29 分钟续挂，30 分钟退出
        return Promise.resolve({ messages: [], reason: "timeout" })
      })
      m.executeLlmPiTurn.mockResolvedValue({ ok: true, replyText: "好的" })
      start(session())
      await vi.waitFor(() => expect(m.onLlmWorkerFinished).toHaveBeenCalledTimes(1))

      expect(polls).toBe(3) // 从启动起算的话第 2 次（54 分钟）就退出了
      expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1)
      expect(idleExitLogs()).toBe(1)
      expect(m.onLlmWorkerFinished.mock.calls[0][1]).toBe(false)
    })

    it("空闲很久之后来了消息：照常处理，不会因为空闲时间到了而丢掉它", async () => {
      let polls = 0
      m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
        polls++
        if (polls === 1) { atMinute(40); return Promise.resolve(oneMessage) }
        return hangUntilAbort(signal)
      })
      m.executeLlmPiTurn.mockResolvedValue({ ok: true, replyText: "好的" })
      start(session())
      await vi.waitFor(() => expect(polls).toBe(2))

      expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1)
      expect(idleExitLogs()).toBe(0)
      expect([...listLlmWorkerPhases().values()]).toEqual(["listening"])
    })
  })
})
