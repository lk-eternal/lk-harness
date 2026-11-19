import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import ChatItemList from "../src/renderer/components/chat/ChatItemList"
import { UserBubble } from "../src/renderer/components/chat/ItemViews"
import { alignToColumn, lastIndexAbove, userMessagePreview } from "../src/renderer/components/chat/StickyUserMessage"
import MobileItemList from "../src/mobile/MobileItems"
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

describe("alignToColumn：浮条量出气泡所在那一列的位置", () => {
  it("桌面：竖向滚动条占 6px，列居中封顶 → 浮条让开滚动条，左右留白等于列两侧的空隙", () => {
    // 滚动区 900 宽（含 6px 滚动条）、两侧内边距 24、列 768 居中
    expect(alignToColumn({ left: 0, right: 900 }, { offsetWidth: 900, clientWidth: 894 }, { left: 63, right: 831 })).toEqual({ gutter: 6, left: 63, right: 63 })
  })

  it("手机：滚动条不占宽，列贴着 14px 的内边距", () => {
    expect(alignToColumn({ left: 0, right: 390 }, { offsetWidth: 390, clientWidth: 390 }, { left: 14, right: 376 })).toEqual({ gutter: 0, left: 14, right: 14 })
  })

  it("滚动区自己不在屏幕最左边（左边有侧栏）：量的是相对滚动区的距离", () => {
    expect(alignToColumn({ left: 260, right: 1160 }, { offsetWidth: 900, clientWidth: 894 }, { left: 323, right: 1091 })).toEqual({ gutter: 6, left: 63, right: 63 })
  })
})

describe("手机端接线：同一个浮条挂在 MobileItemList 上", () => {
  const user = (id: string, text: string, images?: string[]): AppChatUserItem => ({ kind: "user", id, ts: 1, text, images })
  const render = (items: AppChatItem[]) => renderToStaticMarkup(createElement(MobileItemList, {
    items, loading: false, busy: false, hasMore: false, loadingEarlier: false, onLoadEarlier: () => {},
    sessionKey: "chan::demo", baseUrl: "http://x", token: "t", onAnswer: () => {}, onCommand: () => {},
  }))

  it("每条用户消息都带标记，浮条默认隐藏且不可聚焦", () => {
    const html = render([user("u1", "第一问"), { kind: "text", id: "t1", ts: 2, text: "回答" }, user("u2", "第二问")])
    expect(html).toContain('data-user-item="u1"')
    expect(html).toContain('data-user-item="u2"')
    expect(html).toMatch(/<div aria-hidden="true" style="background:linear-gradient[^>]*class="[^"]*\binvisible\b/)
    expect(html).toMatch(/<button type="button" tabindex="-1" title="回到这条消息"/)
  })

  it("点浮条回去时闪的是文字气泡和图片组，不是外层（外层还包着时间行）", () => {
    const textOnly = render([user("u1", "你好")])
    expect(textOnly.match(/data-user-flash/g)).toHaveLength(1)
    expect(textOnly).toMatch(/<div data-user-flash="true" class="[^"]*">\s*你好\s*<\/div>/)
    expect(textOnly.match(/<div [^>]*data-user-item[^>]*>/)?.[0]).not.toContain("data-user-flash")

    expect(render([user("u1", "看图", ["D:/a.png", "D:/b.png"])]).match(/data-user-flash/g)).toHaveLength(2)
    expect(render([user("u1", "", ["D:/a.png"])]).match(/data-user-flash/g)).toHaveLength(1)
  })
})

describe("接线：浮条靠 data-user-item 找消息，靠 ChatItemList 挂载", () => {
  const user = (id: string, text: string): AppChatUserItem => ({ kind: "user", id, ts: 1, text })

  it("UserBubble 带上自己的消息 id", () => {
    const html = renderToStaticMarkup(createElement(UserBubble, { item: user("u-42", "你好") }))
    expect(html).toContain('data-user-item="u-42"')
  })

  it("点浮条回去时闪的是文字气泡，不是外层（外层还包着时间行）", () => {
    const html = renderToStaticMarkup(createElement(UserBubble, { item: user("u1", "你好") }))
    expect(html.match(/data-user-flash/g)).toHaveLength(1)
    expect(html).toMatch(/<div data-user-flash="true" class="[^"]*">你好<\/div>/)
    expect(html.match(/<div [^>]*data-user-item[^>]*>/)?.[0]).not.toContain("data-user-flash")
  })

  it("带图片：图片组和文字气泡各闪各的；纯图片只闪图片组", () => {
    const withImages = (text: string): AppChatUserItem => ({ ...user("u1", text), images: ["D:/a.png", "D:/b.png"] })
    const both = renderToStaticMarkup(createElement(UserBubble, { item: withImages("看图") }))
    expect(both.match(/data-user-flash/g)).toHaveLength(2)
    expect(both).toMatch(/<div data-user-flash="true" class="[^"]*">看图<\/div>/)
    const onlyImages = renderToStaticMarkup(createElement(UserBubble, { item: withImages("") }))
    expect(onlyImages.match(/data-user-flash/g)).toHaveLength(1)
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

  it("浮条按钮是手形光标（Tailwind v4 的按钮默认是箭头）", () => {
    const html = renderToStaticMarkup(createElement(ChatItemList, {
      items: [user("u1", "第一问")], loading: false, hasMore: false, loadingEarlier: false, onLoadEarlier: () => {}, busy: false, onAnswer: () => {}, onCommand: () => {},
    }))
    expect(html).toMatch(/<button [^>]*title="回到这条消息"[^>]*class="[^"]*\bcursor-pointer\b/)
  })
})
