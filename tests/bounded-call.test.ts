import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { boundedCall, createTimeoutMessage, hedgedCall, resumeTimeoutMessage, type HedgeOptions } from "../electron/bounded-call"
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

describe("hedgedCall：慢了就并行再试一次", () => {
  const HEDGE = 6_000
  const TOTAL = 45_000

  /** 每次 start() 都生成一个由测试手动结算的调用，按发起顺序记下来 */
  function setup(over: Partial<HedgeOptions<string>> = {}) {
    const calls: ReturnType<typeof deferred<string>>[] = []
    const start = vi.fn(() => {
      const d = deferred<string>()
      calls.push(d)
      return d.promise
    })
    const onLate = vi.fn()
    const onHedge = vi.fn()
    const st = track(hedgedCall(start, {
      hedgeAfterMs: HEDGE,
      timeoutMs: TOTAL,
      timeoutMessage: "45s 内没有响应",
      onLate,
      onHedge,
      ...over,
    }))
    return { calls, start, onLate, onHedge, st }
  }

  it("第一次在时限内返回：只发起一次，不留悬空的计时器", async () => {
    const { calls, start, onLate, onHedge, st } = setup()
    expect(start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HEDGE - 1)
    calls[0].resolve("a")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "a" })
    await vi.advanceTimersByTimeAsync(TOTAL)
    expect(start).toHaveBeenCalledTimes(1)
    expect(onHedge).not.toHaveBeenCalled()
    expect(onLate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("第一次挂住：差 1ms 还只有一次，到点并行发起第二次，第二次先返回就用它", async () => {
    const { calls, start, onHedge, st } = setup()
    await vi.advanceTimersByTimeAsync(HEDGE - 1)
    expect(start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(start).toHaveBeenCalledTimes(2)
    expect(onHedge).toHaveBeenCalledWith(2)
    expect(st.state).toBe("pending")

    calls[1].resolve("b")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "b" })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("输掉的第一次之后才返回：交给 onLate 释放，只交一次，原因是被取代", async () => {
    const { calls, onLate, st } = setup()
    await vi.advanceTimersByTimeAsync(HEDGE)
    calls[1].resolve("b")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "b" })

    calls[0].resolve("a")
    await vi.advanceTimersByTimeAsync(0)
    expect(onLate).toHaveBeenCalledTimes(1)
    expect(onLate).toHaveBeenCalledWith("a", "superseded")
  })

  it("第一次慢但自己回来了（在第二次之前）：用第一次的，第二次晚到的被释放", async () => {
    const { calls, onLate, st } = setup()
    await vi.advanceTimersByTimeAsync(HEDGE + 1000)
    calls[0].resolve("a")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "a" })

    calls[1].resolve("b")
    await vi.advanceTimersByTimeAsync(0)
    expect(onLate).toHaveBeenCalledWith("b", "superseded")
  })

  it("第一次在并行之前就失败：立刻抛这个错误，不发起第二次（确定的失败，重试没意义）", async () => {
    const { calls, start, onHedge, st } = setup()
    await vi.advanceTimersByTimeAsync(2000)
    calls[0].reject(new Error("agent not found"))
    await vi.advanceTimersByTimeAsync(0)
    expect(st.state).toBe("rejected")
    expect((st.error as Error).message).toBe("agent not found")
    await vi.advanceTimersByTimeAsync(TOTAL)
    expect(start).toHaveBeenCalledTimes(1)
    expect(onHedge).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("第二次先失败：继续等第一次，第一次回来就用它", async () => {
    const { calls, st } = setup()
    await vi.advanceTimersByTimeAsync(HEDGE)
    calls[1].reject(new Error("Network request failed"))
    await vi.advanceTimersByTimeAsync(0)
    expect(st.state).toBe("pending")

    calls[0].resolve("a")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "a" })
  })

  it("两次都失败：抛第一次的错误", async () => {
    const { calls, st } = setup()
    await vi.advanceTimersByTimeAsync(HEDGE)
    calls[0].reject(new Error("first"))
    await vi.advanceTimersByTimeAsync(0)
    expect(st.state).toBe("pending") // 第二次还在路上
    calls[1].reject(new Error("second"))
    await vi.advanceTimersByTimeAsync(0)
    expect(st.state).toBe("rejected")
    expect((st.error as Error).message).toBe("first")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("两次都挂住：总时限从第一次发起起算，差 1ms 还在等，到点失败（并行不延长总时限）", async () => {
    const { st } = setup()
    await vi.advanceTimersByTimeAsync(TOTAL - 1)
    expect(st.state).toBe("pending")
    await vi.advanceTimersByTimeAsync(1)
    expect(st.state).toBe("rejected")
    expect((st.error as Error).message).toBe("45s 内没有响应")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("超时之后才返回的结果交给 onLate（原因是超时），之后才失败的吞掉", async () => {
    const { calls, onLate, st } = setup()
    await vi.advanceTimersByTimeAsync(TOTAL)
    expect(st.state).toBe("rejected")

    calls[0].resolve("late-a")
    calls[1].reject(new Error("socket hang up"))
    await vi.advanceTimersByTimeAsync(0)
    expect(onLate).toHaveBeenCalledTimes(1)
    expect(onLate).toHaveBeenCalledWith("late-a", "timeout")
  })

  it("maxAttempts=1 不并行；maxAttempts=3 到点依次再发起，最多 3 次", async () => {
    const one = setup({ maxAttempts: 1 })
    await vi.advanceTimersByTimeAsync(TOTAL - 1)
    expect(one.start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(one.st.state).toBe("rejected")

    const three = setup({ maxAttempts: 3 })
    await vi.advanceTimersByTimeAsync(HEDGE)
    expect(three.start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HEDGE)
    expect(three.start).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(HEDGE * 2)
    expect(three.start).toHaveBeenCalledTimes(3)
    expect(three.onHedge.mock.calls.map((c) => c[0])).toEqual([2, 3])
  })

  it("start 同步抛错也当失败处理；onLate / onHedge 自己抛错不外泄", async () => {
    const boom = track(hedgedCall(() => { throw new Error("sync boom") }, {
      hedgeAfterMs: HEDGE, timeoutMs: TOTAL, timeoutMessage: "x", onLate: vi.fn(),
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(boom.state).toBe("rejected")
    expect((boom.error as Error).message).toBe("sync boom")

    const { calls, st } = setup({
      onLate: () => { throw new Error("close failed") },
      onHedge: () => { throw new Error("log failed") },
    })
    await vi.advanceTimersByTimeAsync(HEDGE)
    calls[1].resolve("b")
    await vi.advanceTimersByTimeAsync(0)
    calls[0].resolve("a")
    await vi.advanceTimersByTimeAsync(0)
    expect(st).toMatchObject({ state: "resolved", value: "b" })
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
