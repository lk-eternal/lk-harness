/**
 * 会话 worker 在失败时交出什么：失败类别、原始报错，以及「出事的那条消息」。
 * 失败提示要回复那条消息，所以必须准确：只有真的有消息在处理时才带；poll 自己出错这类没有消息在处理的退出，不能带上一轮的旧消息。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  executeSdkTurn: vi.fn(),
  executeLlmPiTurn: vi.fn(),
  onSdkWorkerFinished: vi.fn(),
  onLlmWorkerFinished: vi.fn(),
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
  hostTouchSessionReply: vi.fn(async () => undefined),
  markMessagesProcessed: vi.fn(async () => undefined),
  reportAgentFailure: vi.fn(async () => undefined),
}))

vi.mock("../electron/agent-activity", () => ({ noteAgentActivity: vi.fn() }))
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
  hostTouchSessionReply: m.hostTouchSessionReply,
  hostSendText: vi.fn(async () => undefined),
  markMessagesProcessed: m.markMessagesProcessed,
}))
vi.mock("../electron/agent-failure-notice", () => ({ reportAgentFailure: m.reportAgentFailure }))
vi.mock("../electron/prompt-assembler", () => ({
  assembleSdkWorkerTurnPrompt: vi.fn(() => "prompt"),
  assembleTurnPrompt: vi.fn(() => "prompt"),
}))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: vi.fn(), replyTexts: vi.fn(() => []) }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))
vi.mock("../electron/session-retention", () => ({ rolloverSessionLedgerIfNeeded: async () => false }))

import { startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"
import { startLlmWorkerLoop, stopLlmWorker } from "../electron/llm-session-worker"

function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

const batch = (...ids: string[]) => ({ messages: ids.map((id) => ({ text: `消息 ${id}`, messageId: id })) })

beforeEach(() => {
  for (const fn of [m.executeSdkTurn, m.executeLlmPiTurn, m.onSdkWorkerFinished, m.onLlmWorkerFinished, m.hostNonBlockingPoll, m.hostBlockingPoll, m.reportAgentFailure, m.markMessagesProcessed]) {
    fn.mockReset()
  }
  m.hostNonBlockingPoll.mockResolvedValue({ messages: [] })
  m.reportAgentFailure.mockResolvedValue(undefined)
})

describe("SDK worker 出错退出", () => {
  const key = "s-fail"
  const session = () => ({
    sessionKey: key,
    run: null,
    abortController: new AbortController(),
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
  })
  const start = () =>
    void startSdkWorkerLoop(session() as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })

  it("回合失败：交出失败类别、原始报错和这批消息里的最后一条", async () => {
    m.hostBlockingPoll.mockResolvedValueOnce(batch("m1", "m2"))
    m.executeSdkTurn.mockResolvedValue({ ok: false, errorDetail: "invalid api key", failureKind: "auth" })
    start()

    await vi.waitFor(() => expect(m.onSdkWorkerFinished).toHaveBeenCalledTimes(1))
    expect(m.onSdkWorkerFinished).toHaveBeenCalledWith(key, true, {
      kind: "auth",
      errorDetail: "invalid api key",
      replyToMessageId: "m2",
    })
  })

  it("回合里抛异常（比如发给 Agent 时 fetch 失败）：按报错文字归类，同样带上这条消息", async () => {
    m.hostBlockingPoll.mockResolvedValueOnce(batch("m1"))
    m.executeSdkTurn.mockRejectedValue(new Error("fetch failed"))
    start()

    await vi.waitFor(() => expect(m.onSdkWorkerFinished).toHaveBeenCalledTimes(1))
    expect(m.onSdkWorkerFinished).toHaveBeenCalledWith(key, true, {
      kind: "network",
      errorDetail: "fetch failed",
      replyToMessageId: "m1",
    })
  })

  it("上一轮已经处理完、之后是 poll 自己出错：没有消息在处理，不能带上一轮的旧消息", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation(() => {
      polls++
      return polls === 1 ? Promise.resolve(batch("m1")) : Promise.reject(new Error("poll HTTP 500"))
    })
    m.executeSdkTurn.mockResolvedValue({ ok: true })
    start()

    await vi.waitFor(() => expect(m.onSdkWorkerFinished).toHaveBeenCalledTimes(1))
    const [, errored, opts] = m.onSdkWorkerFinished.mock.calls[0]
    expect(errored).toBe(true)
    expect(opts.errorDetail).toBe("poll HTTP 500")
    expect(opts.replyToMessageId).toBeUndefined()
  })

  it("被主动停止：不算出错，也不带消息", async () => {
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => hangUntilAbort(signal))
    start()
    await vi.waitFor(() => expect(m.hostBlockingPoll).toHaveBeenCalled())
    await stopSdkWorker(key)

    expect(m.onSdkWorkerFinished).toHaveBeenCalledWith(key, false, { kind: undefined, errorDetail: undefined, replyToMessageId: undefined })
  })
})

describe("LLM worker 失败", () => {
  const key = "l-fail"
  const session = () => ({
    sessionKey: key,
    abort: new AbortController(),
    lastActivityAt: 0,
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
  })
  const start = () =>
    void startLlmWorkerLoop(session() as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })

  it("回合报错但会话还能用：这批消息作废，各通道都提示「需要重发」，worker 不退出", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls === 1 ? Promise.resolve(batch("m1", "m2")) : hangUntilAbort(signal)
    })
    m.executeLlmPiTurn.mockResolvedValue({ ok: false, error: "429 Rate limit reached（grok · openai · https://gw）" })
    start()

    await vi.waitFor(() => expect(m.reportAgentFailure).toHaveBeenCalledTimes(1))
    expect(m.reportAgentFailure).toHaveBeenCalledWith(key, {
      kind: "quota",
      detail: "429 Rate limit reached（grok · openai · https://gw）",
      retry: "resend",
      replyToMessageId: "m2",
    })
    expect(m.markMessagesProcessed).toHaveBeenCalledTimes(1)
    expect(m.hostTouchSessionReply).toHaveBeenCalledWith(key)
    expect(m.onLlmWorkerFinished).not.toHaveBeenCalled()

    await stopLlmWorker(key)
  })

  it("通道换了 Agent 资源（用户自己的操作）：worker 退出交给新引擎，不当故障、不提示", async () => {
    m.hostBlockingPoll.mockResolvedValueOnce(batch("m1"))
    m.executeLlmPiTurn.mockResolvedValue({ ok: false, error: "通道已换 Agent 资源，本会话改用新引擎重新拉起", fatal: true })
    start()

    await vi.waitFor(() => expect(m.onLlmWorkerFinished).toHaveBeenCalledTimes(1))
    const [, errored, opts] = m.onLlmWorkerFinished.mock.calls[0]
    expect(errored).toBe(true)
    expect(opts.replyToMessageId).toBeUndefined()
    expect(m.reportAgentFailure).not.toHaveBeenCalled()
  })

  it("回合里抛出异常、worker 退出：交出失败类别、原始报错和这条消息，由调度器自动重试", async () => {
    m.hostBlockingPoll.mockResolvedValueOnce(batch("m1"))
    m.executeLlmPiTurn.mockImplementation(() => { throw new Error("socket hang up") })
    start()

    await vi.waitFor(() => expect(m.onLlmWorkerFinished).toHaveBeenCalledTimes(1))
    expect(m.onLlmWorkerFinished).toHaveBeenCalledWith(key, true, {
      kind: "network",
      errorDetail: "socket hang up",
      replyToMessageId: "m1",
    })
    expect(m.reportAgentFailure).not.toHaveBeenCalled()
  })
})
