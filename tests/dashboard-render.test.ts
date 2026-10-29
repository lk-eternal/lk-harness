import { createElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Bot } from "lucide-react"
import { describe, expect, it, vi } from "vitest"
import StatusCard, { TabPane, paneDomId, tabDomId } from "../src/renderer/components/dashboard/StatusCard"
import QueuePanel, { type QueueMessageView } from "../src/renderer/components/dashboard/QueuePanel"
import SessionsArea, { ChannelBar, NoChannels, type SessionsScope } from "../src/renderer/components/sessions/SessionsArea"
import { ALL_CHANNELS } from "../src/renderer/components/sessions/sessions-view"
import type { ModelPickerSource } from "../src/renderer/components/chat/ModelPicker"
import type { DashboardChannelNode, DashboardSessionNode, SessionGroupId } from "../src/shared/dashboard-tree"
import type { ManagedSession, ManagerListResult } from "../src/shared/managed-sessions"

/**
 * 工作台改版：四张卡片是页签，下面是选中那张的功能区。
 * 这里盯卡片的页签行为（选中态、点击 / 键盘、操作按钮不触发切换）、功能区的显隐方式，
 * 以及「消息通道」「活跃会话」两个功能区用同一套清单时的预设差异。
 */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>
const isEl = (n: unknown): n is El => !!n && typeof n === "object" && "props" in (n as object)

/** 深度优先收集满足条件的元素（不需要 DOM：这几个组件都是没有 hook 的纯函数组件） */
function find(node: ReactNode, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, pred, out))
  else if (isEl(node)) {
    if (pred(node)) out.push(node)
    find(node.props.children, pred, out)
  }
  return out
}

