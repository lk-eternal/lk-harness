import { beforeEach, describe, expect, it, vi } from "vitest"

// worker 本身只依赖这几个模块；其余全部替身，只验证「停止」这条控制流
const mocks = vi.hoisted(() => ({
  executeSdkTurn: vi.fn(),
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
}))

vi.mock("../electron/agent-sdk", () => ({
  executeSdkTurn: mocks.executeSdkTurn,
  onSdkWorkerFinished: vi.fn(),
  unregisterSdkSessionForWorker: vi.fn(async () => undefined),
}))
vi.mock("../electron/poll-host", () => ({
  hostBlockingPoll: mocks.hostBlockingPoll,
  hostNonBlockingPoll: mocks.hostNonBlockingPoll,
  hostConfirmClaimed: vi.fn(async () => undefined),
  hostTouchSessionReply: vi.fn(async () => undefined),
  isPollEndDirective: vi.fn(() => false),
  isPollTimeoutDirective: vi.fn(() => false),
  markMessagesProcessed: vi.fn(async () => undefined),
}))
vi.mock("../electron/prompt-assembler", () => ({ assembleSdkWorkerTurnPrompt: vi.fn(() => "prompt") }))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: vi.fn(), replyTexts: vi.fn(() => []) }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))

import { cancelRunQuietly, isSdkWorkerActive, startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"

type FakeRun = { cancel: ReturnType<typeof vi.fn> }

function fakeSession(sessionKey: string, run: FakeRun | null) {
  return {
    sessionKey,
    run,
    abortController: new AbortController(),
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
  }
}

function start(session: ReturnType<typeof fakeSession>): void {
  void startSdkWorkerLoop(session as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })
}

beforeEach(() => {
  mocks.executeSdkTurn.mockReset()
  mocks.hostNonBlockingPoll.mockReset()
  mocks.hostBlockingPoll.mockReset()
})

describe("停止 SDK worker", () => {
  it("Agent 卡在长工具调用里（没有事件）时，停止会立刻 cancel 当前 run，不用干等超时", async () => {
    mocks.hostNonBlockingPoll.mockResolvedValue({ messages: [{ text: "你好", messageId: "m1" }], directive: undefined })
    let endTurn: () => void = () => undefined
    mocks.executeSdkTurn.mockImplementation(() => new Promise((resolve) => {
      endTurn = () => resolve({ ok: false, errorDetail: "aborted", networkFail: false, permanentFail: false })
    }))
    // 与真实 SDK 一致：卡在工具里时事件流不会自己结束，只有 cancel 才会
    const run: FakeRun = { cancel: vi.fn(async () => { endTurn() }) }
    const session = fakeSession("s-stop-1", run)

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(isSdkWorkerActive("s-stop-1")).toBe(true)

    const started = Date.now()
    await stopSdkWorker("s-stop-1")
    const elapsed = Date.now() - started

    expect(run.cancel).toHaveBeenCalledTimes(1)
    expect(session.abortController.signal.aborted).toBe(true)
    // 兜底超时是 5 秒；真正退出应当是毫秒级
    expect(elapsed).toBeLessThan(1500)
    expect(isSdkWorkerActive("s-stop-1")).toBe(false)
  })

  it("空闲监听（没有进行中的 run）时，停止照常退出，也不会去 cancel", async () => {
    mocks.hostNonBlockingPoll.mockResolvedValue({ messages: [], directive: undefined })
    mocks.hostBlockingPoll.mockImplementation((_key: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const session = fakeSession("s-stop-2", null)

    start(session)
    await vi.waitFor(() => expect(mocks.hostBlockingPoll).toHaveBeenCalledTimes(1))

    const started = Date.now()
    await expect(stopSdkWorker("s-stop-2")).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1500)
    expect(mocks.executeSdkTurn).not.toHaveBeenCalled()
    expect(isSdkWorkerActive("s-stop-2")).toBe(false)
  })

  it("worker 不存在时直接返回", async () => {
    await expect(stopSdkWorker("never-started")).resolves.toBeUndefined()
  })
})

describe("cancelRunQuietly", () => {
  it("没有 run 时什么都不做", () => {
    expect(() => cancelRunQuietly({ run: null })).not.toThrow()
  })

  it("cancel 异步失败或同步抛错都不外泄", async () => {
    const rejecting = { run: { cancel: vi.fn(() => Promise.reject(new Error("boom"))) } }
    const throwing = { run: { cancel: vi.fn(() => { throw new Error("sync boom") }) } }
    expect(() => cancelRunQuietly(rejecting)).not.toThrow()
    expect(() => cancelRunQuietly(throwing)).not.toThrow()
    await Promise.resolve()
    expect(rejecting.run.cancel).toHaveBeenCalledTimes(1)
    expect(throwing.run.cancel).toHaveBeenCalledTimes(1)
  })
})
