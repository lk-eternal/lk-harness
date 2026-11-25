import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 宿主提示词在 worker 里的去向：每一轮都问 planHostPrompt（带着会话上记的指纹），它说要给才放进这一轮；
 * 交付成功（或回合被软打断——模型已经看过）才把指纹记到会话上，失败不记（下一轮再带）。
 * 真实 worker 循环 + 替身的 agent-sdk / poll-host / prompt-assembler。
 */
const mocks = vi.hoisted(() => ({
  assemble: vi.fn(),
  plan: vi.fn(),
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
vi.mock("../electron/prompt-assembler", () => ({
  assembleSdkWorkerTurnPrompt: mocks.assemble,
  planHostPrompt: mocks.plan,
}))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: mocks.appendMirrorTurns, replyTexts: mocks.replyTexts }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))
vi.mock("../electron/session-retention", () => ({
  rolloverSessionLedgerIfNeeded: mocks.rollover,
}))

import { interruptSdkWorkerTurn, startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"

interface FakeSession {
  sessionKey: string
  run: { cancel: ReturnType<typeof vi.fn> } | null
  abortController: AbortController
  seenMessageIds: Set<string>
  processedMessageIds: Set<string>
  streamAgg: { segments: unknown[] } | null
  interruptRequested?: boolean
  protocolHash?: string
}

function fakeSession(sessionKey: string, cancel?: () => void): FakeSession {
  return {
    sessionKey,
    run: { cancel: vi.fn(async () => { cancel?.() }) },
    abortController: new AbortController(),
    seenMessageIds: new Set<string>(),
    processedMessageIds: new Set<string>(),
    streamAgg: null,
  }
}

const V1 = { text: "宿主提示词-v1", hash: "hash-v1", reason: "new-ledger" as const }
const V2 = { text: "（更新）宿主提示词-v2", hash: "hash-v2", reason: "changed" as const }

/** 现在的宿主提示词是 current：会话上记的指纹和它一样就不给，否则给 */
function currentHostPromptIs(current: { text: string; hash: string; reason: "new-ledger" | "changed" }): void {
  mocks.plan.mockImplementation((_ctx: unknown, delivered: string | undefined) => (delivered === current.hash ? undefined : current))
}

function start(session: FakeSession): void {
  void startSdkWorkerLoop(session as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true, withMemory: false })
}

/** 第一轮在跑（被测试手动结束），返回结束它的函数 */
function firstTurnRunning(): { end: (r?: Record<string, unknown>) => void } {
  mocks.hostNonBlockingPoll.mockResolvedValue({ messages: [{ text: "第一条", messageId: "m1" }] })
  const handle: { end: (r?: Record<string, unknown>) => void } = { end: () => undefined }
  mocks.executeSdkTurn.mockImplementationOnce(() => new Promise((resolve) => {
    handle.end = (r) => resolve({ ok: true, ...r })
  }))
  return handle
}

/** 之后的监听：第一次领到排队的消息，再之后一直挂着，直到 worker 被停止 */
function thenQueued(messages: Array<{ text: string; messageId: string }>): void {
  mocks.hostBlockingPoll
    .mockImplementationOnce(async () => ({ messages }))
    .mockImplementation((_key: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
}

const hostPromptOfCall = (n: number) => (mocks.assemble.mock.calls[n][2] as { hostPrompt?: string }).hostPrompt

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.assemble.mockReturnValue("prompt")
  mocks.replyTexts.mockReturnValue([])
  mocks.rollover.mockResolvedValue(false)
  mocks.finishInterruptedTurn.mockResolvedValue(undefined)
  mocks.markMessagesProcessed.mockResolvedValue(undefined)
})

describe("宿主提示词按指纹给", () => {
  it("新账本：第一轮给，交付成功后指纹记到会话上，第二轮不再给", async () => {
    currentHostPromptIs(V1)
    const turn = firstTurnRunning()
    thenQueued([{ text: "排队的", messageId: "m2" }])
    mocks.executeSdkTurn.mockImplementationOnce(async () => ({ ok: true }))
    const session = fakeSession("s-host-1")

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end()
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(2))

    expect(mocks.assemble).toHaveBeenCalledTimes(2)
    expect(hostPromptOfCall(0)).toBe(V1.text)
    expect(hostPromptOfCall(1)).toBeUndefined()
    expect(mocks.plan.mock.calls[0][1]).toBeUndefined()
    expect(mocks.plan.mock.calls[1][1]).toBe(V1.hash)
    await stopSdkWorker("s-host-1")
  })

  it("账本里已经是现在这一版（续上的会话）：每一轮都不给，指纹原样保留", async () => {
    currentHostPromptIs(V1)
    const turn = firstTurnRunning()
    thenQueued([{ text: "排队的", messageId: "m2" }])
    mocks.executeSdkTurn.mockImplementationOnce(async () => ({ ok: true }))
    const session = fakeSession("s-host-2")
    session.protocolHash = V1.hash

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end()
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(2))

    expect(hostPromptOfCall(0)).toBeUndefined()
    expect(hostPromptOfCall(1)).toBeUndefined()
    expect(session.protocolHash).toBe(V1.hash)
    await stopSdkWorker("s-host-2")
  })

  it("worker 常驻期间规则或名单变了：下一轮补发最新的，并记下新指纹", async () => {
    currentHostPromptIs(V1)
    const turn = firstTurnRunning()
    thenQueued([{ text: "排队的", messageId: "m2" }])
    mocks.executeSdkTurn.mockImplementationOnce(async () => ({ ok: true }))
    const session = fakeSession("s-host-3")
    session.protocolHash = V1.hash

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    currentHostPromptIs(V2) // 第一轮跑的时候，用户改了规则
    turn.end()
    await vi.waitFor(() => expect(session.protocolHash).toBe(V2.hash))

    expect(hostPromptOfCall(0)).toBeUndefined()
    expect(hostPromptOfCall(1)).toBe(V2.text)
    await stopSdkWorker("s-host-3")
  })
})

describe("什么时候记下「模型手里的宿主提示词版本」", () => {
  it("第一轮成功：记下新指纹（覆盖旧的）", async () => {
    currentHostPromptIs(V2)
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-host-4")
    session.protocolHash = V1.hash

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(session.protocolHash).toBe(V1.hash) // 回合还在跑，没确认交付前不改
    turn.end()
    await vi.waitFor(() => expect(session.protocolHash).toBe(V2.hash))
    await stopSdkWorker("s-host-4")
  })

  it("第一轮失败：不记（下一轮会再带一次）", async () => {
    currentHostPromptIs(V1)
    const turn = firstTurnRunning()
    const session = fakeSession("s-host-5")

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end({ ok: false, errorDetail: "boom" })
    await vi.waitFor(() => expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1))

    expect(session.protocolHash).toBeUndefined()
  })

  it("第一轮失败时已有旧指纹：旧的保持不变，不会被新指纹覆盖", async () => {
    currentHostPromptIs(V2)
    const turn = firstTurnRunning()
    const session = fakeSession("s-host-6")
    session.protocolHash = V1.hash

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end({ ok: false, errorDetail: "boom" })
    await vi.waitFor(() => expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1))

    expect(session.protocolHash).toBe(V1.hash)
  })

  it("第一轮被软打断：模型已经看过宿主提示词，照样记下", async () => {
    currentHostPromptIs(V1)
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-host-7", () => turn.end({ ok: false, errorDetail: "cancelled" }))

    start(session)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(await interruptSdkWorkerTurn("s-host-7")).toBe("interrupted")

    expect(session.protocolHash).toBe(V1.hash)
    await stopSdkWorker("s-host-7")
  })
})
