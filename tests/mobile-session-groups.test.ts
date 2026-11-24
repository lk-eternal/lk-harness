import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionDrawer } from "../src/mobile/MobileModals"
import { setMobileSessionGroup, type MobileChatTab, type RouteStatus } from "../src/mobile/api"
import { type SessionGroupControl } from "../src/renderer/components/chat/session-groups-state"
import { parseGroupStates, type SessionGroupStates, type SessionListGroupId } from "../src/shared/session-groups"

/** 手机端会话抽屉里的分类（项目 / 会话 / 已归档）：和桌面端同一份折叠状态，这里只管怎么画、怎么发请求 */

// 抽屉用它挂手机的返回键；点击测试要把抽屉当普通函数调，不能真的用 hook
vi.mock("../src/mobile/back-stack", () => ({ useBackToClose: () => {} }))

const noop = () => {}
const route: RouteStatus = { connected: true, activeUrl: "http://x", routeType: "lan" }
const chatTab = (n: string): MobileChatTab => ({
  sessionKey: `ch|app_main::D:\\work\\${n}`, label: n, kind: "dir", running: false, current: false, removable: true,
})
const projectTab = (n: string): MobileChatTab => ({ ...chatTab(n), kind: "project" })
const archivedTab = (n: string): MobileChatTab => ({ ...projectTab(n), archived: true })

function control(states: SessionGroupStates = parseGroupStates(undefined)): { c: SessionGroupControl; changes: [SessionListGroupId, object][] } {
  const changes: [SessionListGroupId, object][] = []
  return { c: { states, change: (g, p) => { changes.push([g, p]) }, isRevealed: () => false, clearReveal: noop }, changes }
}

function props(tabs: MobileChatTab[], over: Record<string, unknown> = {}) {
  return {
    open: true, onClose: noop, hostname: "pc", route,
    views: [{ channelId: "c1", name: "通道", tabs }],
    selected: null, sessionName: (t: MobileChatTab) => `会话${t.label}`, sessionStatus: () => "idle",
    activeAt: () => undefined, usageBytes: null, onSelect: noop, onNewTemp: noop, onNewProject: noop,
    onDelete: noop, onClearAll: noop, onOpenPair: noop, ...over,
  }
}
const render = (tabs: MobileChatTab[], over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(SessionDrawer, props(tabs, over) as never))

/** 列表里各分类出现的先后 */
const groupOrder = (html: string): string[] =>
  [...html.matchAll(/data-session-group="(\w+)"/g)].map((m) => m[1])

const names = (html: string): string[] => [...html.matchAll(/会话([a-z0-9]+)</g)].map((m) => m[1])

describe("手机端会话抽屉：分类", () => {
  it("项目在上、会话在中间、已归档在最后；不管会话是按什么顺序给的", () => {
    const html = render([archivedTab("z"), chatTab("c"), projectTab("p")])
    expect(groupOrder(html)).toEqual(["project", "chat", "archived"])
  })

  it("没有的分类不出现", () => {
    expect(groupOrder(render([chatTab("c")]))).toEqual(["chat"])
    expect(groupOrder(render([]))).toEqual([])
  })

  it("已归档默认折着：只看到标题和个数，会话不显示", () => {
    const html = render([projectTab("p"), archivedTab("z1"), archivedTab("z2")])
    expect(names(html)).toEqual(["p"])
    expect(html).toContain("已归档")
  })

  it("已归档展开后能看到里面的会话（半透明显示）", () => {
    const { c } = control(parseGroupStates({ archived: { collapsed: false } }))
    const html = render([archivedTab("z1")], { groups: c })
    expect(names(html)).toEqual(["z1"])
    expect(html).toContain("opacity-70")
  })

  it("一类超过 5 个：先显示 5 个，底部「展开更多」", () => {
    const tabs = Array.from({ length: 8 }, (_, i) => chatTab(`c${i + 1}`))
    const html = render(tabs)
    expect(names(html)).toHaveLength(5)
    expect(html).toContain("展开更多（还有 3 个）")
  })

  it("记下的是折着：这一类的会话和底部按钮都不显示", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }))
    const html = render(Array.from({ length: 8 }, (_, i) => chatTab(`c${i + 1}`)), { groups: c })
    expect(names(html)).toEqual([])
    expect(html).not.toContain("展开更多")
  })

  it("多个通道：项目和会话按通道各一份，已归档合并在最下面一份", () => {
    const html = renderToStaticMarkup(createElement(SessionDrawer, {
      ...props([]),
      views: [
        { channelId: "c1", name: "通道一", tabs: [projectTab("p1"), archivedTab("z1")] },
        { channelId: "c2", name: "通道二", tabs: [chatTab("c2"), archivedTab("z2")] },
      ],
    } as never))
    expect(groupOrder(html)).toEqual(["project", "chat", "archived"])
    expect(html).toContain("通道一")
    expect(html).toContain("通道二")
  })

  it("折着的分类里有会话在回复：标题上有提示", () => {
    const html = render([archivedTab("z")], { sessionStatus: () => "working" })
    expect(html).toContain('aria-label="有会话正在回复"')
  })
})

