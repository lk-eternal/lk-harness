import { describe, expect, it } from "vitest"
import { followBottomAfterScroll } from "../src/mobile/follow-bottom"

describe("followBottomAfterScroll：滚动之后要不要继续跟着新内容滚到底", () => {
  it("在底部附近、没往上滚：跟着（不管之前跟没跟）", () => {
    expect(followBottomAfterScroll(false, false, true)).toBe(true)
    expect(followBottomAfterScroll(true, false, true)).toBe(true)
  })

  it("离开了底部：不跟，不管方向和之前的状态", () => {
    expect(followBottomAfterScroll(true, true, false)).toBe(false)
    expect(followBottomAfterScroll(true, false, false)).toBe(false)
    expect(followBottomAfterScroll(false, false, false)).toBe(false)
  })

  it("正在跟着、往上滚但还在附近：保持跟着（键盘收起、内容回弹这类自动调整不该让它松手）", () => {
    expect(followBottomAfterScroll(true, true, true)).toBe(true)
  })

  it("没在跟着、往上滚：即使还在附近也不重新打开", () => {
    expect(followBottomAfterScroll(false, true, true)).toBe(false)
  })

  it("点顶部浮条回到某条提问：先松手，再平滑往上滚的头几十 px 都不会被重新打开", () => {
    let following = true
    following = false // 点浮条时 onBeforeJump 松手
    let top = 5000
    // 从最底部（离底 0）开始平滑滚动：scrollTop 一路减小，离底部 10、30、60 px 时都还在「附近」，90 px 起已经离开
    for (const dist of [10, 30, 60, 90, 400]) {
      const next = 5000 - dist
      following = followBottomAfterScroll(following, next < top, dist < 72)
      top = next
      expect(following).toBe(false)
    }
  })

  it("用户之后自己往下滚回底部：重新跟着", () => {
    let following = false
    let top = 3000
    for (const dist of [400, 200, 90, 60, 10, 0]) {
      const next = 5000 - dist
      following = followBottomAfterScroll(following, next < top, dist < 72)
      top = next
    }
    expect(following).toBe(true)
  })
})
