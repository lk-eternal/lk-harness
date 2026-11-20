import { describe, expect, it } from "vitest"
import { collectCronSlots, findMissedSlots } from "../src/daemon-scheduled-tasks.js"

const at = (h: number, m = 0, s = 0, day = 20): number => new Date(2026, 10, day, h, m, s).getTime()
const HOURLY = "0 * * * *"

describe("collectCronSlots", () => {
  it("起点不含、终点含", () => {
    expect(collectCronSlots("0 9 * * *", at(8), at(10))).toEqual([at(9)])
    expect(collectCronSlots("0 9 * * *", at(9), at(10))).toEqual([])
    expect(collectCronSlots("0 9 * * *", at(8), at(9))).toEqual([at(9)])
  })

  it("区间为空或表达式无效 → 空", () => {
    expect(collectCronSlots(HOURLY, at(10), at(10))).toEqual([])
    expect(collectCronSlots(HOURLY, at(11), at(10))).toEqual([])
    expect(collectCronSlots("not a cron", at(8), at(10))).toEqual([])
  })

  it("区间内有多个触发点时按时间升序", () => {
    expect(collectCronSlots(HOURLY, at(8, 30), at(11, 30))).toEqual([at(9), at(10), at(11)])
  })
})

describe("findMissedSlots：错过的触发点（只查，不补跑）", () => {
  it("不知道上次什么时候还活着（0）→ 不查", () => {
    expect(findMissedSlots(HOURLY, 0, at(15, 59, 55), at(16))).toEqual([])
  })

  it("正常 tick（上次确认存活就是上一个 tick）→ 没有错过", () => {
    const prev = at(15, 59, 55)
    expect(findMissedSlots(HOURLY, prev, prev, at(16))).toEqual([])
  })

  it("运行中休眠后醒来：窗口里早于 30 分钟的算错过，30 分钟内的留给补触发", () => {
    const prev = at(8)
    expect(findMissedSlots(HOURLY, prev, prev, at(16))).toEqual([at(9), at(10), at(11), at(12), at(13), at(14), at(15)])
  })

  it("应用重启：上次存活到本次扫描窗口之前的空档都算错过，窗口里的由正常扫描触发", () => {
    const now = at(16)
    const slots = findMissedSlots(HOURLY, at(1), now - 5_000, now)
    expect(slots[0]).toBe(at(2))
    expect(slots.at(-1)).toBe(at(15))
    expect(slots).not.toContain(at(16))
  })

  it("空档里没有触发点 → 没有错过", () => {
    expect(findMissedSlots("0 9 * * *", at(10), at(15, 59, 55), at(16))).toEqual([])
  })

  it("任务创建之前的触发点不算它错过的", () => {
    const now = at(16)
    expect(findMissedSlots(HOURLY, at(8), now - 5_000, now, at(12))).toEqual([at(13), at(14), at(15)])
  })

  it("空档超过 7 天只往回看 7 天", () => {
    const now = at(16, 30)
    const slots = findMissedSlots("0 9 * * *", now - 30 * 86_400_000, now - 5_000, now)
    expect(slots).toHaveLength(7)
    expect(slots[0]).toBe(at(9, 0, 0, 14))
    expect(slots.at(-1)).toBe(at(9, 0, 0, 20))
  })

  it("表达式无效 → 空，不抛错", () => {
    expect(findMissedSlots("not a cron", at(8), at(8), at(16))).toEqual([])
  })
})
