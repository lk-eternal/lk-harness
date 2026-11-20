import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 onLlmWorkerFinished：和 SDK 引擎同一套口径——失败类别同时决定重试节奏（退避）和给用户的提示。
 */
const h = vi.hoisted(() => ({
  report: vi.fn(async () => undefined),
  clearNotices: vi.fn(),
  clearAllNotices: vi.fn(),
}))

vi.mock("electron", () => ({
  app: { getPath: () => "", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("../electron/ui-logger", () => ({
  pushUiLog: () => {},
  broadcastLog: () => {},
  broadcastSessionStatus: () => {},
}))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: () => null,
  httpPost: async () => ({}),
  notifySessionLaunched: async () => {},
}))
vi.mock("../electron/agent-env", () => ({ syncMainProcessProxyEnv: () => {} }))
vi.mock("../electron/llm-proxy", () => ({ llmProxyConfigured: () => false, withLlmProxyOptions: (o: unknown) => o }))
vi.mock("../electron/config-store", async (orig) => ({
  ...(await orig<typeof import("../electron/config-store")>()),
  getChannel: () => undefined,
  resolveChannelForSession: () => undefined,
  resolveChannelModel: () => ({ model: "", modelParams: "" }),
  getConfig: () => ({ agentResources: [] }),
}))
vi.mock("../electron/llm-config", () => ({
  llmApiKey: () => "sk-test",
  llmProviderId: () => "fake",
  resolveLlmModel: () => undefined,
}))
vi.mock("../electron/llm-model-catalog", () => ({ lookupModelThinkingLevels: () => undefined }))
vi.mock("../electron/pi-resume-store", () => ({
  forgetPiResumable: () => {},
  getPiResumable: () => undefined,
  rememberPiResumable: () => {},
  patchPiResumableStreamCard: () => {},
}))
vi.mock("../electron/pi-embedded", () => ({
  createHarnessPiSession: async () => ({}),
  hasPersistedPiSession: () => false,
  clearPiSession: () => {},
  readPiSessionTurns: () => [],
}))
vi.mock("../electron/llm-session-worker.js", () => ({
  startLlmWorkerLoop: () => Promise.resolve(),
  isLlmWorkerActive: () => false,
  stopLlmWorker: async () => {},
  stopAllLlmWorkers: async () => {},
  getLlmWorkerPhase: () => null,
}))
vi.mock("../electron/agent-failure-notice", () => ({
  reportAgentFailure: h.report,
  clearFailureNotices: h.clearNotices,
  clearAllFailureNotices: h.clearAllNotices,
}))

import { clearAllLlmFailStreaks, clearLlmFailStreak, llmFailCooldownRemaining, onLlmWorkerFinished } from "../electron/agent-llm"

const KEY = "ch_t|oc_chat::D:/ws"

beforeEach(() => {
  clearAllLlmFailStreaks()
  h.report.mockClear()
  h.clearNotices.mockClear()
  h.clearAllNotices.mockClear()
})

describe("失败类别决定重试节奏", () => {
  it.each(["auth", "quota", "model"] as const)("%s：永久性错误，按阶梯退避（5s → 10s）", (kind) => {
    onLlmWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    const first = llmFailCooldownRemaining(KEY)
    expect(first).toBeGreaterThan(4_000)
    expect(first).toBeLessThanOrEqual(5_000)

    onLlmWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    const second = llmFailCooldownRemaining(KEY)
    expect(second).toBeGreaterThan(9_000)
    expect(second).toBeLessThanOrEqual(10_000)
  })

  it.each(["network", "other", undefined] as const)("%s：不退避，立即重试", (kind) => {
    onLlmWorkerFinished(KEY, true, { kind, errorDetail: "x" })
    expect(llmFailCooldownRemaining(KEY)).toBe(0)
  })

  it("正常退出和手动清除：退避与提示限频一起归零", () => {
    onLlmWorkerFinished(KEY, true, { kind: "auth", errorDetail: "x" })
    onLlmWorkerFinished(KEY, false)
    expect(llmFailCooldownRemaining(KEY)).toBe(0)
    expect(h.clearNotices).toHaveBeenCalledWith(KEY)

    clearLlmFailStreak(KEY)
    expect(h.clearNotices).toHaveBeenCalledTimes(2)
    clearAllLlmFailStreaks()
    expect(h.clearAllNotices).toHaveBeenCalled()
  })
})

describe("出错退出时告诉用户", () => {
  it("带上失败类别、原始报错和出事的那条消息；消息会被调度器自动重试", () => {
    onLlmWorkerFinished(KEY, true, { kind: "network", errorDetail: "fetch failed", replyToMessageId: "om_1" })

    expect(h.report).toHaveBeenCalledWith(KEY, {
      kind: "network",
      detail: "fetch failed",
      retry: "auto",
      replyToMessageId: "om_1",
    })
  })

  it("没分出类别的按「其他」报；正常退出不提示", () => {
    onLlmWorkerFinished(KEY, true, { errorDetail: "boom", replyToMessageId: "om_1" })
    expect(h.report).toHaveBeenCalledWith(KEY, expect.objectContaining({ kind: "other" }))

    h.report.mockClear()
    onLlmWorkerFinished(KEY, false)
    expect(h.report).not.toHaveBeenCalled()
  })
})
