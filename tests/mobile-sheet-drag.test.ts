import { describe, expect, it } from "vitest"
import {
  SHEET_FLING_MIN_PX,
  SHEET_FLING_VELOCITY,
  SHEET_MIN_DISMISS_PX,
  dragVelocity,
  sheetOffset,
  shouldDismissSheet,
} from "../src/mobile/sheet-drag"

describe("sheetOffset：弹层只能往下拉", () => {
  it("往下拉时跟手，往上拉不动", () => {
    expect(sheetOffset(37)).toBe(37)
    expect(sheetOffset(0)).toBe(0)
    expect(sheetOffset(-50)).toBe(0)
  })
})

describe("dragVelocity：向下为正，只看最近一小段", () => {
  it("采样不足时是 0", () => {
    expect(dragVelocity([])).toBe(0)
    expect(dragVelocity([{ y: 10, t: 0 }])).toBe(0)
  })

  it("匀速向下", () => {
    expect(dragVelocity([{ y: 0, t: 0 }, { y: 30, t: 30 }, { y: 60, t: 60 }])).toBeCloseTo(1, 5)
  })

  it("向上为负", () => {
    expect(dragVelocity([{ y: 100, t: 0 }, { y: 50, t: 50 }])).toBeCloseTo(-1, 5)
  })

  it("窗口之外的老采样不参与：先慢慢拖，最后一下才甩", () => {
    // 前 1 秒只动了 40px（整段算下来只有 0.04px/ms），最后 30ms 动了 60px（2px/ms）
    const samples = [
      { y: 0, t: 0 },
      { y: 10, t: 500 },
      { y: 40, t: 1030 },
      { y: 100, t: 1060 },
    ]
    expect(dragVelocity(samples)).toBeCloseTo(2, 5)
    // 把窗口放宽到能覆盖整段，才会被老采样拉低
    expect(dragVelocity(samples, 2000)).toBeLessThan(0.1)
  })

  it("时间戳相同不会除零", () => {
    expect(dragVelocity([{ y: 0, t: 5 }, { y: 100, t: 5 }])).toBe(0)
  })
})

describe("shouldDismissSheet：松手时是否关闭", () => {
  const H = 400

  it("没往下拖（或往上拖）一律不关", () => {
    expect(shouldDismissSheet(0, 5, H)).toBe(false)
    expect(shouldDismissSheet(-30, 5, H)).toBe(false)
  })

  it("慢慢拖：没到阈值弹回，到了阈值关闭", () => {
    const threshold = Math.max(SHEET_MIN_DISMISS_PX, H * 0.25)
    expect(shouldDismissSheet(threshold - 1, 0, H)).toBe(false)
    expect(shouldDismissSheet(threshold, 0, H)).toBe(true)
  })

  it("高弹层的阈值按高度的 1/4 算，不会只拖一小段就关", () => {
    expect(shouldDismissSheet(150, 0, 800)).toBe(false)
    expect(shouldDismissSheet(200, 0, 800)).toBe(true)
  })

  it("矮弹层的阈值不低于最小距离", () => {
    expect(shouldDismissSheet(SHEET_MIN_DISMISS_PX - 1, 0, 120)).toBe(false)
    expect(shouldDismissSheet(SHEET_MIN_DISMISS_PX, 0, 120)).toBe(true)
  })

  it("往下一甩：速度够快、动了一点就关", () => {
    expect(shouldDismissSheet(SHEET_FLING_MIN_PX, SHEET_FLING_VELOCITY, H)).toBe(true)
  })

  it("一甩要同时满足速度和最小距离：手指抖一下不关", () => {
    expect(shouldDismissSheet(SHEET_FLING_MIN_PX - 1, SHEET_FLING_VELOCITY * 4, H)).toBe(false)
    expect(shouldDismissSheet(SHEET_FLING_MIN_PX, SHEET_FLING_VELOCITY - 0.01, H)).toBe(false)
  })
})
