import { describe, expect, it } from "vitest"
import {
  CARD_OVER_SIZE_CODE,
  RepeatLogGate,
  STREAM_CARD_MIN_BYTE_BUDGET,
  streamCardBackoffMs,
  tightenByteBudget,
} from "../src/shared/stream-card-failure"

/** 流式卡整卡更新失败后的应对：退避、收紧体积预算、合并重复日志（纯逻辑） */

describe("streamCardBackoffMs（连续失败后多久再试）", () => {
  it("1s、2s、4s、8s，之后一直 8s", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(streamCardBackoffMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000])
  })

  it("没失败过 / 不是正常数字：不等待", () => {
    for (const n of [0, -1, NaN, Infinity, -Infinity]) expect(streamCardBackoffMs(n)).toBe(0)
  })

  it("小数向下取整，不会算出怪值", () => {
    expect(streamCardBackoffMs(2.9)).toBe(2000)
  })

  it("次数很大也不溢出", () => {
    expect(streamCardBackoffMs(10_000)).toBe(8000)
  })
})

describe("tightenByteBudget（飞书报 200860 后收紧这张卡的预算）", () => {
  it("收紧到 70%", () => {
    expect(tightenByteBudget(24 * 1024)).toBe(Math.floor(24 * 1024 * 0.7))
  })

  it("反复收紧会收敛到下限，不会再小", () => {
    let b = 24 * 1024
    const seen: number[] = []
    for (let i = 0; i < 20; i++) { b = tightenByteBudget(b); seen.push(b) }
    expect(b).toBe(STREAM_CARD_MIN_BYTE_BUDGET)
    expect(Math.min(...seen)).toBe(STREAM_CARD_MIN_BYTE_BUDGET)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1])
  })

  it("本来就低于下限的，也不会被「收紧」成更小", () => {
    expect(tightenByteBudget(1000)).toBe(STREAM_CARD_MIN_BYTE_BUDGET)
  })

  it("错误码就是飞书文档里的 200860", () => {
    expect(CARD_OVER_SIZE_CODE).toBe(200860)
  })
})

describe("RepeatLogGate（合并重复日志）", () => {
  function gateAt() {
    const clock = { t: 1_000_000 }
    const gate = new RepeatLogGate(30_000, 200, () => clock.t)
    return { gate, clock }
  }

  it("第一次要打；间隔内重复的不打", () => {
    const { gate, clock } = gateAt()
    expect(gate.shouldLog("a")).toEqual({ merged: 0 })
    for (let i = 0; i < 59; i++) { clock.t += 500; expect(gate.shouldLog("a")).toBeNull() }
  })

  it("过了间隔再出现：打一条，并带上期间被合并的条数", () => {
    const { gate, clock } = gateAt()
    gate.shouldLog("a")
    for (let i = 0; i < 10; i++) { clock.t += 1000; gate.shouldLog("a") }
    clock.t += 30_000
    expect(gate.shouldLog("a")).toEqual({ merged: 10 })
    // 打完重新计时：紧接着的又被合并
    clock.t += 1000
    expect(gate.shouldLog("a")).toBeNull()
  })

  it("1 分钟里每秒失败一次：只打 2 条（过去是 60 条）", () => {
    const { gate, clock } = gateAt()
    let printed = 0
    for (let i = 0; i < 60; i++) { if (gate.shouldLog("card1|code:200860")) printed++; clock.t += 1000 }
    expect(printed).toBe(2)
  })

  it("不同的 key 互不影响", () => {
    const { gate } = gateAt()
    expect(gate.shouldLog("card1|code:1")).toEqual({ merged: 0 })
    expect(gate.shouldLog("card1|code:2")).toEqual({ merged: 0 })
    expect(gate.shouldLog("card2|code:1")).toEqual({ merged: 0 })
    expect(gate.shouldLog("card1|code:1")).toBeNull()
  })

  it("resolve：这张卡恢复了，返回期间一共失败几次，并忘掉它——之后再失败要重新打", () => {
    const { gate, clock } = gateAt()
    for (let i = 0; i < 5; i++) { gate.shouldLog("card1|code:1"); clock.t += 1000 }
    gate.shouldLog("card1|exc:boom")
    gate.shouldLog("card2|code:1")
    expect(gate.resolve("card1|")).toBe(6)
    expect(gate.shouldLog("card1|code:1")).toEqual({ merged: 0 })
    // 别的卡不受影响
    expect(gate.shouldLog("card2|code:1")).toBeNull()
    // 没有失败过的卡：0
    expect(gate.resolve("nope|")).toBe(0)
  })

  it("resolve 只认前缀，card1 不会误清 card10", () => {
    const { gate } = gateAt()
    gate.shouldLog("card10|code:1")
    expect(gate.resolve("card1|")).toBe(0)
    expect(gate.shouldLog("card10|code:1")).toBeNull()
  })

  it("key 很多时丢最旧的，不无限增长（被丢的 key 再出现算第一次）", () => {
    const clock = { t: 0 }
    const gate = new RepeatLogGate(30_000, 3, () => clock.t)
    for (const k of ["k1", "k2", "k3", "k4"]) gate.shouldLog(k)
    expect(gate.shouldLog("k1")).toEqual({ merged: 0 })
    expect(gate.shouldLog("k4")).toBeNull()
  })
})
