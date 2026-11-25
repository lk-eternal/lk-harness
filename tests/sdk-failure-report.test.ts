import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 onSdkWorkerFinished：worker 出错退出时，失败类别要同时决定重试节奏（退避）和给用户的提示。
 * 这里只验证两头接对了：类别 → 退避；出错退出 → 提示一次（带上出事的那条消息）。
 */
const h = vi.hoisted(() => ({
  report: vi.fn(async () => undefined),
  clearNotices: vi.fn(),
  clearAllNotices: vi.fn(),
}))

vi.mock("electron", () => ({
  app: { getPath: () => "", isPackaged: false, getAppPath: () => "", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock("@cursor/sdk", () => ({
  Agent: { resume: vi.fn(), create: vi.fn(), listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() },
  Cursor: { models: { list: vi.fn(async () => []) } },
  JsonlLocalAgentStore: class {},
}))
vi.mock("../electron/ui-logger", () => ({
  pushUiLog: vi.fn(),
  broadcastLog: vi.fn(),
  broadcastSessionStatus: vi.fn(),
}))
vi.mock("../electron/config-store", () => ({
  getAgentResource: vi.fn(() => ({})),
  resolveChannelForSession: vi.fn(() => undefined),
}))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: vi.fn(() => null),
  httpPost: vi.fn(async () => ({})),
  notifySessionLaunched: vi.fn(async () => undefined),
}))
vi.mock("../electron/prompt-assembler", () => ({
  resolveDaemonPortForPrompt: vi.fn(() => undefined),
}))
vi.mock("../electron/sdk-session-worker", () => ({
  startSdkWorkerLoop: vi.fn(() => new Promise<void>(() => {})),
  isSdkWorkerActive: vi.fn(() => false),
  stopSdkWorker: vi.fn(async () => undefined),
}))
vi.mock("../electron/agent-failure-notice", () => ({
  reportAgentFailure: h.report,
  clearFailureNotices: h.clearNotices,
  clearAllFailureNotices: h.clearAllNotices,
}))

import { clearAllSdkFailStreaks, clearSdkFailStreak, onSdkWorkerFinished, sdkFailCooldownRemaining } from "../electron/agent-sdk"

const KEY = "ch_t|oc_chat::D:/ws"

beforeEach(() => {
  clearAllSdkFailStreaks()
  h.report.mockClear()
  h.clearNotices.mockClear()
  h.clearAllNotices.mockClear()
})

describe("失败类别决定重试节奏", () => {
  it.each(["auth", "quota", "model"] as const)("%s：永久性错误，按阶梯退避（5s → 10s）", (kind) => {
    onSdkWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    const first = sdkFailCooldownRemaining(KEY)
    expect(first).toBeGreaterThan(4_000)
    expect(first).toBeLessThanOrEqual(5_000)

    onSdkWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    const second = sdkFailCooldownRemaining(KEY)
    expect(second).toBeGreaterThan(9_000)
    expect(second).toBeLessThanOrEqual(10_000)
  })

  it.each(["network", "other", undefined] as const)("%s：不退避，立即重试", (kind) => {
    onSdkWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    onSdkWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    expect(sdkFailCooldownRemaining(KEY)).toBe(0)
  })

  it("最近一次失败的类别说了算：从 Key 无效变成网络问题，退避随之解除", () => {
    onSdkWorkerFinished(KEY, true, { kind: "auth", errorDetail: "x" })
    expect(sdkFailCooldownRemaining(KEY)).toBeGreaterThan(0)
    onSdkWorkerFinished(KEY, true, { kind: "network", errorDetail: "x" })
    expect(sdkFailCooldownRemaining(KEY)).toBe(0)
  })

  it("正常退出：清掉失败记录，退避和提示限频一起归零", () => {
    onSdkWorkerFinished(KEY, true, { kind: "auth", errorDetail: "x" })
    onSdkWorkerFinished(KEY, false)
    expect(sdkFailCooldownRemaining(KEY)).toBe(0)
    expect(h.clearNotices).toHaveBeenCalledWith(KEY)
  })

  it("手动清除失败记录（换 Key、清队列）时，提示限频也一起清", () => {
    clearSdkFailStreak(KEY)
    expect(h.clearNotices).toHaveBeenCalledWith(KEY)
    clearAllSdkFailStreaks()
    expect(h.clearAllNotices).toHaveBeenCalled()
  })
})

describe("出错退出时告诉用户", () => {
  it("带上失败类别、原始报错和出事的那条消息；消息会被调度器自动重试", () => {
    onSdkWorkerFinished(KEY, true, { kind: "quota", errorDetail: "quota exceeded", replyToMessageId: "om_1" })

    expect(h.report).toHaveBeenCalledTimes(1)
    expect(h.report).toHaveBeenCalledWith(KEY, {
      kind: "quota",
      detail: "quota exceeded",
      retry: "auto",
      replyToMessageId: "om_1",
    })
  })

  it("没分出类别的按「其他」报", () => {
    onSdkWorkerFinished(KEY, true, { errorDetail: "boom", replyToMessageId: "om_1" })
    expect(h.report).toHaveBeenCalledWith(KEY, expect.objectContaining({ kind: "other" }))
  })

  it("正常退出不提示", () => {
    onSdkWorkerFinished(KEY, false)
    expect(h.report).not.toHaveBeenCalled()
  })
})
