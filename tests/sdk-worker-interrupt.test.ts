import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「立即发送」的软打断：只取消当前这一轮，Agent 不退出，随后自己去队列领排队的消息。
 * 真实的 worker 循环 + 替身的 agent-sdk / poll-host：只验证控制流和顺序。
 * 为什么要软打断：原来是「停掉 Agent 再 Resume」，Resume 要走网络，偶发卡 30 秒以上（实测 133 次里最慢 33 秒）。
 */
const mocks = vi.hoisted(() => ({
  order: [] as string[],
  executeSdkTurn: vi.fn(),
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
  markMessagesProcessed: vi.fn(),
  finishInterruptedTurn: vi.fn(),
  onSdkWorkerFinished: vi.fn(),
  appendMirrorTurns: vi.fn(),
  replyTexts: vi.fn(),
  rollover: vi.fn(),
}))

vi.mock("../electron/agent-sdk", () => ({
  executeSdkTurn: mocks.executeSdkTurn,
  finishInterruptedTurn: mocks.finishInterruptedTurn,
  onSdkWorkerFinished: mocks.onSdkWorkerFinished,
  unregisterSdkSessionForWorker: vi.fn(async () => undefined),
}))
vi.mock("../electron/poll-host", () => ({
  hostBlockingPoll: mocks.hostBlockingPoll,
  hostNonBlockingPoll: mocks.hostNonBlockingPoll,
  hostConfirmClaimed: vi.fn(async () => undefined),
  hostTouchSessionReply: vi.fn(async () => undefined),
  markMessagesProcessed: mocks.markMessagesProcessed,
}))
vi.mock("../electron/prompt-assembler", () => ({ assembleSdkWorkerTurnPrompt: vi.fn(() => "prompt") }))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: mocks.appendMirrorTurns, replyTexts: mocks.replyTexts }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))
vi.mock("../electron/session-retention", () => ({ rolloverSessionLedgerIfNeeded: mocks.rollover }))

