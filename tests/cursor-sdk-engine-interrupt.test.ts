import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * cursorSdkEngine.interruptTurn：把 worker 的打断结果翻译给调度层。
 * 关键一条：worker 还没起来但 SDK 正在拉起（Resume/Create 进行中）→ launching，
 * 调度层据此什么都不做（对一个正在慢慢拉起的 Agent 再「停止重启」只会更慢）。
 */
const m = vi.hoisted(() => ({
  interruptSdkWorkerTurn: vi.fn(),
  isSdkSessionRunning: vi.fn(),
}))

vi.mock("../electron/sdk-session-worker", () => ({ interruptSdkWorkerTurn: m.interruptSdkWorkerTurn }))
vi.mock("../electron/agent-sdk", () => {
  const stub = () => vi.fn()
  return {
    launchSdkAgent: stub(), stopSdkSession: stub(), stopAllSdkSessions: stub(),
    isSdkSessionRunning: m.isSdkSessionRunning,
    listSdkModels: stub(), checkSdkApiKey: stub(), getSdkSessionList: stub(), getSdkSessionCount: stub(),
    switchSdkSessionModel: stub(), resetSdkSessionContext: stub(), exportSdkTranscript: stub(),
    handlePollPhaseEvent: stub(), setSdkIdleHandler: stub(), sdkFailCooldownRemaining: stub(),
    clearSdkFailStreak: stub(), clearAllSdkFailStreaks: stub(), hasResumableSdkSession: stub(),
    getSdkSessionDiagnostics: stub(), getResumableSummary: stub(), completeSdkText: stub(),
  }
})

import { cursorSdkEngine } from "../electron/agent-engine/cursor-sdk"
import type { InterruptTurnResult } from "../electron/agent-engine/types"

beforeEach(() => {
  m.interruptSdkWorkerTurn.mockReset()
  m.isSdkSessionRunning.mockReset()
})

describe("cursorSdkEngine.interruptTurn", () => {
  it("引擎声明支持软打断（调度层靠它判断要不要走旧的停止+重启）", () => {
    expect(typeof cursorSdkEngine.interruptTurn).toBe("function")
  })

  it("worker 还没有、但 SDK 在拉起中：launching", async () => {
    m.interruptSdkWorkerTurn.mockResolvedValue("not-running")
    m.isSdkSessionRunning.mockReturnValue(true)
    expect(await cursorSdkEngine.interruptTurn!("k")).toBe("launching")
  })

  it("worker 没有、SDK 也没在跑：not-running", async () => {
    m.interruptSdkWorkerTurn.mockResolvedValue("not-running")
    m.isSdkSessionRunning.mockReturnValue(false)
    expect(await cursorSdkEngine.interruptTurn!("k")).toBe("not-running")
  })

  it.each<InterruptTurnResult>(["interrupted", "no-turn", "unsupported", "timeout", "exited"])(
    "worker 的其它结果原样透传：%s", async (r) => {
      m.interruptSdkWorkerTurn.mockResolvedValue(r)
      m.isSdkSessionRunning.mockReturnValue(true) // 即使 SDK 看起来在跑也不改写
      expect(await cursorSdkEngine.interruptTurn!("k")).toBe(r)
    },
  )
})
