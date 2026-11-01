import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { DirSheet, ModelSheet, PairSheet, SessionDrawer } from "../src/mobile/MobileModals"
import type { MobileChatTab, RouteStatus } from "../src/mobile/api"

const route: RouteStatus = { connected: true, activeUrl: "http://x", routeType: "lan" }
const noop = vi.fn()

const tab = (over: Partial<MobileChatTab> = {}): MobileChatTab => ({
  sessionKey: "chan::C:\\work\\demo",
  label: "demo",
  kind: "dir",
  running: false,
  current: false,
  removable: true,
  ...over,
})

describe("底部弹层都带可拖动的抓手", () => {
  it("模型弹层", () => {
    const html = renderToStaticMarkup(
      createElement(ModelSheet, {
        open: true, onClose: noop, baseUrl: "", token: "", resources: [], quickModels: [],
        switching: false, onSelect: noop,
      }),
    )
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
  })

  it("目录弹层", () => {
    const html = renderToStaticMarkup(
      createElement(DirSheet, { open: true, onClose: noop, tabs: [], selected: null, sessionName: () => "", onSelect: noop }),
    )
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
  })

  it("配对弹层", () => {
    const html = renderToStaticMarkup(
      createElement(PairSheet, {
        open: true, onClose: noop, config: { pubUrl: "", lanUrl: "", token: "" }, route,
        reconnecting: false, onSaveAndConnect: noop,
      }),
    )
    expect((html.match(/data-sheet-grip/g) ?? []).length).toBe(1)
  })

  it("关着的时候什么都不渲染", () => {
    const html = renderToStaticMarkup(
      createElement(DirSheet, { open: false, onClose: noop, tabs: [], selected: null, sessionName: () => "", onSelect: noop }),
    )
    expect(html).toBe("")
  })

  it("抓手是触摸专用的拖动区：不触发浏览器滚动，高度足够手指按住", () => {
    const html = renderToStaticMarkup(
      createElement(DirSheet, { open: true, onClose: noop, tabs: [], selected: null, sessionName: () => "", onSelect: noop }),
    )
    const grip = /<div data-sheet-grip[^>]*>/.exec(html)?.[0] ?? ""
    expect(grip).toContain("touch-none")
    expect(grip).toContain("py-2.5")
  })
})

describe("会话抽屉里的删除按钮", () => {
  const render = (tabs: MobileChatTab[]) =>
    renderToStaticMarkup(
      createElement(SessionDrawer, {
        open: true, onClose: noop, hostname: "pc", route,
        views: [{ channelId: "c1", name: "通道", tabs }],
        selected: null, sessionName: (t: MobileChatTab) => t.label, sessionStatus: () => "idle",
        activeAt: () => undefined, usageBytes: null, onSelect: noop, onNewTemp: noop,
        onDelete: noop, onClearAll: noop, onOpenPair: noop,
      }),
    )

  it("触控区至少 44px 见方，并带读屏名称", () => {
    const html = render([tab()])
    const btn = /<button[^>]*aria-label="删除会话"[^>]*>/.exec(html)?.[0] ?? ""
    expect(btn).not.toBe("")
    expect(btn).toContain("h-11")
    expect(btn).toContain("w-11")
  })

  it("不可删除的会话不出现删除按钮", () => {
    expect(render([tab({ removable: false })])).not.toContain("删除会话")
    expect(render([tab({ kind: "project" })])).not.toContain("删除会话")
  })
})
