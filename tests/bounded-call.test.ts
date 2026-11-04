import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { boundedCall, createTimeoutMessage, resumeTimeoutMessage } from "../electron/bounded-call"
import { isTransientLaunchError } from "../electron/launch-fail-tracker"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** 一个由测试手动结算的异步调用 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 跟踪一个 promise 是否已经结算，避免靠 await 把测试自己挂住 */
function track<T>(p: Promise<T>) {
  const st: { state: "pending" | "resolved" | "rejected"; value?: T; error?: unknown } = { state: "pending" }
  p.then(
    (v) => { st.state = "resolved"; st.value = v },
    (e) => { st.state = "rejected"; st.error = e },
  )
  return st
}

describe("boundedCall", () => {
  it("在时限内返回：原样给结果，并且清掉计时器（不留悬空的定时器）", async () => {
    const d = deferred<string>()
    const onLate = vi.fn()
    const st = track(boundedCall(d.promise, 45_000, "超时了", onLate))
    d.resolve("agent")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "agent" })
    expect(vi.getTimerCount()).toBe(0)
    expect(onLate).not.toHaveBeenCalled()
  })

  it("在时限内失败：抛的是原来的错误，不是超时", async () => {
    const d = deferred<string>()
    const st = track(boundedCall(d.promise, 45_000, "超时了", vi.fn()))
    d.reject(new Error("Network request failed"))
    await vi.advanceTimersByTimeAsync(0)
    expect(st.state).toBe("rejected")
    expect((st.error as Error).message).toBe("Network request failed")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("挂住：差 1ms 还在等，到点立刻失败（原来要等底层放弃，实测 3 分多钟）", async () => {
    const d = deferred<string>()
    const st = track(boundedCall(d.promise, 45_000, "45s 内没有响应", vi.fn()))
    await vi.advanceTimersByTimeAsync(44_999)
    expect(st.state).toBe("pending")
    await vi.advanceTimersByTimeAsync(1)
    expect(st.state).toBe("rejected")
    expect((st.error as Error).message).toBe("45s 内没有响应")
  })

  it("超时之后才返回的结果交给 onLate 释放（晚到的 Agent 不能没人管），只交一次", async () => {
    const d = deferred<{ close: () => void }>()
    const onLate = vi.fn()
    const st = track(boundedCall(d.promise, 1000, "超时了", onLate))
    await vi.advanceTimersByTimeAsync(1000)
    expect(st.state).toBe("rejected")
    const late = { close: vi.fn() }
    d.resolve(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(onLate).toHaveBeenCalledTimes(1)
    expect(onLate).toHaveBeenCalledWith(late)
  })

  it("超时之后才失败：吞掉，不再抛（调用方早处理过了），也不调 onLate", async () => {
    const d = deferred<string>()
    const onLate = vi.fn()
    const st = track(boundedCall(d.promise, 1000, "超时了", onLate))
    await vi.advanceTimersByTimeAsync(1000)
    expect(st.state).toBe("rejected")
    d.reject(new Error("socket hang up"))
    await vi.advanceTimersByTimeAsync(0)
    expect(onLate).not.toHaveBeenCalled()
    // 没有「未处理的 rejection」：vitest 会把它当成测试失败，走到这里就说明被吞掉了
  })

  it("onLate 自己抛错也不外泄", async () => {
    const d = deferred<string>()
    const st = track(boundedCall(d.promise, 1000, "超时了", () => { throw new Error("close failed") }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(st.state).toBe("rejected")
    d.resolve("late")
    await vi.advanceTimersByTimeAsync(0)
    expect(st.state).toBe("rejected")
  })

  it("时限内返回之后不会再被超时覆盖", async () => {
    const d = deferred<string>()
    const onLate = vi.fn()
    const st = track(boundedCall(d.promise, 1000, "超时了", onLate))
    await vi.advanceTimersByTimeAsync(999)
    d.resolve("ok")
    await vi.advanceTimersByTimeAsync(5000)
    expect(st).toMatchObject({ state: "resolved", value: "ok" })
    expect(onLate).not.toHaveBeenCalled()
  })
})

describe("超时文案要被当成瞬时故障", () => {
  // 瞬时故障：立即重试、不按阶梯退避；配置类错误才退避（launch-fail-tracker 按文案里的关键字判断）
  it("Resume 超时（agent-sdk 会拼成「Resume 暂不可用: …」）", () => {
    expect(isTransientLaunchError(`Resume 暂不可用: ${resumeTimeoutMessage(45_000)}`)).toBe(true)
  })

  it("创建 Agent 超时", () => {
    expect(isTransientLaunchError(createTimeoutMessage(45_000))).toBe(true)
  })

  it("文案里写的是实际的秒数，用户能看懂等了多久", () => {
    expect(resumeTimeoutMessage(45_000)).toContain("45s")
    expect(createTimeoutMessage(30_000)).toContain("30s")
  })
})
