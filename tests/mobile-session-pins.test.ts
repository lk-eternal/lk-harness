import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionDrawer } from "../src/mobile/MobileModals"
import { setMobileSessionPinned, type MobileChatTab, type RouteStatus } from "../src/mobile/api"
import { appChatSessionId } from "../src/shared/app-chat-types"

/** 手机端会话抽屉里的置顶：和桌面端同一份（电脑端存着），这里只管怎么排、怎么显示、怎么发请求 */

// 抽屉用它挂手机的返回键；点击测试要把抽屉当普通函数调，不能真的用 hook
vi.mock("../src/mobile/back-stack", () => ({ useBackToClose: () => {} }))

const noop = () => {}
const route: RouteStatus = { connected: true, activeUrl: "http://x", routeType: "lan" }
const tab = (n: string): MobileChatTab => ({
  sessionKey: `ch|app_main::D:\\work\\${n}`, label: n, kind: "dir", running: false, current: false, removable: true,
})

function render(tabs: MobileChatTab[], over: Record<string, unknown> = {}, at: Record<string, number> = {}): string {
  return renderToStaticMarkup(createElement(SessionDrawer, {
    open: true, onClose: noop, hostname: "pc", route,
    views: [{ channelId: "c1", name: "通道", tabs }],
    selected: null, sessionName: (t: MobileChatTab) => `会话${t.label}`, sessionStatus: () => "idle",
    activeAt: (t: MobileChatTab) => at[t.label], usageBytes: null, onSelect: noop, onNewTemp: noop, onNewProject: noop,
    onDelete: noop, onClearAll: noop, onOpenPair: noop, ...over,
  }))
}

/** 列表里各会话出现的先后 */
const order = (html: string, names: string[]): string[] =>
  names.map((n) => ({ n, i: html.indexOf(`会话${n}<`) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i).map((x) => x.n)

const pinButtons = (html: string) => [...html.matchAll(/<button[^>]*aria-label="(?:取消置顶|置顶会话)"[^>]*>/g)].map((m) => m[0])

describe("手机端会话抽屉：置顶", () => {
  const tabs = [tab("a"), tab("b"), tab("c")]
  const recent = { a: 300, b: 200, c: 100 }

  it("没有置顶：按最近对话排", () => {
    expect(order(render(tabs, {}, recent), ["a", "b", "c"])).toEqual(["a", "b", "c"])
  })

  it("置顶的排在最前，哪怕最近没聊过；其余仍按最近对话排", () => {
    const html = render(tabs, { pins: [appChatSessionId(tabs[2].sessionKey)] }, recent)
    expect(order(html, ["a", "b", "c"])).toEqual(["c", "a", "b"])
  })

  it("每个会话一个图钉按钮：置顶的标「取消置顶」并处于按下状态，没置顶的标「置顶会话」", () => {
    const html = render(tabs, { pins: [appChatSessionId(tabs[1].sessionKey)] }, recent)
    const btns = pinButtons(html)
    expect(btns).toHaveLength(3)
    expect(btns.filter((b) => b.includes('aria-label="取消置顶"'))).toHaveLength(1)
    expect(btns.filter((b) => b.includes('aria-pressed="true"'))).toHaveLength(1)
    expect(btns.filter((b) => b.includes('aria-pressed="false"'))).toHaveLength(2)
  })

  it("项目会话也能置顶（它没有删除按钮，但有图钉）", () => {
    const project: MobileChatTab = { ...tab("p"), kind: "project", removable: true }
    const html = render([project])
    expect(pinButtons(html)).toHaveLength(1)
    expect(html).not.toContain("删除会话")
  })

  it("触控区不小于 44px 高，不会误触到旁边的删除按钮", () => {
    const btn = pinButtons(render([tab("a")]))[0]
    expect(btn).toContain("h-11")
  })

  it("点图钉：带着这个会话去切换置顶，不会同时选中会话", () => {
    const onTogglePin = vi.fn()
    const onSelect = vi.fn()
    const el = SessionDrawer({
      open: true, onClose: noop, hostname: "pc", route,
      views: [{ channelId: "c1", name: "通道", tabs: [tab("a")] }],
      selected: null, sessionName: () => "x", sessionStatus: () => "idle", activeAt: () => undefined,
      usageBytes: null, onSelect, onNewTemp: noop, onNewProject: noop, onTogglePin, onDelete: noop, onClearAll: noop, onOpenPair: noop,
    })
    const stop = vi.fn()
    const handlers: Array<(e: { stopPropagation: () => void }) => void> = []
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return
      const node = n as { props?: Record<string, unknown>; type?: unknown }
      const p = node.props
      if (p && p["aria-label"] === "置顶会话") handlers.push(p.onClick as (e: { stopPropagation: () => void }) => void)
      if (p) for (const c of ([] as unknown[]).concat(p.children ?? [])) walk(c)
      if (Array.isArray(n)) for (const c of n) walk(c)
    }
    walk(el)
    expect(handlers).toHaveLength(1)
    handlers[0]({ stopPropagation: stop })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    expect(onTogglePin.mock.calls[0][0].label).toBe("a")
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe("手机端：置顶请求", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("带着会话键和要置顶还是取消发给电脑端，成功时带回最新列表", async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return { json: async () => ({ ok: true, pins: ["x"] }), status: 200 }
    }))
    const r = await setMobileSessionPinned("http://pc:1/", "tok", "k1", true)
    expect(r).toEqual({ ok: true, pins: ["x"] })
    expect(calls).toEqual([{ url: "http://pc:1/api/mobile/pin-session", body: { sessionKey: "k1", pinned: true } }])
  })

  it("旧版电脑端没有这个接口：给明确的升级提示，不是干巴巴的「未知接口」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: false, error: "未知接口" }), status: 404 })))
    const r = await setMobileSessionPinned("http://pc:1", "tok", "k1", true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("电脑端版本过旧")
  })

  it("电脑端自己拒绝的（比如不是应用内会话）：原话带回", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: false, error: "不是应用内对话的会话" }), status: 200 })))
    expect((await setMobileSessionPinned("http://pc:1", "tok", "k1", false)).error).toBe("不是应用内对话的会话")
  })
})
