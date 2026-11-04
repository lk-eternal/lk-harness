import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 launchSdkAgent + 假的 @cursor/sdk：
 * Resume / Create 一直不返回（网络半断时的真实表现），验证拉起会在时限内放弃，并且上下文、重试、晚到的 Agent 都处理对。
 * 事故现场：Resume 挂了 3 分 12 秒才报 Network request failed，期间用户没有任何回应。
 */
const h = vi.hoisted(() => ({
  dir: "",
  resume: vi.fn(),
  create: vi.fn(),
}))

vi.mock("electron", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-sdk-launch-"))
  return {
    app: { getPath: () => h.dir, isPackaged: false, getAppPath: () => h.dir, getVersion: () => "0.0.0" },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  }
})
vi.mock("@cursor/sdk", () => ({
  Agent: { resume: h.resume, create: h.create, listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() },
  Cursor: { models: { list: vi.fn(async () => []) } },
  JsonlLocalAgentStore: class {},
}))
vi.mock("../electron/ui-logger", () => ({
  pushUiLog: vi.fn(),
  broadcastLog: vi.fn(),
  broadcastSessionStatus: vi.fn(),
}))
vi.mock("../electron/config-store", () => ({ getAgentResource: vi.fn(() => ({})) }))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: vi.fn(() => null),
  httpPost: vi.fn(async () => ({})),
  notifySessionLaunched: vi.fn(async () => undefined),
}))
vi.mock("../electron/prompt-assembler", () => ({
  computePromptHash: vi.fn(() => "hash"),
  resolveDaemonPortForPrompt: vi.fn(() => undefined),
}))

import { launchSdkAgent, SDK_LAUNCH_TIMEOUT_MS } from "../electron/agent-sdk"
import { isTransientLaunchError } from "../electron/launch-fail-tracker"
import { createTimeoutMessage } from "../electron/bounded-call"
import { initSessionModelStore } from "../src/shared/session-model-store"
import { getSessionRecord, patchSessionRecord } from "../src/shared/session-overrides-store"

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function track<T>(p: Promise<T>) {
  const st: { state: "pending" | "settled"; value?: T } = { state: "pending" }
  void p.then((v) => { st.state = "settled"; st.value = v }, () => { st.state = "settled" })
  return st
}

const fakeAgent = () => ({ agentId: "agent-new", close: vi.fn() })

let seq = 0
let sessionKey = ""
let workspaceDir = ""

function opts() {
  return {
    sessionKey,
    chatType: "p2p" as const,
    workspaceDir,
    apiKey: "key",
    model: "grok-4.7",
    senderOpenId: "ou_x",
  }
}

beforeEach(() => {
  process.env.CURSOR_RIPGREP_PATH = "stub" // 不去找 rg
  initSessionModelStore(h.dir)
  seq += 1
  sessionKey = `ch_t${seq}|oc_chat${seq}::${h.dir}`
  workspaceDir = h.dir
  h.resume.mockReset()
  h.create.mockReset()
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

/** 记着上一个可续接的 Agent，下一条消息会走 Resume */
function seedResumable() {
  patchSessionRecord(sessionKey, { agentId: "agent-old", workspaceDir })
}

describe("Resume 挂住", () => {
  it("到 45 秒就放弃：差 1ms 还在等，到点按「瞬时故障」失败，原来要等 3 分多钟", async () => {
    seedResumable()
    const called = deferred<void>()
    h.resume.mockImplementation(() => { called.resolve(); return new Promise(() => {}) })

    const launch = launchSdkAgent(opts())
    const st = track(launch)
    await called.promise
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS - 1)
    expect(st.state).toBe("pending")

    await vi.advanceTimersByTimeAsync(1)
    const r = await launch
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^Resume 暂不可用: .*45s/)
    // 走的是「立即重试」那条路，不是按配置类错误阶梯退避
    expect(isTransientLaunchError(r.error ?? "")).toBe(true)
    expect(SDK_LAUNCH_TIMEOUT_MS).toBe(45_000)
  })

  it("上下文保留：续接映射还在，下一条消息还能 Resume 到同一个 Agent", async () => {
    seedResumable()
    h.resume.mockImplementation(() => new Promise(() => {}))
    const launch = launchSdkAgent(opts())
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS)
    await launch
    expect(getSessionRecord(sessionKey)?.agentId).toBe("agent-old")
    expect(h.create).not.toHaveBeenCalled() // 绝不能因为超时就回退成全新会话（上下文会丢）
  })

  it("失败后不再被当成「正在启动」：下一次拉起会重新发起 Resume（事故里重试 1.5 秒就成功了）", async () => {
    seedResumable()
    h.resume.mockImplementation(() => new Promise(() => {}))
    const first = launchSdkAgent(opts())
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS)
    await first
    expect(h.resume).toHaveBeenCalledTimes(1)

    const second = launchSdkAgent(opts())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.resume).toHaveBeenCalledTimes(2)
    expect(h.resume).toHaveBeenLastCalledWith("agent-old", expect.anything())
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS)
    await second
  })

  it("超时之后才返回的 Agent 会被释放，不留没人管的实例", async () => {
    seedResumable()
    const late = deferred<ReturnType<typeof fakeAgent>>()
    h.resume.mockImplementation(() => late.promise)
    const launch = launchSdkAgent(opts())
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS)
    await launch

    const agent = fakeAgent()
    late.resolve(agent)
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.close).toHaveBeenCalledTimes(1)
  })

  it("原有行为不变：Resume 很快失败（Network request failed）照旧原样上报", async () => {
    seedResumable()
    h.resume.mockRejectedValue(new Error("Network request failed"))
    const r = await launchSdkAgent(opts())
    expect(r).toEqual({ ok: false, error: "Resume 暂不可用: Network request failed" })
    expect(getSessionRecord(sessionKey)?.agentId).toBe("agent-old")
  })

  it("原有行为不变：服务端确认「not found」才回退全新会话", async () => {
    seedResumable()
    h.resume.mockRejectedValue(new Error("agent not found"))
    h.create.mockRejectedValue(new Error("create boom"))
    const r = await launchSdkAgent(opts())
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: false, error: "create boom" })
  })
})

describe("创建 Agent 挂住", () => {
  it("同样 45 秒放弃，按瞬时故障上报", async () => {
    const called = deferred<void>()
    h.create.mockImplementation(() => { called.resolve(); return new Promise(() => {}) })
    const launch = launchSdkAgent(opts())
    const st = track(launch)
    await called.promise
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS - 1)
    expect(st.state).toBe("pending")
    await vi.advanceTimersByTimeAsync(1)
    const r = await launch
    expect(r).toEqual({ ok: false, error: createTimeoutMessage(SDK_LAUNCH_TIMEOUT_MS) })
    expect(isTransientLaunchError(r.error ?? "")).toBe(true)
  })

  it("晚到的 Agent 同样释放", async () => {
    const late = deferred<ReturnType<typeof fakeAgent>>()
    h.create.mockImplementation(() => late.promise)
    const launch = launchSdkAgent(opts())
    await vi.advanceTimersByTimeAsync(SDK_LAUNCH_TIMEOUT_MS)
    await launch
    const agent = fakeAgent()
    late.resolve(agent)
    await vi.advanceTimersByTimeAsync(0)
    expect(agent.close).toHaveBeenCalledTimes(1)
  })
})