import { interruptSdkWorkerTurn, isSdkWorkerActive, startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"

interface FakeSession {
  sessionKey: string
  run: { cancel: ReturnType<typeof vi.fn> } | null
  abortController: AbortController
  seenMessageIds: Set<string>
  processedMessageIds: Set<string>
  streamAgg: { segments: unknown[] } | null
  interruptRequested?: boolean
}

function fakeSession(sessionKey: string, cancel?: () => void): FakeSession {
  return {
    sessionKey,
    run: { cancel: vi.fn(async () => { mocks.order.push("cancel"); cancel?.() }) },
    abortController: new AbortController(),
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
    streamAgg: null,
  }
}

function start(session: FakeSession, persistentPoll = true): void {
  void startSdkWorkerLoop(session as never, { persistentPoll, promptCtx: {} as never, firstTurn: true })
}

/** 第一轮在跑（被测试手动结束），返回结束它的函数 */
function firstTurnRunning(): { end: (r?: Record<string, unknown>) => void } {
  mocks.hostNonBlockingPoll.mockResolvedValue({ messages: [{ text: "第一条", messageId: "m1" }] })
  const handle: { end: (r?: Record<string, unknown>) => void } = { end: () => undefined }
  mocks.executeSdkTurn.mockImplementationOnce(() => new Promise((resolve) => {
    handle.end = (r) => resolve({ ok: true, networkFail: false, permanentFail: false, ...r })
  }))
  return handle
}

/** 之后的监听：第一次领到排队的消息，再之后一直挂着，直到 worker 被停止 */
function thenQueued(messages: Array<{ text: string; messageId: string }>): void {
  mocks.hostBlockingPoll
    .mockImplementationOnce(async () => { mocks.order.push("poll"); return { messages } })
    .mockImplementation((_key: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
}

beforeEach(() => {
  mocks.order.length = 0
  for (const m of [
    mocks.executeSdkTurn, mocks.hostNonBlockingPoll, mocks.hostBlockingPoll, mocks.markMessagesProcessed,
    mocks.finishInterruptedTurn, mocks.onSdkWorkerFinished, mocks.appendMirrorTurns, mocks.replyTexts, mocks.rollover,
  ]) m.mockReset()
  mocks.replyTexts.mockReturnValue([])
  mocks.rollover.mockResolvedValue(false)
  mocks.finishInterruptedTurn.mockImplementation(async () => { mocks.order.push("seal") })
  mocks.markMessagesProcessed.mockImplementation(async () => { mocks.order.push("confirm") })
})

describe("软打断：只取消当前这一轮，Agent 不退出", () => {
  it("取消 → 回合收口 → 卡封成已打断 → 确认旧消息 → 才去领排队的消息，全程是同一个 worker、同一个会话", async () => {
    const turn = firstTurnRunning()
    thenQueued([{ text: "排队的", messageId: "m2" }])
    mocks.executeSdkTurn.mockImplementationOnce(async () => { mocks.order.push("turn2"); return { ok: true, networkFail: false, permanentFail: false } })
    const session = fakeSession("s-int-1", () => turn.end())

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))

    const r = await interruptSdkWorkerTurn("s-int-1")
    expect(r).toBe("interrupted")
    expect(session.run!.cancel).toHaveBeenCalledTimes(1)
    expect(session.abortController.signal.aborted).toBe(false) // 没有 abort：Agent 和会话都还在
    expect(isSdkWorkerActive("s-int-1")).toBe(true)

    // 顺序：cancel → 封卡 → 确认被打断的那批 → 领排队消息 → 新一轮（末尾的 confirm 是新一轮自己的）
    await vi.waitFor(() => expect(mocks.markMessagesProcessed).toHaveBeenCalledTimes(2))
    expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(2)
    expect(mocks.order).toEqual(["cancel", "seal", "confirm", "poll", "turn2", "confirm"])
    expect(mocks.finishInterruptedTurn).toHaveBeenCalledTimes(1) // 只有被打断的那一轮封卡，新一轮正常收口
    expect(mocks.markMessagesProcessed.mock.calls[0][2]).toEqual([expect.objectContaining({ messageId: "m1" })])
    expect(mocks.executeSdkTurn.mock.calls[0][0]).toBe(session) // 两轮都是同一个会话对象，没有重新拉起
    expect(mocks.executeSdkTurn.mock.calls[1][0]).toBe(session)
    expect(mocks.onSdkWorkerFinished).not.toHaveBeenCalled()
    expect(session.interruptRequested).toBeFalsy() // 标记只管这一轮，下一轮不受影响

    await stopSdkWorker("s-int-1")
  })

  it("被打断的那一轮的用户消息和已输出的半截回复也记进镜像（原来的停止路径会整轮丢掉）", async () => {
    const turn = firstTurnRunning()
    thenQueued([])
    mocks.replyTexts.mockReturnValue(["我先看了一半"])
    const session = fakeSession("s-int-2", () => turn.end())
    session.streamAgg = { segments: [{ type: "reply", text: "我先看了一半" }] }

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(await interruptSdkWorkerTurn("s-int-2")).toBe("interrupted")
    await vi.waitFor(() => expect(mocks.appendMirrorTurns).toHaveBeenCalledTimes(1))
    expect(mocks.appendMirrorTurns).toHaveBeenCalledWith("s-int-2", [
      { role: "user", text: "第一条" },
      { role: "assistant", text: "我先看了一半" },
    ])
    await stopSdkWorker("s-int-2")
  })

  it("被打断的回合以错误状态结束（取消引发的）也不算失败：worker 继续监听，不记失败、不退出", async () => {
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-int-3", () => turn.end({ ok: false, errorDetail: "cancelled" }))

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(await interruptSdkWorkerTurn("s-int-3")).toBe("interrupted")
    await vi.waitFor(() => expect(mocks.hostBlockingPoll).toHaveBeenCalled())
    expect(isSdkWorkerActive("s-int-3")).toBe(true)
    expect(mocks.onSdkWorkerFinished).not.toHaveBeenCalled()
    await stopSdkWorker("s-int-3")
  })

  it("没打断时回合以错误结束，仍然按失败处理（原有行为不变）", async () => {
    const turn = firstTurnRunning()
    const session = fakeSession("s-int-4")
    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end({ ok: false, errorDetail: "boom" })
    await vi.waitFor(() => expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1))
    expect(mocks.onSdkWorkerFinished.mock.calls[0][1]).toBe(true) // errored
    expect(mocks.finishInterruptedTurn).not.toHaveBeenCalled()
  })

  it("send 还没返回 run 的那个短窗口里被打断：标记在会话上，turn 结束时照样被当成打断", async () => {
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-int-5")
    session.run = null // send 之前 run 还没登记，cancel 没有对象可取消
    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))

    const pending = interruptSdkWorkerTurn("s-int-5")
    expect(session.interruptRequested).toBe(true) // executeSdkTurn 拿到 run 后会看这个标记补一刀 cancel
    turn.end()
    expect(await pending).toBe("interrupted")
    await vi.waitFor(() => expect(mocks.finishInterruptedTurn).toHaveBeenCalledTimes(1))
    await stopSdkWorker("s-int-5")
  })
})

