/**
 * 会话快滚动的提醒在 worker 里的去向：每个回合开始前量一次账本，量到的结果交给提示词组装；
 * 量不出来（抛错）不能挡住回合。SDK 和 LLM 两个 worker 各验一遍，真实 worker 循环 + 替身的引擎 / poll / 账本测量。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  assembleSdk: vi.fn(),
  assembleLlm: vi.fn(),
  nearRollover: vi.fn(),
  executeSdkTurn: vi.fn(),
  executeLlmPiTurn: vi.fn(),
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
}))

vi.mock("../electron/agent-activity", () => ({ noteAgentActivity: vi.fn() }))
vi.mock("../electron/agent-sdk", () => ({
  executeSdkTurn: m.executeSdkTurn,
  finishInterruptedTurn: vi.fn(async () => undefined),
  onSdkWorkerFinished: vi.fn(),
  unregisterSdkSessionForWorker: vi.fn(async () => undefined),
}))
vi.mock("../electron/agent-llm", () => ({
  executeLlmPiTurn: m.executeLlmPiTurn,
  onLlmWorkerFinished: vi.fn(),
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
vi.mock("../electron/prompt-assembler", () => ({
  assembleSdkWorkerTurnPrompt: m.assembleSdk,
  assembleTurnPrompt: m.assembleLlm,
}))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: vi.fn(), replyTexts: vi.fn(() => []) }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn(), isFeishuStreamEnabled: () => false }))
vi.mock("../electron/session-retention", () => ({
  rolloverSessionLedgerIfNeeded: async () => false,
  isSessionLedgerNearRollover: m.nearRollover,
}))

import { startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"
import { startLlmWorkerLoop, stopLlmWorker } from "../electron/llm-session-worker"

function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

/** 依次交付这些消息（每次一条），交完就一直挂着，直到 worker 被停止 */
function deliver(...texts: string[]): void {
  let i = 0
  m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) =>
    i < texts.length
      ? Promise.resolve({ messages: [{ text: texts[i], messageId: `m${++i}` }] })
      : hangUntilAbort(signal),
  )
}

const optsOfCall = (fn: typeof m.assembleSdk, n: number) => fn.mock.calls[n]![2] as { ledgerNearLimit?: boolean }

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
  m.hostNonBlockingPoll.mockResolvedValue({ messages: [] })
  m.assembleSdk.mockReturnValue("prompt")
  m.assembleLlm.mockReturnValue("prompt")
  m.executeSdkTurn.mockResolvedValue({ ok: true, networkFail: false, permanentFail: false })
  m.executeLlmPiTurn.mockResolvedValue({ ok: true, replyText: "好的" })
})

describe("SDK worker", () => {
  const key = "s-ledger-notice"
  const start = () => {
    const session = {
      sessionKey: key,
      workspaceDir: "D:\\ws\\demo",
      run: null,
      abortController: new AbortController(),
      seenMessageIds: new Set<string>(),
      processedMessageIds: new Set<string>(),
    }
    void startSdkWorkerLoop(session as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })
  }

  it("回合开始前按本会话的 SDK 账本量一次，量到的结果原样交给提示词组装", async () => {
    m.nearRollover.mockResolvedValue(true)
    deliver("第一条")
    start()
    await vi.waitFor(() => expect(m.executeSdkTurn).toHaveBeenCalledTimes(1))

    expect(m.nearRollover).toHaveBeenCalledWith({ runtime: "sdk", sessionKey: key, workspaceDir: "D:\\ws\\demo" })
    expect(optsOfCall(m.assembleSdk, 0).ledgerNearLimit).toBe(true)
    // 先量、再组装、再跑回合
    expect(m.nearRollover.mock.invocationCallOrder[0]).toBeLessThan(m.assembleSdk.mock.invocationCallOrder[0]!)
    expect(m.assembleSdk.mock.invocationCallOrder[0]).toBeLessThan(m.executeSdkTurn.mock.invocationCallOrder[0]!)
    await stopSdkWorker(key)
  })

  it("每个回合各量各的：这一轮快满、下一轮（账本已滚动）就不再带", async () => {
    m.nearRollover.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    deliver("第一条", "第二条")
    start()
    await vi.waitFor(() => expect(m.executeSdkTurn).toHaveBeenCalledTimes(2))

    expect(m.nearRollover).toHaveBeenCalledTimes(2)
    expect(optsOfCall(m.assembleSdk, 0).ledgerNearLimit).toBe(true)
    expect(optsOfCall(m.assembleSdk, 1).ledgerNearLimit).toBe(false)
    await stopSdkWorker(key)
  })

  it("量账本抛错：这一轮不提醒，回合照常跑完", async () => {
    m.nearRollover.mockRejectedValue(new Error("磁盘忙"))
    deliver("第一条")
    start()
    await vi.waitFor(() => expect(m.executeSdkTurn).toHaveBeenCalledTimes(1))

    expect(optsOfCall(m.assembleSdk, 0).ledgerNearLimit).toBe(false)
    await stopSdkWorker(key)
  })
})

describe("LLM worker", () => {
  const key = "l-ledger-notice"
  const start = () => {
    const session = {
      sessionKey: key,
      abort: new AbortController(),
      lastActivityAt: 0,
      seenMessageIds: new Set<string>(),
      processedMessageIds: new Set<string>(),
    }
    void startLlmWorkerLoop(session as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })
  }

  it("回合开始前按本会话的 LLM 账本量一次，量到的结果原样交给提示词组装", async () => {
    m.nearRollover.mockResolvedValue(true)
    deliver("第一条")
    start()
    await vi.waitFor(() => expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1))

    expect(m.nearRollover).toHaveBeenCalledWith({ runtime: "llm", sessionKey: key })
    expect(optsOfCall(m.assembleLlm, 0).ledgerNearLimit).toBe(true)
    expect(m.nearRollover.mock.invocationCallOrder[0]).toBeLessThan(m.assembleLlm.mock.invocationCallOrder[0]!)
    expect(m.assembleLlm.mock.invocationCallOrder[0]).toBeLessThan(m.executeLlmPiTurn.mock.invocationCallOrder[0]!)
    await stopLlmWorker(key)
  })

  it("每个回合各量各的：这一轮快满、下一轮（账本已滚动）就不再带", async () => {
    m.nearRollover.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    deliver("第一条", "第二条")
    start()
    await vi.waitFor(() => expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(2))

    expect(m.nearRollover).toHaveBeenCalledTimes(2)
    expect(optsOfCall(m.assembleLlm, 0).ledgerNearLimit).toBe(true)
    expect(optsOfCall(m.assembleLlm, 1).ledgerNearLimit).toBe(false)
    await stopLlmWorker(key)
  })

  it("量账本抛错：这一轮不提醒，回合照常跑完", async () => {
    m.nearRollover.mockRejectedValue(new Error("磁盘忙"))
    deliver("第一条")
    start()
    await vi.waitFor(() => expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1))

    expect(optsOfCall(m.assembleLlm, 0).ledgerNearLimit).toBe(false)
    await stopLlmWorker(key)
  })
})
