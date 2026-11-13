/**
 * 空闲自动重启的现场探针：Agent 在不在忙、队列有没有消息、电脑空闲多久、安装方式、重启记号。
 * 它们依赖 electron 和一堆引擎模块，这里全用替身，只验证组合逻辑。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  const powerHandlers = new Map<string, () => void>()
  return {
    powerHandlers,
    userData: "",
    systemIdle: 0 as number,
    launches: false,
    sdkRuns: 0,
    sdkPhases: [] as string[],
    llmPhases: new Map<string, string>(),
    daemon: { running: true } as Record<string, unknown>,
    detectPerUserInstall: vi.fn(async () => true),
  }
})

vi.mock("electron", () => ({
  app: { getPath: () => h.userData },
  powerMonitor: {
    getSystemIdleTime: () => h.systemIdle,
    on: (event: string, fn: () => void) => h.powerHandlers.set(event, fn),
  },
}))
vi.mock("../electron/agent-sdk", () => ({ getSdkSessionCount: () => h.sdkRuns }))
vi.mock("../electron/session-dispatcher", () => ({ hasLaunchesInFlight: () => h.launches }))
vi.mock("../electron/sdk-session-worker", () => ({ listSdkWorkerPhases: () => h.sdkPhases }))
vi.mock("../electron/llm-session-worker", () => ({ listLlmWorkerPhases: () => h.llmPhases }))
vi.mock("../electron/daemon-manager", () => ({ getDaemonStatus: async () => h.daemon }))
vi.mock("../electron/win-install-mode", () => ({ detectPerUserInstall: h.detectPerUserInstall }))

import { agentWorkInFlight, createIdleRestartProbes, queuedMessages } from "../electron/idle-probes"

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "lk-idle-probes-"))
  h.systemIdle = 0
  h.launches = false
  h.sdkRuns = 0
  h.sdkPhases = []
  h.llmPhases = new Map()
  h.daemon = { running: true }
  h.powerHandlers.clear()
  h.detectPerUserInstall.mockClear()
  h.detectPerUserInstall.mockResolvedValue(true)
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(h.userData, { recursive: true, force: true })
})

describe("agentWorkInFlight（此刻有没有 Agent 在跑回合）", () => {
  it("什么都没有：不忙", () => {
    expect(agentWorkInFlight()).toBe(false)
  })

  it("只有监听中的长连接会话：不忙（它们没有进行中的工作，退出时也不丢东西）", () => {
    h.sdkPhases = ["listening", "listening"]
    h.llmPhases = new Map([["a", "listening"], ["b", "listening"]])
    expect(agentWorkInFlight()).toBe(false)
  })

  it("SDK worker 在处理回合：忙", () => {
    h.sdkPhases = ["listening", "processing"]
    expect(agentWorkInFlight()).toBe(true)
  })

  it("LLM worker 在处理回合：忙", () => {
    h.llmPhases = new Map([["a", "listening"], ["b", "processing"]])
    expect(agentWorkInFlight()).toBe(true)
  })

  it("worker 正在停止（不是监听）：按忙算，等它收完", () => {
    h.sdkPhases = ["stopping"]
    expect(agentWorkInFlight()).toBe(true)
    h.sdkPhases = []
    h.llmPhases = new Map([["a", "stopping"]])
    expect(agentWorkInFlight()).toBe(true)
  })

  it("SDK 有 run 在跑（没有 worker 托管的也算）：忙", () => {
    h.sdkRuns = 1
    expect(agentWorkInFlight()).toBe(true)
  })

  it("调度器已经预留名额、引擎还在拉起：忙", () => {
    h.launches = true
    expect(agentWorkInFlight()).toBe(true)
  })
})

describe("queuedMessages（daemon 队列里排队 + 处理中的消息数）", () => {
  it("排队和处理中相加", async () => {
    h.daemon = { running: true, queueCounts: { pending: 2, processing: 1 }, queueLength: 99 }
    await expect(queuedMessages()).resolves.toBe(3)
  })

  it("队列是空的：0", async () => {
    h.daemon = { running: true, queueCounts: { pending: 0, processing: 0 } }
    await expect(queuedMessages()).resolves.toBe(0)
  })

  it("没给分项数、只给了总长度：用总长度", async () => {
    h.daemon = { running: true, queueLength: 4 }
    await expect(queuedMessages()).resolves.toBe(4)
  })

  it("daemon 在跑但什么数字都没给：拿不到（null），由决策当作不确定", async () => {
    h.daemon = { running: true }
    await expect(queuedMessages()).resolves.toBeNull()
  })

  it("daemon 没在跑：没有通道在收消息，算 0", async () => {
    h.daemon = { running: false, error: "Daemon 未运行" }
    await expect(queuedMessages()).resolves.toBe(0)
  })

  it("daemon 正在启动中：拿不到（null），不趁这时候重启", async () => {
    h.daemon = { running: false, starting: true }
    await expect(queuedMessages()).resolves.toBeNull()
  })
})

describe("createIdleRestartProbes", () => {
  it("电脑空闲秒数取系统空闲时间", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const probes = createIdleRestartProbes()
    vi.setSystemTime(Date.now() + 3 * 3600 * 1000)
    h.systemIdle = 1234
    expect(probes.userIdleSeconds()).toBe(1234)
  })

  it("睡眠唤醒、解锁屏幕都算用户刚来过：系统空闲时间在唤醒那一刻还是睡前算起的，不能直接信", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const probes = createIdleRestartProbes()
    vi.setSystemTime(Date.now() + 8 * 3600 * 1000)
    // 睡了一夜刚醒：系统空闲时间还是睡前算起的 8 小时，但用户其实刚来过
    h.systemIdle = 8 * 3600
    h.powerHandlers.get("resume")?.()
    expect(probes.userIdleSeconds()).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(probes.userIdleSeconds()).toBe(5)
    // 解锁同理
    vi.advanceTimersByTime(20 * 60 * 1000)
    h.systemIdle = 8 * 3600 + 20 * 60
    expect(probes.userIdleSeconds()).toBe(20 * 60 + 5)
    h.powerHandlers.get("unlock-screen")?.()
    vi.advanceTimersByTime(2_000)
    expect(probes.userIdleSeconds()).toBe(2)
  })

  it("应用刚启动那一刻也算「用户刚来过」", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const probes = createIdleRestartProbes()
    h.systemIdle = 3600
    vi.advanceTimersByTime(7_000)
    expect(probes.userIdleSeconds()).toBe(7)
  })

  it("系统给出的空闲时间不是正常数字：取不到（null）", () => {
    const probes = createIdleRestartProbes()
    h.systemIdle = Number.NaN
    expect(probes.userIdleSeconds()).toBeNull()
    h.systemIdle = -1
    expect(probes.userIdleSeconds()).toBeNull()
  })

  it("安装方式只查一次，之后沿用", async () => {
    const probes = createIdleRestartProbes()
    await expect(probes.perUserInstall()).resolves.toBe(true)
    await expect(probes.perUserInstall()).resolves.toBe(true)
    expect(h.detectPerUserInstall).toHaveBeenCalledTimes(1)
  })

  it("重启前写记号、取消时撤销；记号落在 userData，读走后留在托盘与否取决于重启前窗口的状态", async () => {
    const { consumeStayHiddenMarker } = await import("../electron/update-restart-marker")
    const probes = createIdleRestartProbes()

    probes.beforeRestart({ keepHidden: true })
    expect(fs.readdirSync(h.userData)).toHaveLength(1)
    probes.cancelRestart()
    expect(fs.readdirSync(h.userData)).toHaveLength(0)

    probes.beforeRestart({ keepHidden: true })
    expect(consumeStayHiddenMarker(h.userData)).toBe(true)

    probes.beforeRestart({ keepHidden: false })
    expect(consumeStayHiddenMarker(h.userData)).toBe(false)
  })

  it("Agent 安静时长取自 agent-activity：刚启动时很短", () => {
    const probes = createIdleRestartProbes()
    expect(probes.agentQuietMs()).toBeLessThan(5_000)
  })
})