describe("软打断不适用的情形：交还给调用方走原来的停止+重启", () => {
  it("没有 worker：not-running", async () => {
    expect(await interruptSdkWorkerTurn("never-started")).toBe("not-running")
  })

  it("Agent 在空闲监听、没有进行中的回合：no-turn，不 cancel，也不留标记", async () => {
    mocks.hostNonBlockingPoll.mockResolvedValue({ messages: [] })
    mocks.hostBlockingPoll.mockImplementation((_key: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const session = fakeSession("s-idle")
    start(session)
    await vi.waitFor(() => expect(mocks.hostBlockingPoll).toHaveBeenCalledTimes(1))

    expect(await interruptSdkWorkerTurn("s-idle")).toBe("no-turn")
    expect(session.run!.cancel).not.toHaveBeenCalled()
    expect(session.interruptRequested).toBeFalsy()
    await stopSdkWorker("s-idle")
  })

  it("按需唤醒（非常驻轮询）的会话：unsupported，不 cancel（回合一结束 worker 本来就退出，得重新拉起）", async () => {
    const turn = firstTurnRunning()
    const session = fakeSession("s-ondemand", () => turn.end())
    start(session, false)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))

    expect(await interruptSdkWorkerTurn("s-ondemand")).toBe("unsupported")
    expect(session.run!.cancel).not.toHaveBeenCalled()
    expect(session.interruptRequested).toBeFalsy()
    await stopSdkWorker("s-ondemand")
  })

  it("取消迟迟不生效：到时限返回 timeout，撤回标记，worker 还活着，之后仍可被正常停止", async () => {
    const turn = firstTurnRunning() // 回合不会自己结束，第一次 cancel 也没效果
    const session = fakeSession("s-timeout")
    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))

    const r = await interruptSdkWorkerTurn("s-timeout", 60)
    expect(r).toBe("timeout")
    expect(session.run!.cancel).toHaveBeenCalledTimes(1)
    expect(session.interruptRequested).toBe(false)
    expect(isSdkWorkerActive("s-timeout")).toBe(true)
    expect(mocks.finishInterruptedTurn).not.toHaveBeenCalled()

    // 调用方随后走硬停止：这次 cancel 生效，回合收口，worker 退出
    session.run!.cancel.mockImplementation(async () => { turn.end({ ok: false, errorDetail: "aborted" }) })
    await stopSdkWorker("s-timeout")
    expect(isSdkWorkerActive("s-timeout")).toBe(false)
    expect(mocks.finishInterruptedTurn).not.toHaveBeenCalled() // 硬停止走原来的收口，不算软打断
  })

  it("打断过程中 worker 退出了（比如账本滚动要冷启动）：exited，由调度器重新拉起", async () => {
    const turn = firstTurnRunning()
    mocks.rollover.mockResolvedValue(true)
    const session = fakeSession("s-exit", () => turn.end())
    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))

    expect(await interruptSdkWorkerTurn("s-exit")).toBe("exited")
    expect(isSdkWorkerActive("s-exit")).toBe(false)
    expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1)
  })
})

describe("多次点击", () => {
  it("回合收口前连点两次：两次都等到同一次收口，只会取消一轮，worker 只有一个", async () => {
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-twice", () => turn.end())
    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))

    const [a, b] = await Promise.all([interruptSdkWorkerTurn("s-twice"), interruptSdkWorkerTurn("s-twice")])
    expect([a, b]).toEqual(["interrupted", "interrupted"])
    await vi.waitFor(() => expect(mocks.hostBlockingPoll).toHaveBeenCalled())
    expect(mocks.finishInterruptedTurn).toHaveBeenCalledTimes(1)
    expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1)
    await stopSdkWorker("s-twice")
  })
})
