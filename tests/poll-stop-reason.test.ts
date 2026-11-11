import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * poll-message 的空返回协议：daemon 只给宿主 Session Worker 一个机器可读的 reason（end / timeout），
 * 没有写给模型看的 directive 文案——Agent 本身不 poll。
 * 这里锁两件事：poll-host 怎么解析响应、worker 对 reason 怎么反应。
 */
const mocks = vi.hoisted(() => ({
  hostNonBlockingPoll: vi.fn(),
  hostBlockingPoll: vi.fn(),
  executeSdkTurn: vi.fn(),
  onSdkWorkerFinished: vi.fn(),
  unregister: vi.fn(),
}))

// poll-host 在 worker 测试里是替身，在解析测试里取真身（importActual）
vi.mock("../electron/daemon-client", () => ({ readLockFile: () => ({ port: 4321 }), httpPost: vi.fn() }))
vi.mock("../electron/poll-host", () => ({
  hostBlockingPoll: mocks.hostBlockingPoll,
  hostNonBlockingPoll: mocks.hostNonBlockingPoll,
  hostConfirmClaimed: vi.fn(async () => undefined),
  hostTouchSessionReply: vi.fn(async () => undefined),
  markMessagesProcessed: vi.fn(async () => undefined),
}))
vi.mock("../electron/agent-sdk", () => ({
  executeSdkTurn: mocks.executeSdkTurn,
  onSdkWorkerFinished: mocks.onSdkWorkerFinished,
  unregisterSdkSessionForWorker: mocks.unregister,
  finishInterruptedTurn: vi.fn(),
}))
vi.mock("../electron/prompt-assembler", () => ({ assembleSdkWorkerTurnPrompt: vi.fn(() => "prompt") }))
vi.mock("../electron/carryover", () => ({ appendMirrorTurns: vi.fn(), replyTexts: vi.fn(() => []) }))
vi.mock("../electron/ui-logger", () => ({ pushUiLog: vi.fn() }))
vi.mock("../electron/stream-card", () => ({ rebaseUnensuredQueue: vi.fn() }))

const realPollHost = () => vi.importActual<typeof import("../electron/poll-host")>("../electron/poll-host")

describe("poll-host：解析 daemon 的 poll 响应", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const respond = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, json: async () => body })

  it("end / timeout 原样带出 reason", async () => {
    const { hostBlockingPoll } = await realPollHost()
    respond({ messages: [], reason: "end" })
    await expect(hostBlockingPoll("s1")).resolves.toEqual({ messages: [], reason: "end" })
    respond({ messages: [], reason: "timeout" })
    await expect(hostBlockingPoll("s1")).resolves.toEqual({ messages: [], reason: "timeout" })
  })

  it("有消息时没有 reason；不认识的 reason 一律忽略（不会误判成退出）", async () => {
    const { hostBlockingPoll } = await realPollHost()
    respond({ messages: [{ text: "你好", messageId: "m1" }] })
    await expect(hostBlockingPoll("s1")).resolves.toEqual({ messages: [{ text: "你好", messageId: "m1" }] })
    respond({ messages: [], reason: "messages" })
    expect((await hostBlockingPoll("s1")).reason).toBeUndefined()
  })

  it("宿主只看 reason：directive 文案（旧协议）不再被识别", async () => {
    const { hostBlockingPoll } = await realPollHost()
    respond({ messages: [], directive: "本回合结束（按需唤醒模式）。禁止调用任何工具、禁止输出任何文字，安静退出。" })
    await expect(hostBlockingPoll("s1")).resolves.toEqual({ messages: [] })
  })

  it("非阻塞 poll 带 wait=false，阻塞 poll 不带", async () => {
    const { hostBlockingPoll, hostNonBlockingPoll } = await realPollHost()
    respond({ messages: [] })
    await hostNonBlockingPoll("s1")
    await hostBlockingPoll("s1")
    expect(String(fetchMock.mock.calls[0][0])).toContain("wait=false")
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("wait=")
  })
})

describe("SDK worker：按 reason 决定退出还是续挂", () => {
  const fakeSession = (sessionKey: string) => ({
    sessionKey,
    run: null,
    abortController: new AbortController(),
    processedMessageIds: new Set<string>(),
    streamAgg: null,
  })

  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.unregister.mockResolvedValue(undefined)
    // 冷启动的 instant poll 没有消息，接着进入阻塞监听
    mocks.hostNonBlockingPoll.mockResolvedValue({ messages: [] })
  })

  it("timeout：续挂，再挂一次 poll；拿到 end 才退出，且不算异常结束", async () => {
    const { startSdkWorkerLoop } = await import("../electron/sdk-session-worker")
    mocks.hostBlockingPoll
      .mockResolvedValueOnce({ messages: [], reason: "timeout" })
      .mockResolvedValueOnce({ messages: [], reason: "timeout" })
      .mockResolvedValueOnce({ messages: [], reason: "end" })

    await startSdkWorkerLoop(fakeSession("s-reason-1") as never, { persistentPoll: true, promptCtx: {} as never, firstTurn: true })

    expect(mocks.hostBlockingPoll).toHaveBeenCalledTimes(3)
    expect(mocks.executeSdkTurn).not.toHaveBeenCalled() // 空返回不会误起回合
    expect(mocks.onSdkWorkerFinished).toHaveBeenCalledTimes(1)
    expect(mocks.onSdkWorkerFinished.mock.calls[0][1]).toBe(false) // errored=false：正常退出
  })

  it("end：立刻退出，不再挂 poll", async () => {
    const { startSdkWorkerLoop } = await import("../electron/sdk-session-worker")
    mocks.hostBlockingPoll.mockResolvedValueOnce({ messages: [], reason: "end" })

    await startSdkWorkerLoop(fakeSession("s-reason-2") as never, { persistentPoll: false, promptCtx: {} as never, firstTurn: true })

    expect(mocks.hostBlockingPoll).toHaveBeenCalledTimes(1)
    expect(mocks.onSdkWorkerFinished.mock.calls[0][1]).toBe(false)
  })
})
