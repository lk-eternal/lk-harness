import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import ChatItemList from "../src/renderer/components/chat/ChatItemList"
import { UserBubble } from "../src/renderer/components/chat/ItemViews"
import { lastIndexAbove, userMessagePreview } from "../src/renderer/components/chat/StickyUserMessage"
import type { AppChatItem, AppChatUserItem } from "../src/shared/app-chat-types"

const bottomsOf = (bottoms: number[]) => (i: number) => bottoms[i]

describe("lastIndexAbove：找最后一个底边落在 limit 及以上的元素", () => {
  it("没有元素 / 全在 limit 下方：-1", () => {
    expect(lastIndexAbove(0, () => 0, 46)).toBe(-1)
    expect(lastIndexAbove(3, bottomsOf([60, 200, 400]), 46)).toBe(-1)
  })

  it("全在 limit 上方：最后一个", () => {
    expect(lastIndexAbove(3, bottomsOf([-300, -200, 10]), 46)).toBe(2)
  })

  it("夹在中间：最靠下的那个已滚出的", () => {
    expect(lastIndexAbove(5, bottomsOf([-900, -500, 20, 300, 700]), 46)).toBe(2)
  })

  it("底边正好等于 limit 算已滚出，差一点点不算", () => {
    expect(lastIndexAbove(2, bottomsOf([-100, 46]), 46)).toBe(1)
    expect(lastIndexAbove(2, bottomsOf([-100, 46.5]), 46)).toBe(0)
  })

  it("和逐个扫描的结果一致（随机、含相等的底边）", () => {
    let seed = 20261118
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let round = 0; round < 300; round++) {
      const count = Math.floor(next() * 40)
      const bottoms: number[] = []
      let y = -Math.floor(next() * 800)
      for (let i = 0; i < count; i++) {
        y += Math.floor(next() * 120)
        bottoms.push(y)
      }
      const limit = Math.floor(next() * 600) - 200
      let linear = -1
      bottoms.forEach((b, i) => { if (b <= limit) linear = i })
      expect(lastIndexAbove(count, bottomsOf(bottoms), limit), `bottoms=${bottoms} limit=${limit}`).toBe(linear)
    }
  })

  it("只读 log₂n 个位置：一万条消息也不会逐个量", () => {
    let reads = 0
    const n = 10000
    const idx = lastIndexAbove(n, (i) => { reads += 1; return i * 10 }, 5000)
    expect(idx).toBe(500)
    expect(reads).toBeLessThanOrEqual(15)
  })
})

describe("userMessagePreview：浮条里的一行预览", () => {
  it("多行、多空白折成一行", () => {
    expect(userMessagePreview({ text: "  帮我梳理：\n1. 哪些会重投\n\n2.   为什么\t还会  " })).toBe("帮我梳理： 1. 哪些会重投 2. 为什么 还会")
  })

  it("纯图片 / 只有空白：显示「[图片]」", () => {
    expect(userMessagePreview({ text: "" })).toBe("[图片]")
    expect(userMessagePreview({ text: " \n\t " })).toBe("[图片]")
  })

  it("超长消息只取前 200 字", () => {
    const line = userMessagePreview({ text: "日志".repeat(500) })
    expect(line).toHaveLength(200)
    expect(line).toBe("日志".repeat(100))
  })
})

describe("接线：浮条靠 data-user-item 找消息，靠 ChatItemList 挂载", () => {
  const user = (id: string, text: string): AppChatUserItem => ({ kind: "user", id, ts: 1, text })

  it("UserBubble 带上自己的消息 id", () => {
    const html = renderToStaticMarkup(createElement(UserBubble, { item: user("u-42", "你好") }))
    expect(html).toContain('data-user-item="u-42"')
  })

  it("ChatItemList 里每条用户消息都带标记，浮条默认隐藏且不可聚焦", () => {
    const items: AppChatItem[] = [
      user("u1", "第一问"),
      { kind: "text", id: "t1", ts: 2, text: "回答" },
      user("u2", "第二问"),
    ]
    const html = renderToStaticMarkup(createElement(ChatItemList, {
      items, loading: false, hasMore: false, loadingEarlier: false, onLoadEarlier: () => {}, busy: false, onAnswer: () => {}, onCommand: () => {},
    }))
    expect(html).toContain('data-user-item="u1"')
    expect(html).toContain('data-user-item="u2"')
    // 浮条本身默认隐藏（图标自己也带 aria-hidden，所以要对着浮条那一层断言）
    expect(html).toMatch(/<div aria-hidden="true" style="background:linear-gradient[^>]*class="[^"]*\binvisible\b/)
    expect(html).toMatch(/<button type="button" tabindex="-1" title="回到这条消息"/)
  })
})
