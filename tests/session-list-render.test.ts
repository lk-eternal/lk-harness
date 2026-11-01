import { createElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import SessionList from "../src/renderer/components/sessions/SessionList"
import SessionListRow, { type SessionListRowProps } from "../src/renderer/components/sessions/SessionListRow"
import { SESSION_TYPE_LABEL, TASK_MODEL_HINT, buildAllSessionItems, buildSessionItems, type SessionItem, type SessionType } from "../src/renderer/components/sessions/sessions-view"
import type { ModelPickerSource } from "../src/renderer/components/chat/ModelPicker"
import type { DashboardChannelNode, DashboardSessionNode, SessionGroupId } from "../src/shared/dashboard-tree"
import type { ManagedSession } from "../src/shared/managed-sessions"

/**
 * 会话管理页不再分「其他人的会话 / 我的会话」页签：主用户自己的和别人的画成同一张清单、同一个行样式，
 * 靠行首图标区分是 主用户 / 私聊 / 群（/ 项目 / 任务）。这里盯住：没有页签、图标对、行样式一致、
 * 每种会话该有哪些操作，以及主用户那一套操作（激活 / 删除 / 排队消息）没有因为合并而丢。
 */

const picker: ModelPickerSource = { resources: [], quickModels: [], favorites: [], onToggleFavorite: vi.fn(), onOpen: vi.fn() }

function managed(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    sessionKey: "ch_a|ou_1",
    channelId: "ch_a",
    channelName: "飞书",
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
  }
}

function node(over: Partial<DashboardSessionNode> = {}): DashboardSessionNode {
  return { sessionKey: "ch_a|ou_me::D:/work", label: "📁 work", group: "main", running: false, queue: [], ...over }
}

function groups(g: Partial<Record<SessionGroupId, DashboardSessionNode[]>>): DashboardChannelNode["groups"] {
  const all: SessionGroupId[] = ["main", "other_p2p", "group", "project", "task"]
  return Object.fromEntries(all.map((id) => [id, { sessions: g[id] ?? [] }])) as DashboardChannelNode["groups"]
}

function items(over: {
  groups?: Partial<Record<SessionGroupId, DashboardSessionNode[]>>
  managed?: ManagedSession[]
  queue?: Parameters<typeof buildSessionItems>[0]["queue"]
}): SessionItem[] {
  return buildSessionItems({ channelId: "ch_a", groups: groups(over.groups ?? {}), managed: over.managed ?? [], queue: over.queue ?? [] })
}

function rowProps(item: SessionItem, over: Partial<SessionListRowProps> = {}): SessionListRowProps {
  return {
    item,
    now: 1_000_000,
    activityKnown: true,
    modelPicker: picker,
    busy: false,
    switching: false,
    blocked: false,
    daemonRunning: true,
    queueOpen: false,
    onToggleQueue: vi.fn(),
    onSwitchModel: vi.fn(),
    onStop: vi.fn(),
    onActivate: vi.fn(),
    onRestore: vi.fn(),
    onReset: vi.fn(),
    onDelete: vi.fn(),
    onDeleteQueueItem: vi.fn(),
    ...over,
  }
}

const rowHtml = (item: SessionItem, over: Partial<SessionListRowProps> = {}) =>
  renderToStaticMarkup(createElement(SessionListRow, rowProps(item, over)))

const count = (html: string, needle: string) => html.split(needle).length - 1

type El = ReactElement<{ title?: string; onClick?: () => void; disabled?: boolean; children?: ReactNode }>

/** 按渲染顺序收集所有带 title 的按钮（不需要 DOM：SessionListRow 是没有 hook 的纯函数组件） */
function buttons(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, out))
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as El
    if (el.type === "button") out.push(el)
    buttons(el.props.children, out)
  }
  return out
}

const rowButtons = (item: SessionItem, over: Partial<SessionListRowProps> = {}) => buttons(SessionListRow(rowProps(item, over)))
const titles = (item: SessionItem, over: Partial<SessionListRowProps> = {}) => rowButtons(item, over).map((b) => b.props.title)
const byTitle = (item: SessionItem, title: string, over: Partial<SessionListRowProps> = {}) =>
  rowButtons(item, over).find((b) => b.props.title === title)

