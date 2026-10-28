import { describe, expect, it } from "vitest"
import { createLatestRunner } from "../src/renderer/hooks/latest-runner"

/** 手动放行的 load：每次调用记一笔，测试里按需 resolve */
function manualLoad() {
  const pending: { resolve: (v: string) => void; reject: (e: Error) => void }[] = []
  let calls = 0
  const load = () =>
    new Promise<string>((resolve, reject) => {
      calls++
      pending.push({ resolve, reject })
    })
  return { load, pending, calls: () => calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("createLatestRunner", () => {
  it("没有并发时：拉一次，交出结果", async () => {
    const m = manualLoad()
    const got: string[] = []
    const run = createLatestRunner(m.load, (v) => got.push(v))
    const p = run()
    m.pending[0].resolve("a")
    await p
    expect(got).toEqual(["a"])
    expect(m.calls()).toBe(1)
  })

  it("飞行中再触发：旧结果丢掉，补拉一轮，只交出最新的", async () => {
    const m = manualLoad()
    const got: string[] = []
    const run = createLatestRunner(m.load, (v) => got.push(v))
    const first = run()
    const second = run()
    m.pending[0].resolve("旧")
    await tick()
    expect(got).toEqual([])
    expect(m.calls()).toBe(2)
    m.pending[1].resolve("新")
    await Promise.all([first, second])
    expect(got).toEqual(["新"])
  })

  it("飞行中触发的 promise 要等补拉那一轮交出结果后才完成", async () => {
    const m = manualLoad()
    const order: string[] = []
    const run = createLatestRunner(m.load, (v) => order.push(`result:${v}`))
    void run()
    const second = run().then(() => order.push("done"))
    m.pending[0].resolve("旧")
    await tick()
    expect(order).toEqual([])
    m.pending[1].resolve("新")
    await second
    expect(order).toEqual(["result:新", "done"])
  })

  it("飞行中触发多次只补一轮", async () => {
    const m = manualLoad()
    const got: string[] = []
    const run = createLatestRunner(m.load, (v) => got.push(v))
    const p = run()
    run(); run(); run()
    m.pending[0].resolve("旧")
    await tick()
    expect(m.calls()).toBe(2)
    m.pending[1].resolve("新")
    await p
    expect(got).toEqual(["新"])
    expect(m.calls()).toBe(2)
  })

  it("补拉期间又被触发：继续补，最终只交出最后一轮", async () => {
    const m = manualLoad()
    const got: string[] = []
    const run = createLatestRunner(m.load, (v) => got.push(v))
    const p = run()
    run()
    m.pending[0].resolve("1")
    await tick()
    run() // 第二轮在飞时又来一次
    m.pending[1].resolve("2")
    await tick()
    expect(got).toEqual([])
    expect(m.calls()).toBe(3)
    m.pending[2].resolve("3")
    await p
    expect(got).toEqual(["3"])
  })

  it("一轮结束后可以再次触发", async () => {
    const m = manualLoad()
    const got: string[] = []
    const run = createLatestRunner(m.load, (v) => got.push(v))
    const p1 = run()
    m.pending[0].resolve("a")
    await p1
    const p2 = run()
    m.pending[1].resolve("b")
    await p2
    expect(got).toEqual(["a", "b"])
  })

  it("组件已卸载（isAlive 为假）：不交结果，也不再补拉", async () => {
    const m = manualLoad()
    const got: string[] = []
    let alive = true
    const run = createLatestRunner(m.load, (v) => got.push(v), () => alive)
    const p = run()
    run()
    alive = false
    m.pending[0].resolve("a")
    await p
    expect(got).toEqual([])
    expect(m.calls()).toBe(1)
  })

  it("组件已卸载且没有补拉：这一轮的结果也不交", async () => {
    const m = manualLoad()
    const got: string[] = []
    let alive = true
    const run = createLatestRunner(m.load, (v) => got.push(v), () => alive)
    const p = run()
    alive = false
    m.pending[0].resolve("a")
    await p
    expect(got).toEqual([])
  })

  it("load 抛错：这一串结束、状态复位，之后还能用", async () => {
    const m = manualLoad()
    const got: string[] = []
    const run = createLatestRunner(m.load, (v) => got.push(v))
    const p = run()
    m.pending[0].reject(new Error("boom"))
    await expect(p).rejects.toThrow("boom")
    const p2 = run()
    m.pending[1].resolve("ok")
    await p2
    expect(got).toEqual(["ok"])
  })
})
