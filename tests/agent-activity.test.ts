import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

describe("agent-activity（Agent 最近一次有动静的时间）", () => {
  it("应用刚启动那一刻也算一笔：刚启动的几分钟内总是「不安静」", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.resetModules()
    const mod = await import("../electron/agent-activity")
    expect(mod.agentQuietMs()).toBe(0)
    vi.advanceTimersByTime(90_000)
    expect(mod.agentQuietMs()).toBe(90_000)
  })

  it("记一笔之后重新从 0 算起", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.resetModules()
    const mod = await import("../electron/agent-activity")
    vi.advanceTimersByTime(10 * 60_000)
    expect(mod.agentQuietMs()).toBe(10 * 60_000)
    mod.noteAgentActivity()
    expect(mod.agentQuietMs()).toBe(0)
    vi.advanceTimersByTime(1_500)
    expect(mod.agentQuietMs()).toBe(1_500)
  })

  it("系统时间被往回调：不会得到负数", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.resetModules()
    const mod = await import("../electron/agent-activity")
    mod.noteAgentActivity(Date.now() + 60_000)
    expect(mod.agentQuietMs()).toBe(0)
  })

  it("可以显式传入时刻（方便测试）", async () => {
    vi.resetModules()
    const mod = await import("../electron/agent-activity")
    mod.noteAgentActivity(1_000)
    expect(mod.agentQuietMs(4_500)).toBe(3_500)
  })
})
