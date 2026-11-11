import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import ChatPage from "../src/renderer/pages/ChatPage"

const KEY = "lk.chat.sidebarCollapsed"

/** 对话页首次渲染（还没加载到会话，也没选中会话）；stored 是 localStorage 里已经存着的收起状态 */
function renderFirstPaint(stored?: string): string {
  vi.stubGlobal("window", {
    innerWidth: 1200,
    localStorage: { getItem: (k: string) => (k === KEY ? stored ?? null : null), setItem: () => {} },
  })
  return renderToStaticMarkup(createElement(ChatPage, { active: true, onSwitchPage: vi.fn(), onSettings: vi.fn() }))
}

afterEach(() => { vi.unstubAllGlobals() })

const asideTag = (html: string): string => html.match(/<aside class="([^"]*)"/)?.[1] ?? ""
const toggleTag = (html: string): string => html.match(/<button[^>]*aria-label="会话栏"[^>]*>/)?.[0] ?? ""

describe("对话页左侧会话栏：首次渲染", () => {
  it("没存过：会话栏展开；没选中会话时顶栏里也有开关，提示指向左边", () => {
    const html = renderFirstPaint()
    expect(asideTag(html)).toMatch(/^flex /)
    expect(asideTag(html)).not.toContain("hidden")
    expect(toggleTag(html)).toContain('title="收起会话栏"')
    expect(toggleTag(html)).toContain('aria-expanded="true"')
  })

  it("上次收起了：会话栏一开始就是隐藏的，开关还在，能点它展开", () => {
    const html = renderFirstPaint("1")
    expect(asideTag(html)).toMatch(/^hidden /)
    expect(asideTag(html)).not.toMatch(/(^|\s)flex(\s|$)/)
    expect(toggleTag(html)).toContain('title="展开会话栏"')
    expect(toggleTag(html)).toContain('aria-expanded="false"')
  })

  it("上次存的是展开：展开", () => {
    expect(asideTag(renderFirstPaint("0"))).toMatch(/^flex /)
  })

  it("会话栏收起着时，左边的会话列表内容仍在 DOM 里（只是隐藏），展开后滚动位置不丢", () => {
    const html = renderFirstPaint("1")
    expect(html).toContain("<aside")
    expect(html).toContain("清空全部")
  })
})
