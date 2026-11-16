import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import ChatPage from "../src/renderer/pages/ChatPage"

const KEY = "lk.chat.sidebarCollapsed"
const WIDTH_KEY = "lk.chat.sidebarWidth"

/** 对话页首次渲染（还没加载到会话，也没选中会话）；stored 是 localStorage 里已经存着的收起状态，storedWidth 是存着的会话栏宽度 */
function renderFirstPaint(stored?: string, storedWidth?: string, windowWidth = 1200): string {
  vi.stubGlobal("window", {
    innerWidth: windowWidth,
    localStorage: {
      getItem: (k: string) => (k === KEY ? stored ?? null : k === WIDTH_KEY ? storedWidth ?? null : null),
      setItem: () => {},
    },
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

const asideStyle = (html: string): string => html.match(/<aside [^>]*style="([^"]*)"/)?.[1] ?? ""
const separatorTag = (html: string): string => html.match(/<div[^>]*role="separator"[^>]*>/)?.[0] ?? ""

describe("对话页左侧会话栏：宽度可以拖动调整", () => {
  it("没存过：默认 240px（和原来写死的 w-60 一样宽）", () => {
    const html = renderFirstPaint()
    expect(asideStyle(html)).toBe("width:240px")
    expect(asideTag(html)).not.toContain("w-60")
  })

  it("存过：一打开就是上次拖到的宽度", () => {
    expect(asideStyle(renderFirstPaint(undefined, "360"))).toBe("width:360px")
  })

  it("存的宽度不能用（不是数字、没到最窄、超过最宽）：用默认宽度或收回范围内，不会渲染出怪样子", () => {
    expect(asideStyle(renderFirstPaint(undefined, "abc"))).toBe("width:240px")
    expect(asideStyle(renderFirstPaint(undefined, "50"))).toBe("width:240px")
    expect(asideStyle(renderFirstPaint(undefined, "99999"))).toBe("width:480px")
  })

  it("窗口太窄放不下存着的宽度：显示时收窄，给对话区留位置；拖动条上的当前宽度和最宽值也是收窄后的", () => {
    const html = renderFirstPaint(undefined, "480", 700)
    expect(asideStyle(html)).toBe("width:400px")
    expect(separatorTag(html)).toContain('aria-valuenow="400"')
    expect(separatorTag(html)).toContain('aria-valuemax="400"')
  })

  it("栏右边缘有拖动条：竖向分隔条，能用键盘聚焦，带当前宽度和范围", () => {
    const tag = separatorTag(renderFirstPaint(undefined, "300"))
    expect(tag).toContain('aria-orientation="vertical"')
    expect(tag).toContain('tabindex="0"')
    expect(tag).toContain('aria-valuenow="300"')
    expect(tag).toContain('aria-valuemin="240"')
    expect(tag).toContain('aria-valuemax="480"')
    expect(tag).toContain("cursor-col-resize")
  })

  it("拖动条在栏里面（压在右边框上），不是布局里多出来的一块：栏和对话区之间没有多余的空隙", () => {
    const html = renderFirstPaint()
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"))
    expect(aside).toContain('role="separator"')
    expect(asideTag(html)).toContain("relative")
  })

  it("会话栏收起着：整栏隐藏（拖动条跟着藏），存着的宽度不丢", () => {
    const html = renderFirstPaint("1", "360")
    expect(asideTag(html)).toMatch(/^hidden /)
    expect(asideStyle(html)).toBe("width:360px")
  })
})