const mineItem = (over: Partial<DashboardSessionNode> = {}, g: SessionGroupId = "main") =>
  items({ groups: { [g]: [node({ group: g, ...over })] } })[0]
const othersItem = (over: Partial<ManagedSession> = {}) => items({ managed: [managed(over)] })[0]

describe("行首图标：主用户 / 私聊 / 群 / 项目 / 任务", () => {
  const cases: [string, SessionItem, SessionType][] = [
    ["主用户自己的会话", mineItem(), "main"],
    ["项目", mineItem({ sessionKey: "ch_a|ou_me::project_abc", label: "📦 官网" }, "project"), "project"],
    ["任务 / 临时", mineItem({ sessionKey: "temp_1", label: "⏰ 日报" }, "task"), "task"],
    ["别人的私聊", othersItem({ chatType: "p2p" }), "p2p"],
    ["别人的群", othersItem({ chatType: "group", name: "客服群" }), "group"],
    ["类型未知", othersItem({ chatType: "unknown" }), "other"],
  ]

  it.each(cases)("%s 的行有对应类型的图标，悬停和读屏都说类型名", (_name, item, type) => {
    const html = rowHtml(item)
    expect(count(html, "data-session-type-icon=")).toBe(1)
    expect(html).toContain(`data-session-type-icon="${type}"`)
    expect(html).toContain(`aria-label="${SESSION_TYPE_LABEL[type]}"`)
    expect(html).toContain(`title="${SESSION_TYPE_LABEL[type]}"`)
    expect(html).toContain(`data-session-type="${type}"`)
  })

  it("每种类型的图标不一样（靠图标区分，不能是同一个样子）", () => {
    const svgs = cases.map(([, item]) => /<svg[\s\S]*?<\/svg>/.exec(rowHtml(item).split("data-session-type-icon")[1])?.[0])
    expect(svgs.every(Boolean)).toBe(true)
    expect(new Set(svgs).size).toBe(cases.length)
  })

  it("不再用文字小标签（「私聊」「群」）当类型标记", () => {
    const html = rowHtml(othersItem({ chatType: "group", name: "客服群" }))
    expect(html).not.toContain(">群<")
    expect(html).not.toContain(">私聊<")
  })
})

