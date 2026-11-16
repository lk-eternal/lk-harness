import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import PreviewPanel from "../src/renderer/components/preview/PreviewPanel"
import type { PreviewController } from "../src/renderer/components/preview/PreviewContext"
import { createSidebarWidthStore } from "../src/renderer/components/chat/sidebar-width"

afterEach(() => { vi.unstubAllGlobals() })

/** 只给面板渲染用得到的那几项；别的方法一律是空函数 */
function fakeController(width: number): PreviewController {
  const base = {
    state: {
      open: true,
      activeId: "f1",
      tabs: [{ id: "f1", kind: "file", sessionKey: "s", path: "D:\\a\\b.txt", name: "b.txt", reload: 0 }],
    },
    width,
    linkMode: "internal",
  }
  return new Proxy(base, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => {}) }) as unknown as PreviewController
}

/** 面板的宽度：windowWidth 是窗口宽，sidebarWidth 是会话栏存着的宽度（null 表示没存过，用默认） */
function panelWidth(opts: { windowWidth: number; sidebarWidth?: number | null; collapsed?: boolean; stored?: number }): number | null {
  vi.stubGlobal("window", { innerWidth: opts.windowWidth })
  const store = createSidebarWidthStore({
    getItem: (k) => (k === "lk.chat.sidebarWidth" && opts.sidebarWidth != null ? String(opts.sidebarWidth) : null),
    setItem: () => {},
  })
  const html = renderToStaticMarkup(createElement(PreviewPanel, {
    controller: fakeController(opts.stored ?? 520),
    visible: true,
    sidebarStore: store,
    sidebarCollapsed: opts.collapsed ?? false,
  }))
  const m = html.match(/<aside[^>]*style="width:(\d+)px"/)
  return m ? Number(m[1]) : null
}

describe("预览面板的宽度跟着会话栏走", () => {
  it("窗口够宽：就是存着的宽度", () => {
    expect(panelWidth({ windowWidth: 1400 })).toBe(520)
    expect(panelWidth({ windowWidth: 1400, sidebarWidth: 480 })).toBe(520)
  })

  it("会话栏是默认宽度：和原来写死 240 的算法一样（窗口 1000，面板最宽 460）", () => {
    expect(panelWidth({ windowWidth: 1000 })).toBe(460)
    expect(panelWidth({ windowWidth: 1000, stored: 900 })).toBe(460)
  })

  it("会话栏被拖宽：面板让出相应的位置，最窄到 320", () => {
    expect(panelWidth({ windowWidth: 1000, sidebarWidth: 300 })).toBe(400)
    expect(panelWidth({ windowWidth: 1000, sidebarWidth: 380 })).toBe(320)
  })

  it("会话栏收起：不占位置，面板能用上", () => {
    expect(panelWidth({ windowWidth: 1000, sidebarWidth: 380, collapsed: true })).toBe(520)
    expect(panelWidth({ windowWidth: 1000, collapsed: true, stored: 900 })).toBe(700)
  })

  it("存着的宽度比最窄还窄：收到 320", () => {
    expect(panelWidth({ windowWidth: 1400, stored: 100 })).toBe(320)
  })

  it("窗口窄得放不下：面板还是至少 320", () => {
    expect(panelWidth({ windowWidth: 780 })).toBe(320)
  })
})
