/**
 * Pi 的规则和 Skill 名单在拉起时就定进系统提示词了，worker 活着期间不会再读。
 * 所以 worker 每次领到消息要比一下：现在这一版和拉起时的不一样，这批消息就不确认、不处理，
 * worker 正常退出，由 daemon 重投、调度器重新拉起，下一轮用新的。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  executeLlmPiTurn: vi.fn(),
  onLlmWorkerFinished: vi.fn(),
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
  markMessagesProcessed: vi.fn(async () => undefined),
}))

vi.mock("../electron/agent-activity", () => ({ noteAgentActivity: vi.fn() }))
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
  markMessagesProcessed: m.markMessagesProcessed,
}))
vi.mock("../electron/agent-failure-notice", () => ({ reportAgentFailure: vi.fn(async () => undefined) }))
vi.mock("../electron/prompt-assembler", () => ({ assembleTurnPrompt: vi.fn(() => "prompt") }))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: vi.fn(), replyTexts: vi.fn(() => []) }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))
vi.mock("../electron/session-retention", () => ({ rolloverSessionLedgerIfNeeded: async () => false }))

import { startLlmWorkerLoop, stopLlmWorker, type HostPromptProbe } from "../electron/llm-session-worker"

const key = "l-host-prompt"

function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

const batch = (...ids: string[]) => ({ messages: ids.map((id) => ({ text: `消息 ${id}`, messageId: id })) })

const start = (hostPrompt: HostPromptProbe) =>
  void startLlmWorkerLoop(
    {
      sessionKey: key,
      abort: new AbortController(),
      lastActivityAt: 0,
      seenMessageIds: new Set<string>(),
      processedMessageIds: new Set<string>(),
    } as never,
    { persistentPoll: true, promptCtx: {} as never, hostPrompt, firstTurn: true, withMemory: false },
  )

beforeEach(() => {
  for (const fn of [m.executeLlmPiTurn, m.onLlmWorkerFinished, m.hostNonBlockingPoll, m.hostBlockingPoll, m.markMessagesProcessed]) {
    fn.mockReset()
  }
  m.hostNonBlockingPoll.mockResolvedValue({ messages: [] })
})

describe("LLM worker：领到消息时比对宿主提示词", () => {
  it("规则或 Skill 名单变了：这批消息不处理、不确认，worker 正常退出交给调度器重新拉起", async () => {
    m.hostBlockingPoll.mockResolvedValueOnce(batch("m1"))
    start({ launched: "v1", current: () => "v2" })

    await vi.waitFor(() => expect(m.onLlmWorkerFinished).toHaveBeenCalledTimes(1))
    expect(m.onLlmWorkerFinished).toHaveBeenCalledWith(key, false, { kind: undefined, errorDetail: undefined, replyToMessageId: undefined })
    expect(m.executeLlmPiTurn).not.toHaveBeenCalled()
    expect(m.markMessagesProcessed).not.toHaveBeenCalled()
  })

  it("没变：照常处理这批消息，worker 继续挂着", async () => {
    let polls = 0
    m.hostBlockingPoll.mockImplementation((_k: string, signal: AbortSignal) => {
      polls++
      return polls === 1 ? Promise.resolve(batch("m1")) : hangUntilAbort(signal)
    })
    m.executeLlmPiTurn.mockResolvedValue({ ok: true, replyText: "好" })
    start({ launched: "v1", current: () => "v1" })

    await vi.waitFor(() => expect(m.markMessagesProcessed).toHaveBeenCalledTimes(1))
    expect(m.executeLlmPiTurn).toHaveBeenCalledTimes(1)
    expect(m.onLlmWorkerFinished).not.toHaveBeenCalled()

    await stopLlmWorker(key)
  })
})