describe("主用户的会话和别人的会话是同一个行样式", () => {
  it("行容器和行内布局的样式一致，只有主用户当前会话多一层高亮", () => {
    const layout = (html: string) => /class="(flex flex-wrap items-center gap-1\.5 px-3 py-2 text-xs)"/.exec(html)?.[1]
    expect(layout(rowHtml(mineItem()))).toBe("flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs")
    expect(layout(rowHtml(othersItem()))).toBe("flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs")
    const wrapper = (html: string) => /data-session-row="[^"]*" data-session-owner="[a-z]+" data-session-type="[a-z0-9]+" class="([^"]*)"/.exec(html)?.[1]
    expect(wrapper(rowHtml(mineItem()))).toBe(wrapper(rowHtml(othersItem())))
  })

  it("两种行都没有展开箭头、都有运行点、最近对话、模型选择器", () => {
    for (const item of [mineItem(), othersItem()]) {
      const html = rowHtml(item)
      expect(html).not.toContain('title="展开"')
      // 模型选择器自己有个向下的小箭头，这里盯的是旧行首的「展开」箭头
      expect(html).not.toContain("lucide-chevron-right")
      expect(html).toContain('title="空闲"')
      expect(html).toContain('title="最近一次对话"')
    }
  })

  it("主用户当前会话：整行高亮、名字用强调色；别的行不高亮", () => {
    const current = rowHtml(mineItem({ current: true }))
    expect(current).toContain("bg-accent-tint/20")
    expect(current).toContain("text-accent-bright")
    expect(rowHtml(mineItem({ current: false }))).not.toContain("bg-accent-tint/20")
    expect(rowHtml(othersItem())).not.toContain("bg-accent-tint/20")
  })

  it("运行中的会话绿点，空闲灰点", () => {
    expect(rowHtml(mineItem({ running: true }))).toContain('title="运行中"')
    expect(rowHtml(othersItem({ running: true }))).toContain('title="运行中"')
  })

  it("别人的私聊带「最后一句话」预览", () => {
    expect(rowHtml(othersItem({ preview: "帮我查下订单" }))).toContain("帮我查下订单")
  })
})

describe("每种会话有哪些操作", () => {
  it("主用户的空闲会话：激活；有 removable 才有删除；没有重置和恢复默认", () => {
    expect(titles(mineItem({ removable: true }))).toEqual(["切到此会话（只改路由，不拉起）", "删除会话"])
    expect(titles(mineItem({ removable: false }))).toEqual(["切到此会话（只改路由，不拉起）"])
  })

  it("主用户的当前会话不再有「激活」；运行中的有「停止」，没有「激活」", () => {
    expect(titles(mineItem({ current: true, removable: true }))).toEqual(["删除会话"])
    expect(titles(mineItem({ running: true, removable: true }))).toEqual(["停止会话", "删除会话"])
  })

  it("项目：删除按钮的说明写明会连带移除 AI 工作目录", () => {
    const project = mineItem({ sessionKey: "ch_a|ou_me::project_abc", label: "📦 官网", removable: true }, "project")
    expect(titles(project)).toContain("删除项目（连带移除 AI 工作目录）")
  })

  it("别人的会话：重置 + 删除；运行中多「停止」；只改了模型才有「恢复默认」；没有「激活」", () => {
    expect(titles(othersItem())).toEqual(["重置：清空上下文，会话和设置保留", "删除会话"])
    expect(titles(othersItem({ running: true }))).toEqual(["停止会话", "重置：清空上下文，会话和设置保留", "删除会话"])
    expect(titles(othersItem({ canRestoreDefault: true }))).toContain("恢复为通道默认模型")
    expect(titles(othersItem())).not.toContain("切到此会话（只改路由，不拉起）")
  })

  it("别人的会话：服务没在跑时删除置灰并说明原因，重置不受影响；主用户的删除不受服务状态影响", () => {
    const del = byTitle(othersItem(), "服务未运行，无法清理路由，请先启动服务", { daemonRunning: false })
    expect(del?.props.disabled).toBe(true)
    const reset = byTitle(othersItem(), "重置：清空上下文，会话和设置保留", { daemonRunning: false })
    expect(reset?.props.disabled).toBe(false)
    const mineDel = byTitle(mineItem({ removable: true }), "删除会话", { daemonRunning: false })
    expect(mineDel?.props.disabled).toBe(false)
  })

  it("别的行正在被操作时，这一行的按钮都点不了", () => {
    const item = othersItem({ running: true, canRestoreDefault: true })
    expect(rowButtons(item, { blocked: true }).every((b) => b.props.disabled === true)).toBe(true)
    expect(rowButtons(item, { blocked: false }).some((b) => b.props.disabled === true)).toBe(false)
  })

  it("每个按钮点下去触发的是自己那一项的回调", () => {
    const p = rowProps(mineItem({ removable: true, running: false }))
    const found = (t: string) => buttons(SessionListRow(p)).find((b) => b.props.title === t)
    found("切到此会话（只改路由，不拉起）")?.props.onClick?.()
    found("删除会话")?.props.onClick?.()
    expect(p.onActivate).toHaveBeenCalledTimes(1)
    expect(p.onDelete).toHaveBeenCalledTimes(1)
    expect(p.onStop).not.toHaveBeenCalled()

    const o = rowProps(othersItem({ running: true, canRestoreDefault: true }))
    const foundO = (t: string) => buttons(SessionListRow(o)).find((b) => b.props.title === t)
    foundO("停止会话")?.props.onClick?.()
    foundO("恢复为通道默认模型")?.props.onClick?.()
    foundO("重置：清空上下文，会话和设置保留")?.props.onClick?.()
    foundO("删除会话")?.props.onClick?.()
    expect(o.onStop).toHaveBeenCalledTimes(1)
    expect(o.onRestore).toHaveBeenCalledTimes(1)
    expect(o.onReset).toHaveBeenCalledTimes(1)
    expect(o.onDelete).toHaveBeenCalledTimes(1)
  })
})

describe("排队消息（主用户的和别人的会话都能展开看、删）", () => {
  const queue = [
    { sessionKey: "ch_a|ou_me::D:/work", fileId: "f1", preview: "第一条", status: "processing" as const },
    { sessionKey: "ch_a|ou_me::D:/work", fileId: "f2", preview: "第二条", status: "pending" as const },
    { sessionKey: "ch_a|ou_1", fileId: "f3", preview: "别人的一条" },
  ]
  const [mine, other] = [
    items({ groups: { main: [node()] }, queue })[0],
    items({ managed: [managed()], queue })[0],
  ]

  it("有排队才出现徽标，处理中和排队分开数；没有排队就没有徽标", () => {
    const html = rowHtml(mine)
    expect(html).toContain("处理中 1")
    expect(html).toContain("排队 1")
    expect(rowHtml(other)).toContain("排队 1")
    expect(rowHtml(other)).not.toContain("处理中")
    expect(rowHtml(mineItem())).not.toContain("排队")
  })

  it("没展开时不显示消息内容；展开后列出每条，带删除按钮", () => {
    expect(rowHtml(mine)).not.toContain("第一条")
    expect(rowHtml(mine)).not.toContain("data-queue-panel")
    const open = rowHtml(mine, { queueOpen: true })
    expect(open).toContain("data-queue-panel")
    expect(open).toContain("第一条")
    expect(open).toContain("第二条")
    expect(count(open, 'title="删除这条排队的消息"')).toBe(2)
  })

  it("徽标是展开 / 收起的开关；删除按钮带的是那一条的 fileId", () => {
    const p = rowProps(mine, { queueOpen: true })
    const all = buttons(SessionListRow(p))
    all.find((b) => b.props.title === "收起排队的消息")?.props.onClick?.()
    expect(p.onToggleQueue).toHaveBeenCalledTimes(1)
    all.filter((b) => b.props.title === "删除这条排队的消息").forEach((b) => b.props.onClick?.())
    expect((p.onDeleteQueueItem as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["f1", "f2"])
    expect(titles(mine)).toContain("展开看排队的消息，可以删除")
  })

  it("展开着但排队已经被删空：面板不再显示", () => {
    expect(rowHtml(mineItem(), { queueOpen: true })).not.toContain("data-queue-panel")
  })
})

describe("最近对话时间", () => {
  it("清单还没加载过时不显示「无记录」（主用户会话的时间要等清单），加载过没记录才显示", () => {
    const item = mineItem()
    expect(rowHtml(item, { activityKnown: false })).not.toContain("无记录")
    expect(rowHtml(item, { activityKnown: true })).toContain("无记录")
  })
})

describe("SessionList：一张清单，没有页签", () => {
  const all = items({
    groups: { main: [node({ current: true, removable: true })], project: [node({ sessionKey: "ch_a|ou_me::project_abc", label: "📦 官网", removable: true, group: "project" })] },
    managed: [
      managed({ sessionKey: "ch_a|ou_2", name: "张三", chatType: "p2p", lastActiveAt: 900_000 }),
      managed({ sessionKey: "ch_a|oc_1", name: "客服群", chatType: "group", chatKey: "ch_a|oc_1", lastActiveAt: 800_000 }),
    ],
  })
  const listProps = (over: Record<string, unknown> = {}) => ({
    channelId: "ch_a",
    channelName: "飞书",
    items: all,
    loaded: true,
    daemonRunning: true,
    skipped: 0,
    modelPicker: picker,
    refresh: async () => {},
    onNotice: vi.fn(),
    confirm: async () => true,
    onAddFavorite: vi.fn(),
    onSwitchModel: vi.fn(),
    onStopSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onActivateSession: vi.fn(),
    onDeleteQueueItem: vi.fn(),
    ...over,
  })
  const html = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SessionList, listProps(over)))

  it("主用户的、项目、别人的私聊和群都在同一个清单里", () => {
    const h = html()
    expect(count(h, "data-session-row=")).toBe(4)
    for (const type of ["main", "project", "p2p", "group"]) expect(h).toContain(`data-session-type="${type}"`)
    expect(h).toContain("4 个")
  })

  it("没有「其他人的会话 / 我的会话」页签", () => {
    const h = html()
    expect(h).not.toContain("其他人的会话")
    expect(h).not.toContain("我的会话")
    expect(h).not.toContain("data-session-tab")
  })

  it("筛选标签：全部 / 主用户 / 私聊 / 群 / 项目 / 运行中，类型标签带图标和个数", () => {
    const h = html()
    for (const id of ["all", "main", "p2p", "group", "project", "running"]) expect(h).toContain(`data-session-filter="${id}"`)
    expect(h).not.toContain('data-session-filter="task"')
    expect(h).not.toContain('data-session-filter="other"')
    const chipFor = (id: string) => new RegExp(`data-session-filter="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(h)?.[1] ?? ""
    expect(chipFor("group")).toContain("<svg")
    expect(chipFor("group")).toContain("群")
    expect(chipFor("all")).not.toContain("<svg")
  })

  it("「+ 常用目录」和「清理久未使用」都在工具栏里，清理按钮的说明写明只清别人的", () => {
    const h = html()
    expect(h).toContain("常用目录")
    expect(h).toContain("清理久未使用")
    expect(h).toContain("只清别人的")
  })

  it("没有别人的会话时清理按钮置灰；清单没加载过时也置灰", () => {
    const onlyMine = items({ groups: { main: [node()] } })
    const disabledClean = (h: string) => /<button[^>]*disabled=""[^>]*title="按天数批量清理[^"]*"/.test(h) || /<button[^>]*title="按天数批量清理[^"]*"[^>]*disabled=""/.test(h)
    expect(disabledClean(html({ items: onlyMine }))).toBe(true)
    expect(disabledClean(html({ loaded: false }))).toBe(true)
    expect(disabledClean(html())).toBe(false)
  })

  it("清单没加载完时主用户的会话照常显示，并提示别人的会话在加载 / 加载失败", () => {
    const onlyMine = items({ groups: { main: [node()] } })
    const loading = html({ items: onlyMine, loaded: false })
    expect(loading).toContain("data-session-row=")
    expect(loading).toContain("别人的会话正在加载")
    expect(html({ items: onlyMine, loaded: false, loadError: "读取失败" })).toContain("别人的会话加载失败")
  })

  it("什么会话都没有：加载中 / 加载失败 / 加载完都有各自的空状态", () => {
    expect(html({ items: [], loaded: false })).toContain("正在加载")
    expect(html({ items: [], loaded: false, loadError: "x" })).toContain("会话清单加载失败")
    expect(html({ items: [], loaded: true })).toContain("还没有会话")
  })

  it("还有找不到所属通道的会话时在底部说明", () => {
    expect(html({ skipped: 3 })).toContain("另有 3 个会话找不到所属通道")
    expect(html({ skipped: 0 })).not.toContain("找不到所属通道")
  })

  describe("没选定通道（「全部」通道）时", () => {
    const noChannel = () => html({ channelId: undefined, channelName: undefined })
    const hint = "这个操作按通道做，先在上方选一个通道"
    const btn = (h: string, label: string) => new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`).exec(h)?.[0] ?? ""

    it("「+ 常用目录」和「清理久未使用」都点不了，悬停说明原因", () => {
      const h = noChannel()
      expect(btn(h, "常用目录")).toContain('disabled=""')
      expect(btn(h, "常用目录")).toContain(`title="${hint}"`)
      expect(btn(h, "清理久未使用")).toContain('disabled=""')
      expect(btn(h, "清理久未使用")).toContain(`title="${hint}"`)
    })

    it("选定了通道就都能点（清理要有别人的会话、清单加载过）", () => {
      const h = html()
      expect(btn(h, "常用目录")).not.toContain('disabled=""')
      expect(btn(h, "清理久未使用")).not.toContain('disabled=""')
      expect(h).not.toContain(hint)
    })

    it("空清单的提示不写「这个通道」", () => {
      expect(html({ channelId: undefined, items: [], loaded: true })).toContain("还没有会话")
      expect(html({ channelId: undefined, items: [], loaded: true })).not.toContain("这个通道")
      expect(html({ items: [], loaded: true })).toContain("这个通道还没有会话")
    })
  })

  describe("活跃会话预设（mode=active）", () => {
    const running = items({
      groups: { main: [node({ running: true })] },
      managed: [managed({ sessionKey: "ch_a|ou_2", name: "张三", running: true })],
    })
    const activeHtml = (over: Record<string, unknown> = {}) =>
      html({ mode: "active", channelId: undefined, channelName: undefined, items: running, ...over })

    it("清单标题是「运行中的会话」，没有按通道做的两个按钮", () => {
      const h = activeHtml()
      expect(h).toContain("运行中的会话")
      expect(h).not.toContain("常用目录")
      expect(h).not.toContain("清理久未使用")
    })

    it("筛选标签没有「运行中」（清单本来就都是运行中的），类型标签还在", () => {
      const h = activeHtml()
      expect(h).not.toContain('data-session-filter="running"')
      for (const id of ["all", "main", "p2p"]) expect(h).toContain(`data-session-filter="${id}"`)
    })

    it("一个会话都没有：说「当前没有运行中的会话」；清单还没加载时仍是「正在加载」", () => {
      expect(activeHtml({ items: [], loaded: true })).toContain("当前没有运行中的会话")
      expect(activeHtml({ items: [], loaded: true })).not.toContain("还没有会话")
      expect(activeHtml({ items: [], loaded: false })).toContain("正在加载")
    })

    it("底部「找不到所属通道」的说明不在这里出现（那是会话管理的事）", () => {
      expect(activeHtml({ skipped: 3 })).not.toContain("找不到所属通道")
    })

    it("通道管理预设里标题是「会话」，仍有「运行中」标签", () => {
      const h = html()
      expect(h).toContain("<span>会话</span>")
      expect(h).toContain('data-session-filter="running"')
    })
  })

  it("showChannel：每一行都标出所属通道；不开就不标", () => {
    const multi = buildAllSessionItems({
      channels: [
        { channelId: "ch_a", name: "二师兄", groups: groups({ main: [node()] }) },
        { channelId: "ch_b", name: "大师兄", groups: groups({}) },
      ],
      managed: [managed({ sessionKey: "ch_b|oc_1", channelId: "ch_b", chatType: "group", name: "客服群" })],
      queue: [],
    })
    const withBadge = html({ items: multi, showChannel: true })
    expect(count(withBadge, "data-session-channel")).toBe(2)
    expect(withBadge).toContain(">二师兄<")
    expect(withBadge).toContain(">大师兄<")
    expect(count(html({ items: multi }), "data-session-channel")).toBe(0)
  })

  it("清单撑满外面给的高度、自己滚动（搜索栏固定在上面）", () => {
    const h = html()
    expect(h).toMatch(/^<div class="flex min-h-0 flex-1 flex-col gap-3"/)
    expect(h).toContain("data-session-scroll")
    expect(/data-session-scroll[^>]*class="[^"]*overflow-y-auto/.test(h) || /class="[^"]*overflow-y-auto[^"]*"[^>]*data-session-scroll/.test(h)).toBe(true)
  })
})