describe("手机端会话抽屉：点分类", () => {
  type SectionProps = { group?: string; onToggle?: () => void; onFooter?: (to: number) => void }

  /** 把抽屉当普通函数调，取出各分类的 props */
  function sections(tabs: MobileChatTab[], c: SessionGroupControl): SectionProps[] {
    const el = SessionDrawer(props(tabs, { groups: c }) as never)
    const found: SectionProps[] = []
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return
      if (Array.isArray(n)) { for (const x of n) walk(x); return }
      const p = (n as { props?: Record<string, unknown> }).props
      if (!p) return
      if (typeof p.group === "string" && typeof p.onToggle === "function") found.push(p as SectionProps)
      walk(p.children)
    }
    walk(el)
    return found
  }

  it("点标题：折叠 / 展开这一类（交给分类状态去记）", () => {
    const { c, changes } = control()
    const found = sections([chatTab("a"), archivedTab("z")], c)
    expect(found.map((s) => s.group)).toEqual(["chat", "archived"])
    found[0].onToggle?.()
    found[1].onToggle?.()
    expect(changes).toEqual([["chat", { collapsed: true }], ["archived", { collapsed: false }]])
  })

  it("点底部按钮：去它指的档位", () => {
    const { c, changes } = control()
    const found = sections(Array.from({ length: 8 }, (_, i) => chatTab(`c${i + 1}`)), c)
    found[0].onFooter?.(1)
    expect(changes).toEqual([["chat", { level: 1 }]])
  })
})

describe("手机端：折叠 / 展开分类的请求", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("带着是哪一类、改什么发给电脑端，成功时带回各类最新状态", async () => {
    const calls: { url: string; body: unknown }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return { json: async () => ({ ok: true, sessionGroups: { chat: { collapsed: true, level: 0 } } }), status: 200 }
    }))
    const r = await setMobileSessionGroup("http://pc:1/", "tok", "chat", { collapsed: true })
    expect(r).toEqual({ ok: true, sessionGroups: { chat: { collapsed: true, level: 0 } } })
    expect(calls).toEqual([{ url: "http://pc:1/api/mobile/session-group", body: { group: "chat", patch: { collapsed: true } } }])
  })

  it("旧版电脑端没有这个接口：给明确的升级提示，不是干巴巴的「未知接口」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: false, error: "未知接口" }), status: 404 })))
    const r = await setMobileSessionGroup("http://pc:1", "tok", "chat", { level: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("电脑端版本过旧")
  })

  it("电脑端自己拒绝的：原话带回", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ ok: false, error: "会话分类的参数不对" }), status: 200 })))
    expect((await setMobileSessionGroup("http://pc:1", "tok", "chat", { level: 1 })).error).toBe("会话分类的参数不对")
  })
})
