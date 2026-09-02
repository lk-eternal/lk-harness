import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import {
  clearLaunchFailStreak,
  isTransientLaunchError,
  launchFailCooldownRemaining,
  recordLaunchFailure,
  shouldNotifyLaunchFailure,
} from "../electron/launch-fail-tracker"

describe("launch-fail-tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearLaunchFailStreak("sk1")
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("Resume 暂不可用视为瞬时故障，无退避", () => {
    expect(isTransientLaunchError("Resume 暂不可用: fetch failed")).toBe(true)
    recordLaunchFailure("sk1", "Resume 暂不可用: network")
    expect(launchFailCooldownRemaining("sk1")).toBe(0)
  })

  it("配置类错误阶梯退避", () => {
    recordLaunchFailure("sk1", "通道未启用其他人使用")
    expect(launchFailCooldownRemaining("sk1")).toBeGreaterThan(0)
    vi.advanceTimersByTime(5_000)
    expect(launchFailCooldownRemaining("sk1")).toBe(0)
  })

  it("通知节流", () => {
    recordLaunchFailure("sk1", "API Key 未配置")
    expect(shouldNotifyLaunchFailure("sk1")).toBe(true)
    expect(shouldNotifyLaunchFailure("sk1")).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(shouldNotifyLaunchFailure("sk1")).toBe(true)
  })

  it("启动成功后清 streak", () => {
    recordLaunchFailure("sk1", "永久错误")
    clearLaunchFailStreak("sk1")
    expect(launchFailCooldownRemaining("sk1")).toBe(0)
  })
})
