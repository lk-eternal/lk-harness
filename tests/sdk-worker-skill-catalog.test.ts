import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Skill 名单在 worker 里的去向：只随第一轮交给模型，之后的轮次不再带；
 * 交付成功（或回合被软打断——模型已经看过）才把指纹记到会话上，失败不记（下次拉起再带）。
 * 真实 worker 循环 + 替身的 agent-sdk / poll-host。
 */
const mocks = vi.hoisted(() => ({
  assemble: vi.fn(),
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
vi.mock("../electron/prompt-assembler", () => ({ assembleSdkWorkerTurnPrompt: mocks.assemble }))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: mocks.appendMirrorTurns, replyTexts: mocks.replyTexts }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))
vi.mock("../electron/session-retention", () => ({ rolloverSessionLedgerIfNeeded: mocks.rollover }))

import { interruptSdkWorkerTurn, startSdkWorkerLoop, stopSdkWorker } from "../electron/sdk-session-worker"

interface FakeSession {
  sessionKey: string
  run: { cancel: ReturnType<typeof vi.fn> } | null
  abortController: AbortController
  seenMessageIds: Set<string>
  processedMessageIds: Set<string>
  streamAgg: { segments: unknown[] } | null
  interruptRequested?: boolean
  skillsHash?: string
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

const CATALOG = { text: "## 本机 Skill\n- alpha：甲", hash: "hash-new" }

function start(session: FakeSession, skillCatalog?: { text: string; hash: string }): void {
  void startSdkWorkerLoop(session as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true, skillCatalog })
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
    .mockImplementationOnce(async () => ({ messages }))
    .mockImplementation((_key: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
}

const skillOptOfCall = (n: number) => (mocks.assemble.mock.calls[n][2] as { skillCatalog?: string }).skillCatalog

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.assemble.mockReturnValue("prompt")
  mocks.replyTexts.mockReturnValue([])
  mocks.rollover.mockResolvedValue(false)
  mocks.finishInterruptedTurn.mockResolvedValue(undefined)
  mocks.markMessagesProcessed.mockResolvedValue(undefined)
})

describe("名单只随第一轮交付", () => {
  it("第一轮把名单文本交给提示词组装；第二轮（队列里的消息）不再带", async () => {
    const turn = firstTurnRunning()
    thenQueued([{ text: "排队的", messageId: "m2" }])
    mocks.executeSdkTurn.mockImplementationOnce(async () => ({ ok: true, networkFail: false, permanentFail: false }))
    const session = fakeSession("s-cat-1")

    start(session, CATALOG)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end()
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(2))

    expect(mocks.assemble).toHaveBeenCalledTimes(2)
    expect(skillOptOfCall(0)).toBe(CATALOG.text)
    expect(skillOptOfCall(1)).toBeUndefined()
    await stopSdkWorker("s-cat-1")
  })

  it("不带名单启动（名单没变 / 没有 Skill）：每一轮都不带，会话上的指纹原样保留", async () => {
    const turn = firstTurnRunning()
    thenQueued([{ text: "排队的", messageId: "m2" }])
    mocks.executeSdkTurn.mockImplementationOnce(async () => ({ ok: true, networkFail: false, permanentFail: false }))
    const session = fakeSession("s-cat-2")
    session.skillsHash = "hash-old"

    start(session, undefined)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end()
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(2))

    expect(skillOptOfCall(0)).toBeUndefined()
    expect(skillOptOfCall(1)).toBeUndefined()
    expect(session.skillsHash).toBe("hash-old")
    await stopSdkWorker("s-cat-2")
  })
})

describe("什么时候记下「模型手里的名单版本」", () => {
  it("第一轮成功：记下新指纹（覆盖旧的）", async () => {
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-cat-3")
    session.skillsHash = "hash-old"

    start(session, CATALOG)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(session.skillsHash).toBe("hash-old") // 回合还在跑，没确认交付前不改
    turn.end()
    await vi.waitFor(() => expect(session.skillsHash).toBe("hash-new"))
    await stopSdkWorker("s-cat-3")
  })

  it("第一轮失败：不记（下次拉起会再带一次）", async () => {
    const turn = firstTurnRunning()
    const session = fakeSession("s-cat-4")

    start(session, CATALOG)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end({ ok: false, errorDetail: "boom" })
    await vi.waitFor(() => expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1))

    expect(session.skillsHash).toBeUndefined()
  })

  it("第一轮失败时已有旧指纹：旧的保持不变，不会被新指纹覆盖", async () => {
    const turn = firstTurnRunning()
    const session = fakeSession("s-cat-5")
    session.skillsHash = "hash-old"

    start(session, CATALOG)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    turn.end({ ok: false, errorDetail: "boom" })
    await vi.waitFor(() => expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1))

    expect(session.skillsHash).toBe("hash-old")
  })

  it("第一轮被软打断：模型已经看过名单，照样记下", async () => {
    const turn = firstTurnRunning()
    thenQueued([])
    const session = fakeSession("s-cat-6", () => turn.end({ ok: false, errorDetail: "cancelled" }))

    start(session, CATALOG)
    await vi.waitFor(() => expect(mocks.executeSdkTurn).toHaveBeenCalledTimes(1))
    expect(await interruptSdkWorkerTurn("s-cat-6")).toBe("interrupted")

    expect(session.skillsHash).toBe("hash-new")
    await stopSdkWorker("s-cat-6")
  })
})
