import { describe, expect, it } from "vitest"

import { needsOrphanCardFinish } from "../electron/stream-card"

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