describe("StatusCard：卡片就是页签", () => {
  const base = { tab: "channels" as const, icon: Bot, label: "消息通道", value: "6/6 通道在线", color: "green" as const, sub: "共 6 个通道" }
  const render = (over: Partial<Parameters<typeof StatusCard>[0]> = {}) =>
    StatusCard({ ...base, selected: false, onSelect: vi.fn(), ...over }) as El
  const html = (over: Partial<Parameters<typeof StatusCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(StatusCard, { ...base, selected: false, onSelect: vi.fn(), ...over }))

  it("是 role=tab，aria-selected 跟选中态走，和功能区互相指（aria-controls / id）", () => {
    const sel = render({ selected: true })
    expect(sel.props.role).toBe("tab")
    expect(sel.props["aria-selected"]).toBe(true)
    expect(sel.props["aria-controls"]).toBe(paneDomId("channels"))
    expect(sel.props.id).toBe(tabDomId("channels"))
    expect(sel.props.tabIndex).toBe(0)
    expect(sel.props["data-dash-tab"]).toBe("channels")
    expect(render({ selected: false }).props["aria-selected"]).toBe(false)
  })

  it("选中的卡片高亮，没选中的不高亮", () => {
    expect(String(render({ selected: true }).props.className)).toContain("border-blue-500/60")
    expect(String(render({ selected: false }).props.className)).not.toContain("border-blue-500/60")
  })

  it("卡片上不再有「点击展开 / 收起」这类折叠提示，副标题原样显示", () => {
    const h = html({ selected: true })
    expect(h).toContain("共 6 个通道")
    expect(h).not.toMatch(/点击|展开|收起/)
  })

  it("点击卡片选中它；再点已选中的也只是选中（不是折叠）", () => {
    const onSelect = vi.fn()
    const el = render({ selected: true, onSelect })
    ;(el.props.onClick as () => void)()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("键盘：卡片自己获得焦点时 Enter / 空格选中；别的键不响应", () => {
    const onSelect = vi.fn()
    const onKeyDown = render({ onSelect }).props.onKeyDown as (e: unknown) => void
    const self = {}
    const key = (k: string, target: unknown, currentTarget: unknown = self) => {
      const e = { key: k, target, currentTarget, preventDefault: vi.fn() }
      onKeyDown(e)
      return e
    }
    expect(key("Enter", self).preventDefault).toHaveBeenCalled()
    key(" ", self)
    expect(onSelect).toHaveBeenCalledTimes(2)
    key("a", self)
    key("Tab", self)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it("焦点在卡片里的按钮上时，回车 / 空格归按钮，不会顺带切换页签", () => {
    const onSelect = vi.fn()
    const onKeyDown = render({ onSelect }).props.onKeyDown as (e: unknown) => void
    const e = { key: "Enter", target: { inner: "button" }, currentTarget: {}, preventDefault: vi.fn() }
    onKeyDown(e)
    expect(onSelect).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it("卡片里的操作按钮（启动 / 停止 / 清空）点了只做自己的事：外面包的一层挡住冒泡", () => {
    const action = createElement("button", { title: "停止全部 Agent" }, "停止")
    const root = render({ action })
    const wrappers = find(root, (el) => el.type === "div" && el.props.children === action)
    expect(wrappers).toHaveLength(1)
    const stop = vi.fn()
    ;(wrappers[0].props.onClick as (e: unknown) => void)({ stopPropagation: stop })
    expect(stop).toHaveBeenCalledTimes(1)
    // 冒泡被挡住，意味着卡片自己的 onClick 不会因为点了按钮而触发
    const onSelect = vi.fn()
    expect(render({ action, onSelect }).props.onClick).toBe(onSelect)
  })

  it("没有副标题时占一个不换行空格（卡片高度不跳）", () => {
    expect(html({ sub: undefined })).toContain("\u00A0")
  })
})

describe("TabPane：功能区的显隐", () => {
  const pane = (selected: boolean) => TabPane({ tab: "logs", selected, children: "内容" }) as El
  const classes = (el: El) => String(el.props.className).split(/\s+/)

  it("选中的可见；没选中的用 visibility 藏起来、不挡点击", () => {
    expect(classes(pane(true))).not.toContain("invisible")
    expect(classes(pane(false))).toEqual(expect.arrayContaining(["invisible", "pointer-events-none"]))
  })

  it("藏起来不能用 display:none（会让日志的滚动位置回到顶部），也不能卸载", () => {
    const hidden = pane(false)
    expect(classes(hidden)).not.toContain("hidden")
    expect(hidden.props.children).toBe("内容")
  })

  it("是 tabpanel，和对应的卡片互相指；藏着时对读屏隐藏", () => {
    const hidden = pane(false)
    expect(hidden.props.role).toBe("tabpanel")
    expect(hidden.props.id).toBe(paneDomId("logs"))
    expect(hidden.props["aria-labelledby"]).toBe(tabDomId("logs"))
    expect(hidden.props["aria-hidden"]).toBe(true)
    expect(pane(true).props["aria-hidden"]).toBe(false)
  })

  it("所有功能区叠在同一块区域里（absolute 铺满），不是上下排开", () => {
    expect(classes(pane(true))).toEqual(expect.arrayContaining(["absolute", "inset-0"]))
  })
})

describe("QueuePanel：队列明细", () => {
  const msgs: QueueMessageView[] = [
    { index: 0, fileId: "f1", preview: "帮我查订单", status: "processing", sessionKey: "ch_a|ou_1", timestamp: Date.UTC(2026, 9, 29, 6, 0, 0) },
    { index: 1, fileId: "f2", preview: "再问一个", status: "pending", sessionKey: "ch_a|ou_1" },
    { index: 2, fileId: "f3", preview: "没挂到会话", sessionKey: "temp_zzz" },
  ]
  const meta = new Map([["ch_a|ou_1", { channelName: "二师兄", label: "张三" }]])
  const props = { messages: msgs, metaByKey: meta, labelOf: () => "私聊 📁fallback", onDelete: vi.fn() }
  const html = (over: Partial<typeof props> = {}) => renderToStaticMarkup(createElement(QueuePanel, { ...props, ...over }))

  it("标题和总条数；每条带所属通道、会话、状态和预览", () => {
    const h = html()
    expect(h).toContain("全局消息队列")
    expect(h).toContain("3 条")
    expect(h).toContain("二师兄")
    expect(h).toContain("张三")
    expect(h).toContain("处理中")
    expect(h).toContain("排队")
    expect(h).toContain("帮我查订单")
  })

  it("会话树里找不到的消息，用回退的标签；找得到的不用", () => {
    const h = html()
    expect(h).toContain("私聊 📁fallback")
    expect(h.split("私聊 📁fallback")).toHaveLength(2)
  })

  it("会话键大小写不同也能对上（和会话清单里排队计数同一个口径）", () => {
    expect(html({ messages: [{ index: 0, fileId: "f9", preview: "x", sessionKey: "CH_A|OU_1" }] })).toContain("张三")
  })

  it("空队列：写队列为空，0 条", () => {
    const h = html({ messages: [] })
    expect(h).toContain("队列为空")
    expect(h).toContain("0 条")
  })

  it("每条都有删除按钮，点了回调拿到的是那一条的 fileId", () => {
    const onDelete = vi.fn()
    const tree = QueuePanel({ ...props, onDelete }) as El
    const dels = find(tree, (el) => el.type === "button" && el.props.title === "删除此消息")
    expect(dels).toHaveLength(3)
    dels.forEach((b) => (b.props.onClick as () => void)())
    expect(onDelete.mock.calls.map((c) => c[0])).toEqual(["f1", "f2", "f3"])
  })

  it("撑满功能区高度（外壳是 flex-1），不再是 45vh 封顶", () => {
    const h = html()
    expect(h).toContain("flex min-h-0 flex-1 flex-col")
    expect(h).not.toContain("45vh")
  })
})

describe("SessionsArea：消息通道 / 活跃会话两个预设", () => {
  const picker: ModelPickerSource = { resources: [], quickModels: [], favorites: [], onToggleFavorite: vi.fn(), onOpen: vi.fn() }

  const node = (over: Partial<DashboardSessionNode> = {}): DashboardSessionNode =>
    ({ sessionKey: "ch_a|ou_me::D:/work", label: "📁 work", group: "main", running: false, queue: [], ...over })
  const channel = (id: string, name: string, g: Partial<Record<SessionGroupId, DashboardSessionNode[]>> = {}): DashboardChannelNode => {
    const all: SessionGroupId[] = ["main", "other_p2p", "group", "project", "task"]
    return {
      channelId: id,
      name,
      connected: true,
      groups: Object.fromEntries(all.map((x) => [x, { sessions: g[x] ?? [] }])) as DashboardChannelNode["groups"],
    }
  }
  const managed = (over: Partial<ManagedSession> = {}): ManagedSession => ({
    sessionKey: "ch_a|ou_1",
    channelId: "ch_a",
    channelName: "二师兄",
    chatKey: "ch_a|ou_1",
    chatType: "p2p",
    audience: "others",
    kind: "chat",
    name: "张三",
    running: false,
    queued: 0,
    model: "gpt-5",
    modelParams: "",
    resourceId: "r1",
    resourceName: "默认供应商",
    modelSource: "channel",
    resourceSource: "channel",
    defaultModel: "gpt-5",
    customized: false,
    manageable: true,
    canRestoreDefault: false,
    ...over,
  })

  const chA = channel("ch_a", "二师兄", { main: [node({ running: true })] })
  const chB = channel("ch_b", "大师兄", { project: [node({ sessionKey: "ch_b|ou_me::project_p", label: "📦 官网", group: "project" })] })
  const sessions = [
    managed({ sessionKey: "ch_a|ou_1", name: "张三", running: true, lastActiveAt: 300 }),
    managed({ sessionKey: "ch_a|ou_2", name: "李四", lastActiveAt: 200 }),
    managed({ sessionKey: "ch_b|oc_1", channelId: "ch_b", channelName: "大师兄", chatType: "group", chatKey: "ch_b|oc_1", name: "服务台群", lastActiveAt: 400 }),
  ]
  const result: ManagerListResult = { ok: true, daemonRunning: true, sessions, skipped: 0 }

  const props = (over: Record<string, unknown> = {}) => ({
    scope: "channels" as SessionsScope,
    channels: [chA, chB],
    channelId: ALL_CHANNELS,
    onSelectChannel: vi.fn(),
    managed: { result, refresh: async () => {} },
    queue: [],
    modelPicker: picker,
    confirm: async () => true,
    onNotice: vi.fn(),
    onOpenChannelSettings: vi.fn(),
    onAddFavorite: vi.fn(),
    onSwitchModel: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onActivateSession: vi.fn(),
    onDeleteQueueItem: vi.fn(),
    ...over,
  })
  const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SessionsArea, props(over)))
  const count = (h: string, needle: string) => h.split(needle).length - 1
  const rowKeys = (h: string) => [...h.matchAll(/data-session-row="([^"]*)"/g)].map((m) => m[1])

  describe("消息通道区", () => {
    it("多个通道：顶上是「全部」加每个通道的切换条，默认选中「全部」", () => {
      const h = html()
      expect(h).toContain('data-channel-tab="*"')
      expect(h).toContain('data-channel-tab="ch_a"')
      expect(h).toContain('data-channel-tab="ch_b"')
      expect(h).toMatch(/data-channel-tab="\*" aria-pressed="true"/)
      expect(h).toMatch(/data-channel-tab="ch_a" aria-pressed="false"/)
      expect(h.indexOf('data-channel-tab="*"')).toBeLessThan(h.indexOf('data-channel-tab="ch_a"'))
    })

    it("「全部」：两个通道的会话混在一张清单里，每行标所属通道", () => {
      const h = html()
      expect(new Set(rowKeys(h))).toEqual(new Set(["ch_a|ou_me::D:/work", "ch_a|ou_1", "ch_a|ou_2", "ch_b|oc_1", "ch_b|ou_me::project_p"]))
      expect(count(h, "data-session-channel")).toBe(5)
    })

    it("选了一个通道：只有它的会话，行上不再重复标通道名，「+ 常用目录」可用", () => {
      const h = html({ channelId: "ch_b" })
      expect(rowKeys(h).sort()).toEqual(["ch_b|oc_1", "ch_b|ou_me::project_p"])
      expect(count(h, "data-session-channel")).toBe(0)
      expect(h).toMatch(/data-channel-tab="ch_b" aria-pressed="true"/)
      expect(h).not.toContain("这个操作按通道做")
    })

    it("「全部」时清理和常用目录置灰（它们按通道做）", () => {
      expect(html()).toContain("这个操作按通道做，先在上方选一个通道")
    })

    it("选中的通道已经没了：当作「全部」", () => {
      const h = html({ channelId: "ch_gone" })
      expect(h).toMatch(/data-channel-tab="\*" aria-pressed="true"/)
      expect(rowKeys(h)).toHaveLength(5)
    })

    it("只有一个通道：没有切换条，不标通道名，直接就是它", () => {
      const h = html({ channels: [chA], channelId: ALL_CHANNELS })
      expect(h).not.toContain("data-channel-tab")
      expect(count(h, "data-session-channel")).toBe(0)
      expect(rowKeys(h).every((k) => k.startsWith("ch_a|"))).toBe(true)
      expect(h).not.toContain("这个操作按通道做")
    })

    it("没有通道：写「未配置消息通道」，给一个去设置的入口", () => {
      const h = html({ channels: [] })
      expect(h).toContain("未配置消息通道")
      expect(h).toContain("data-open-channel-settings")
      expect(h).toContain("去设置里添加")
      expect(h).not.toContain("data-session-row")
    })

    it("空状态里的入口按钮：点了调用去设置的回调", () => {
      const onOpen = vi.fn()
      const tree = NoChannels({ onOpenSettings: onOpen }) as El
      const btns = find(tree, (el) => el.type === "button" && el.props["data-open-channel-settings"] !== undefined)
      expect(btns).toHaveLength(1)
      ;(btns[0].props.onClick as () => void)()
      expect(onOpen).toHaveBeenCalledTimes(1)
    })

    it("点切换条上的项：回调拿到那个通道的 id（「全部」是 *），选中态跟 selected 走", () => {
      const onSelect = vi.fn()
      const tree = ChannelBar({ channels: [chA, chB], selected: "ch_a", onSelect }) as El
      const chips = find(tree, (el) => el.type === "button")
      expect(chips.map((c) => c.props["data-channel-tab"])).toEqual([ALL_CHANNELS, "ch_a", "ch_b"])
      expect(chips.map((c) => c.props["aria-pressed"])).toEqual([false, true, false])
      chips.forEach((c) => (c.props.onClick as () => void)())
      expect(onSelect.mock.calls.map((c) => c[0])).toEqual([ALL_CHANNELS, "ch_a", "ch_b"])
    })

    it("切换条上的通道带在线点：在线绿、离线灰", () => {
      const h = renderToStaticMarkup(createElement(ChannelBar, { channels: [chA, { ...chB, connected: false }], selected: ALL_CHANNELS, onSelect: vi.fn() }))
      expect(h).toContain("bg-success")
      expect(h).toContain("bg-stronger")
    })
  })

  describe("活跃会话区", () => {
    const active = (over: Record<string, unknown> = {}) => html({ scope: "active", ...over })

    it("跨通道、只留运行中的：主用户的和别人的都算，空闲的不出现", () => {
      const h = active()
      expect(rowKeys(h).sort()).toEqual(["ch_a|ou_1", "ch_a|ou_me::D:/work"])
    })

    it("没有通道切换条，也不管「消息通道」区选的是哪个通道", () => {
      expect(active()).not.toContain("data-channel-tab")
      expect(rowKeys(active({ channelId: "ch_b" })).sort()).toEqual(["ch_a|ou_1", "ch_a|ou_me::D:/work"])
    })

    it("多个通道时行上标所属通道；只有一个通道时不标", () => {
      expect(count(active(), "data-session-channel")).toBe(2)
      expect(count(active({ channels: [chA] }), "data-session-channel")).toBe(0)
    })

    it("预设是运行中：标题是「运行中的会话」，没有「运行中」标签，没有常用目录和清理", () => {
      const h = active()
      expect(h).toContain("运行中的会话")
      expect(h).not.toContain('data-session-filter="running"')
      expect(h).not.toContain("常用目录")
      expect(h).not.toContain("清理久未使用")
    })

    it("都空闲了：写「当前没有运行中的会话」", () => {
      const idle = { ok: true, daemonRunning: true, sessions: sessions.map((s) => ({ ...s, running: false })), skipped: 0 }
      const quietA = channel("ch_a", "二师兄", { main: [node({ running: false })] })
      const h = active({ managed: { result: idle, refresh: async () => {} }, channels: [quietA, chB] })
      expect(h).toContain("当前没有运行中的会话")
      expect(rowKeys(h)).toEqual([])
    })

    it("没有通道时也不是「未配置消息通道」那个空状态，而是空的运行中清单", () => {
      const h = active({ channels: [] })
      expect(h).not.toContain("未配置消息通道")
      expect(h).toContain("当前没有运行中的会话")
    })

    it("清单还没读回来：主用户的运行中会话照常显示，别人的在加载", () => {
      const h = active({ managed: { result: null, refresh: async () => {} } })
      expect(rowKeys(h)).toEqual(["ch_a|ou_me::D:/work"])
      expect(h).toContain("别人的会话正在加载")
    })
  })

  it("两个区都撑满外面给的空间（flex-1 + min-h-0），清单自己滚动", () => {
    for (const scope of ["channels", "active"] as const) {
      expect(html({ scope })).toMatch(new RegExp(`^<div class="flex min-h-0 flex-1 flex-col gap-3" data-sessions-scope="${scope}"`))
    }
  })
})
