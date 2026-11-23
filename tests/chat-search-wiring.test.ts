import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import ChatItemList from "../src/renderer/components/chat/ChatItemList"
import ChatSearch from "../src/renderer/components/chat/ChatSearch"
import { NoticePill } from "../src/renderer/components/chat/ItemViews"
import type { AppChatItem, AppChatNoticeItem } from "../src/shared/app-chat-types"

const items: AppChatItem[] = [
  { kind: "user", id: "u1", ts: 1, text: "你好" },
  { kind: "assistant", id: "a1", ts: 2, finished: true, segments: [{ type: "reply", text: "好的" }] },
  { kind: "text", id: "t1", ts: 3, text: "独立文本" },
  { kind: "question", id: "q1", ts: 4, messageId: "q1", text: "选哪个？", options: ["甲", "乙"] },
  { kind: "image", id: "i1", ts: 5, path: "D:/a.png" },
  { kind: "file", id: "f1", ts: 6, path: "D:/a.txt", name: "a.txt" },
  { kind: "notice", id: "n1", ts: 7, text: "提示" },
]

type Search = NonNullable<Parameters<typeof ChatItemList>[0]["search"]>
const searchProp = (open: boolean): Search => ({ open, focusTick: 0, sessionKey: "k", onClose: () => {}, onLoadUntil: async () => true })

const render = (search?: Search) => renderToStaticMarkup(createElement(ChatItemList, {
  items, loading: false, hasMore: false, loadingEarlier: false, onLoadEarlier: () => {}, busy: false, onAnswer: () => {}, onCommand: () => {}, search,
}))

describe("对话列表：每条记录的定位锚点", () => {
  it("每种记录都套一层带自己 id 的锚点，搜索定位靠它找到记录", () => {
    const html = render()
    for (const it of items) expect(html, it.kind).toContain(`data-item-id="${it.id}"`)
    expect(html.match(/data-item-id=/g)).toHaveLength(items.length)
  })

  it("锚点是竖向 flex 容器：里面的 self-end、max-w 百分比和直接放在列里时一致，不改版面", () => {
    const anchors = render().match(/<div data-item-id="[^"]*" class="[^"]*">/g) ?? []
    expect(anchors).toHaveLength(items.length)
    for (const a of anchors) expect(a).toContain('class="flex flex-col"')
  })

  it("用户消息的浮条标记还在锚点里面", () => {
    expect(render()).toMatch(/<div data-item-id="u1" class="flex flex-col"><div data-user-item="u1"/)
  })
})

describe("对话列表：搜索条什么时候出现", () => {
  it("没传 search、或没打开：没有搜索条", () => {
    expect(render()).not.toContain('role="search"')
    expect(render(searchProp(false))).not.toContain('role="search"')
  })

  it("打开了：显示搜索条", () => {
    expect(render(searchProp(true))).toContain('role="search"')
  })
})

describe("提示条：折叠的全文", () => {
  const pill = (item: Partial<AppChatNoticeItem>) =>
    renderToStaticMarkup(createElement(NoticePill, { item: { kind: "notice", id: "n", ts: 1, text: "标题行", ...item }, onCommand: () => {} }))

  it("有全文：显示标题和「展开全文」，全文默认不出现", () => {
    const html = pill({ detail: "标题行\n\n很长的正文" })
    expect(html).toContain("标题行")
    expect(html).toContain("展开全文")
    expect(html).not.toContain("很长的正文")
  })

  it("没有全文：没有展开按钮", () => {
    const html = pill({})
    expect(html).toContain("标题行")
    expect(html).not.toContain("展开全文")
  })
})

describe("搜索条：刚打开的样子", () => {
  const html = renderToStaticMarkup(createElement(ChatSearch, { sessionKey: "k", focusTick: 0, onLocate: async () => true, onClose: () => {} }))

  it("有输入框；还没搜过，没有结果列表，也没有计数", () => {
    expect(html).toContain('aria-label="搜索聊天记录"')
    expect(html).not.toContain("max-h-80")
    expect(html).toMatch(/aria-live="polite"[^>]*><\/span>/)
  })

  it("没有命中时，更早 / 更新的按钮是禁用的，关闭按钮可用", () => {
    expect(html).toMatch(/<button type="button" title="更早的一条（Enter）"[^>]*disabled=""/)
    expect(html).toMatch(/<button type="button" title="更新的一条（Shift\+Enter）"[^>]*disabled=""/)
    expect(html).toMatch(/<button type="button" title="关闭（Esc）"(?![^>]*\sdisabled="")/)
  })
})