describe("行右边三栏固定宽度：每行操作个数不同，模型下拉也要对齐", () => {
  const slotsOf = (item: SessionItem) => {
    const h = rowHtml(item)
    const actions = /data-session-col="actions"[^>]*>([\s\S]*?)<\/div>/.exec(h)?.[1] ?? ""
    return actions.split("</span>").filter((s) => s.includes("inline-flex w-6 shrink-0 justify-center")).map((s) => s.includes("<button"))
  }

  it("操作区永远是 4 格（停止 / 恢复默认 / 重置 / 删除），这一行没有的操作那一格留空", () => {
    expect(slotsOf(mineItem({ removable: true }))).toEqual([false, false, false, true])
    expect(slotsOf(mineItem({ running: true, removable: true }))).toEqual([true, false, false, true])
    expect(slotsOf(othersItem())).toEqual([false, false, true, true])
    expect(slotsOf(othersItem({ running: true, canRestoreDefault: true }))).toEqual([true, true, true, true])
  })

  it("各行的位置一致：按钮在同一格里，不会因为前面少一个按钮就左移", () => {
    const pos = (item: SessionItem, title: string) => {
      const cells = (/data-session-col="actions"[^>]*>([\s\S]*?)<\/div>/.exec(rowHtml(item))?.[1] ?? "").split("</span>")
      return cells.findIndex((c) => c.includes(`title="${title}"`))
    }
    expect(pos(mineItem({ removable: true }), "删除会话")).toBe(3)
    expect(pos(othersItem(), "删除会话")).toBe(3)
    expect(pos(othersItem({ running: true }), "删除会话")).toBe(3)
    expect(pos(othersItem(), "重置：清空上下文，会话和设置保留")).toBe(2)
    expect(pos(othersItem({ canRestoreDefault: true }), "恢复为通道默认模型")).toBe(1)
    expect(pos(othersItem({ running: true }), "停止会话")).toBe(0)
    expect(pos(mineItem({ running: true }), "停止会话")).toBe(0)
  })

  it("时间和模型下拉也是固定宽度的列（靠右对齐）", () => {
    const h = rowHtml(othersItem())
    expect(h).toMatch(/class="ml-auto w-16 shrink-0 text-right[^"]*" title="最近一次对话"/)
    expect(h).toMatch(/data-session-col="model" class="flex w-40 shrink-0 justify-end"/)
  })
})

