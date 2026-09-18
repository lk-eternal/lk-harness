import { describe, expect, it } from "vitest"

import { needsOrphanCardFinish, newStreamAgg, rebaseUnensuredQueue } from "../electron/stream-card"

/**
 * 锁定时任务卡 sticky 的收口条件：daemon 经 MCP 合并建的卡，
 * Electron 侧无 agg 可关时，终态必须补一次无 cardId 的 finish。
 */
describe("孤儿卡收口补发", () => {
  it("已知 cardId 走常规带卡 finish，不补发", () => {
    expect(needsOrphanCardFinish(false, "card123", "FINISHED")).toBe(false)
    expect(needsOrphanCardFinish(true, "card123", "FINISHED")).toBe(false)
  })

  it("FINISHED + 无本地卡则补发（定时任务 UUID 会话即此形态）", () => {
    expect(needsOrphanCardFinish(false, undefined, "FINISHED")).toBe(true)
    expect(needsOrphanCardFinish(true, undefined, "FINISHED")).toBe(true)
  })

  it("异常终态仅非 keep 会话补发，keep 会话留卡待 Resume", () => {
    expect(needsOrphanCardFinish(false, undefined, "ERROR")).toBe(true)
    expect(needsOrphanCardFinish(false, undefined, "CANCELLED")).toBe(true)
    expect(needsOrphanCardFinish(false, undefined, "EXPIRED")).toBe(true)
    expect(needsOrphanCardFinish(true, undefined, "ERROR")).toBe(false)
    expect(needsOrphanCardFinish(true, undefined, "EXPIRED")).toBe(false)
    expect(needsOrphanCardFinish(true, undefined, "CANCELLED")).toBe(false)
  })

  it("非终态不补发", () => {
    expect(needsOrphanCardFinish(false, undefined, "RUNNING")).toBe(false)
    expect(needsOrphanCardFinish(false, undefined, undefined)).toBe(false)
  })
})

/**
 * 锁定丢头根因：预热队列 bornAt 早于投递收口 sealAt 时首 ensure 被误杀。
 * 回合开干前（尚未 ensure）重定出生零成本；已建卡的一律不动。
 */
describe("出生对齐 rebaseUnensuredQueue", () => {
  const hostOf = (agg: ReturnType<typeof newStreamAgg> | null) => ({
    sessionKey: "sk",
    streamAgg: agg,
    pollPhase: { blocking: false, nonBlocking: false },
    seenMessageIds: new Set<string>(),
  })

  it("未 ensure 的预热队列重定出生", () => {
    const agg = newStreamAgg(true)
    agg.bornAt = 1000
    rebaseUnensuredQueue(hostOf(agg))
    expect(agg.bornAt).toBeGreaterThan(1000)
  })

  it("已 ensure / 已有 cardId 的不动（回合中真到货仍走拒单）", () => {
    const ensured = newStreamAgg(true)
    ensured.bornAt = 1000
    ensured.ensured = true
    rebaseUnensuredQueue(hostOf(ensured))
    expect(ensured.bornAt).toBe(1000)

    const withCard = newStreamAgg(true)
    withCard.bornAt = 1000
    withCard.cardId = "card1"
    rebaseUnensuredQueue(hostOf(withCard))
    expect(withCard.bornAt).toBe(1000)
  })

  it("无队列 / 已结束不炸", () => {
    rebaseUnensuredQueue(hostOf(null))
    const done = newStreamAgg(true)
    done.finished = true
    rebaseUnensuredQueue(hostOf(done))
  })
})