// 任务的模型归任务设置管：拉起时任务自己配的优先于会话里存的，每次触发入队 daemon 还会按任务重新登记，
// 在行上换了既不生效、下次触发还会被改回去。所以任务行的模型下拉只读，悬停说明去哪里改；别的行不受影响
describe("定时任务行的模型是只读的", () => {
  /** 模型列里那个下拉按钮的开标签（ModelPicker 的根 div 后面第一个 button） */
  const modelButton = (item: SessionItem, over: Partial<SessionListRowProps> = {}) =>
    /data-session-col="model"[^>]*>\s*<div[^>]*>\s*(<button[^>]*>)/.exec(rowHtml(item, over))?.[1] ?? ""
  const taskItem = (over: Partial<DashboardSessionNode> = {}) =>
    mineItem({ sessionKey: "temp_1", label: "⏰ 日报", model: "gpt-5", resourceId: "r1", ...over }, "task")

  it("任务行：下拉按钮禁用，悬停说明模型在设置里改", () => {
    const btn = modelButton(taskItem())
    expect(btn).toContain("<button")
    expect(btn).toMatch(/\sdisabled(=""|\s|>)/)
    expect(btn).toContain(TASK_MODEL_HINT)
    // 说明要真的告诉人去哪里改，而不是只说「不可用」
    expect(TASK_MODEL_HINT).toMatch(/设置.*定时任务/)
  })

  it("任务行运行中、行上别的操作正在进行时也一样是禁用的", () => {
    expect(modelButton(taskItem({ running: true }))).toMatch(/\sdisabled(=""|\s|>)/)
    expect(modelButton(taskItem(), { blocked: false, switching: false, busy: true })).toMatch(/\sdisabled(=""|\s|>)/)
  })

  it("主用户的普通会话、项目、别人的私聊和群：下拉可用，没有这句说明", () => {
    const others = [othersItem({ chatType: "p2p" }), othersItem({ chatType: "group", name: "客服群" })]
    const mine = [mineItem(), mineItem({ sessionKey: "ch_a|ou_me::project_abc", label: "📦 官网" }, "project")]
    for (const item of [...mine, ...others]) {
      const btn = modelButton(item)
      expect(btn, item.sessionKey).toContain("<button")
      expect(btn, item.sessionKey).not.toMatch(/\sdisabled(=""|\s|>)/)
      expect(btn, item.sessionKey).not.toContain(TASK_MODEL_HINT)
    }
  })

  it("原来的禁用条件还在：别的行正在被操作时，别人的会话的下拉照样禁用", () => {
    expect(modelButton(othersItem(), { blocked: true, busy: false })).toMatch(/\sdisabled(=""|\s|>)/)
    expect(modelButton(othersItem(), { blocked: true, busy: true })).not.toMatch(/\sdisabled(=""|\s|>)/)
  })
})

describe("行上标所属通道（清单里混着多个通道时）", () => {
  const item = buildSessionItems({ channelId: "ch_a", channelName: "二师兄", groups: groups({}), managed: [managed()], queue: [] })[0]

  it("showChannel 开着：在类型图标后面、名字前面标通道名", () => {
    const h = rowHtml(item, { showChannel: true })
    expect(h).toContain("data-session-channel")
    expect(h).toContain('title="所属通道"')
    expect(h.indexOf("data-session-type-icon")).toBeLessThan(h.indexOf("data-session-channel"))
    expect(h.indexOf("data-session-channel")).toBeLessThan(h.indexOf("张三"))
    expect(h).toContain(">二师兄<")
  })

  it("默认不标；通道名是空的也不标（不渲染一个空标签）", () => {
    expect(rowHtml(item)).not.toContain("data-session-channel")
    expect(rowHtml({ ...item, channelName: "" }, { showChannel: true })).not.toContain("data-session-channel")
  })
})
