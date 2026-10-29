import { describe, expect, it } from "vitest"
import { DEFAULT_CLEANUP_DAYS, normalizeCleanupDays, type CleanupPlan, type ManagedSession } from "../src/shared/managed-sessions"
import type { DashboardChannelNode, DashboardSessionNode, SessionGroupId } from "../src/shared/dashboard-tree"
import {
  CLEANUP_DEFAULT_DAYS,
  MY_GROUP_IDS,
  buildSessionItems,
  channelRunningCount,
  cleanupResultText,
  cleanupSummary,
  deleteConfirmText,
  filterChips,
  filterSessionItems,
  lastActiveText,
  othersOf,
  othersType,
  overrideBadge,
  parseCleanupDays,
  queueCounts,
  resetConfirmText,
  resolveFilter,
  restoreConfirmText,
  rowCapabilities,
  sortCleanupCandidates,
  type SessionItem,
} from "../src/renderer/components/sessions/sessions-view"

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    sessionKey: "ch_a|ou_1::D:/work",
    channelId: "ch_a",
    channelName: "飞书",
    chatKey: "ch_a|ou_1",
    chatType: "p2p",
    audience: "others",
    kind: "workspace",
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
  return { sessionKey: "k", label: "k", group: "main", running: false, queue: [], ...over }
}

function channelNode(groups: Partial<Record<SessionGroupId, DashboardSessionNode[]>>): Pick<DashboardChannelNode, "groups"> {
  const all: SessionGroupId[] = ["main", "other_p2p", "group", "project", "task"]
  return { groups: Object.fromEntries(all.map((g) => [g, { sessions: groups[g] ?? [] }])) as DashboardChannelNode["groups"] }
}

describe("MY_GROUP_IDS", () => {
  it("只有主用户自己的三类；私聊他人和群来自会话清单，不从会话树取（树里只有运行中的）", () => {
    expect([...MY_GROUP_IDS]).toEqual(["main", "project", "task"])
  })
})

describe("channelRunningCount", () => {
  it("所有分组里运行中的合计，空闲的不算", () => {
    const ch = channelNode({
      main: [node({ sessionKey: "a", running: true }), node({ sessionKey: "b" })],
      other_p2p: [node({ sessionKey: "c", running: true })],
      group: [node({ sessionKey: "d", running: true })],
      project: [node({ sessionKey: "e", running: true })],
      task: [node({ sessionKey: "f", running: true })],
    })
    expect(channelRunningCount(ch)).toBe(5)
  })

  it("没有会话时为 0", () => {
    expect(channelRunningCount(channelNode({}))).toBe(0)
  })
})

describe("othersOf", () => {
  it("只留这个通道里其他人的会话", () => {
    const list = [
      session({ sessionKey: "a" }),
      session({ sessionKey: "b", channelId: "ch_b" }),
      session({ sessionKey: "c", audience: "main" }),
    ]
    expect(othersOf(list, "ch_a").map((s) => s.sessionKey)).toEqual(["a"])
  })
})

const keyOf = (r: readonly { sessionKey: string }[]) => r.map((s) => s.sessionKey)

function build(over: {
  groups?: Partial<Record<SessionGroupId, DashboardSessionNode[]>>
  managed?: ManagedSession[]
  queue?: Parameters<typeof buildSessionItems>[0]["queue"]
  channelId?: string
} = {}): SessionItem[] {
  return buildSessionItems({
    channelId: over.channelId ?? "ch_a",
    groups: channelNode(over.groups ?? {}).groups,
    managed: over.managed ?? [],
    queue: over.queue ?? [],
  })
}

describe("othersType", () => {
  it("私聊 / 群 / 路由表里没登记类型的是「类型未知」", () => {
    expect(othersType({ chatType: "p2p" })).toBe("p2p")
    expect(othersType({ chatType: "group" })).toBe("group")
    expect(othersType({ chatType: "unknown" })).toBe("other")
  })
})

describe("buildSessionItems", () => {
  const mainNode = node({ sessionKey: "ch_a|ou_me::D:/work", label: "📁 work", group: "main", running: true, current: true, removable: false, model: "gpt-5", resourceId: "r1" })
  const projectNode = node({ sessionKey: "ch_a|ou_me::project_abc", label: "📦 官网", group: "project", removable: true })
  const taskNode = node({ sessionKey: "temp_1", label: "⏰ 日报", group: "task" })

  it("主用户自己的 / 项目 / 任务，和别人的私聊 / 群，合成一张清单，类型对得上", () => {
    const items = build({
      groups: { main: [mainNode], project: [projectNode], task: [taskNode] },
      managed: [
        session({ sessionKey: "ch_a|ou_2", chatType: "p2p", name: "张三" }),
        session({ sessionKey: "ch_a|oc_g1", chatType: "group", name: "客服群" }),
        session({ sessionKey: "ch_a|ou_3", chatType: "unknown", name: "私聊 9f3a" }),
      ],
    })
    const typeOf = Object.fromEntries(items.map((i) => [i.sessionKey, i.type]))
    expect(typeOf).toEqual({
      "ch_a|ou_me::D:/work": "main",
      "ch_a|ou_me::project_abc": "project",
      temp_1: "task",
      "ch_a|ou_2": "p2p",
      "ch_a|oc_g1": "group",
      "ch_a|ou_3": "other",
    })
    expect(items.filter((i) => i.owner === "mine")).toHaveLength(3)
    expect(items.filter((i) => i.owner === "others")).toHaveLength(3)
  })

  it("会话树里私聊他人 / 群的分组不用（那里只有运行中的），别人的会话只认会话清单", () => {
    const items = build({
      groups: {
        other_p2p: [node({ sessionKey: "ch_a|ou_2", group: "other_p2p", running: true })],
        group: [node({ sessionKey: "ch_a|oc_g1", group: "group", running: true })],
      },
    })
    expect(items).toEqual([])
  })

  it("会话清单里主用户自己的会话不单独成行（主用户的以会话树为准），只借它的最近活动时间", () => {
    const items = build({
      groups: { main: [mainNode] },
      managed: [session({ sessionKey: "ch_a|ou_me::D:/work", audience: "main", manageable: false, lastActiveAt: 777 })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].owner).toBe("mine")
    expect(items[0].lastActiveAt).toBe(777)
  })

  it("主用户会话的最近活动按会话键取，大小写和斜杠写法不同也对得上", () => {
    const items = build({
      groups: { main: [node({ sessionKey: "ch_a|ou_me::D:\\Work", group: "main" })] },
      managed: [session({ sessionKey: "ch_a|ou_me::d:/work", audience: "main", lastActiveAt: 123 })],
    })
    expect(items[0].lastActiveAt).toBe(123)
  })

  it("会话清单里没有的主用户会话（还没用过的常用目录）也在，没有活动时间", () => {
    const items = build({ groups: { main: [node({ sessionKey: "ch_a|ou_me::D:/new", group: "main" })] } })
    expect(items).toHaveLength(1)
    expect(items[0].lastActiveAt).toBeUndefined()
  })

  it("两边都认成同一个会话时只留一行，以会话树为准", () => {
    const items = build({
      groups: { main: [mainNode] },
      managed: [session({ sessionKey: "ch_a|ou_me::D:/WORK", audience: "others" })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].owner).toBe("mine")
  })

  it("别的通道的会话不进来", () => {
    const items = build({
      managed: [session({ sessionKey: "ch_b|ou_9", channelId: "ch_b" }), session({ sessionKey: "ch_a|ou_1" })],
    })
    expect(keyOf(items)).toEqual(["ch_a|ou_1"])
  })

  it("按最近对话排：新的在前，没有记录的在最后，时间相同按会话键，不因刷新乱跳", () => {
    const items = build({
      groups: { main: [node({ sessionKey: "ch_a|ou_me", group: "main" })] },
      managed: [
        session({ sessionKey: "ch_a|b", lastActiveAt: 100 }),
        session({ sessionKey: "ch_a|a", lastActiveAt: 100 }),
        session({ sessionKey: "ch_a|new", lastActiveAt: 900 }),
        session({ sessionKey: "ch_a|none", lastActiveAt: undefined }),
        session({ sessionKey: "ch_a|zero", lastActiveAt: 0 }),
      ],
    })
    // 没有记录的两个（主用户的和别人的）也按会话键排在最后
    expect(keyOf(items)).toEqual(["ch_a|new", "ch_a|a", "ch_a|b", "ch_a|zero", "ch_a|none", "ch_a|ou_me"])
  })

  it("主用户会话的活动时间也参与排序：用得多的主用户会话排到别人的前面", () => {
    const items = build({
      groups: { main: [node({ sessionKey: "ch_a|ou_me", group: "main" })] },
      managed: [
        session({ sessionKey: "ch_a|ou_me", audience: "main", lastActiveAt: 500 }),
        session({ sessionKey: "ch_a|ou_2", lastActiveAt: 100 }),
      ],
    })
    expect(keyOf(items)).toEqual(["ch_a|ou_me", "ch_a|ou_2"])
  })

  it("排队消息按会话键归到各自的行上（主用户的和别人的都有），键写法不同也对得上，没有会话键的丢掉", () => {
    const items = build({
      groups: { main: [node({ sessionKey: "ch_a|ou_me::D:/work", group: "main" })] },
      managed: [session({ sessionKey: "ch_a|ou_2" })],
      queue: [
        { sessionKey: "ch_a|ou_me::d:\\WORK", fileId: "f1", preview: "p1", status: "processing" },
        { sessionKey: "ch_a|ou_2", fileId: "f2", preview: "p2" },
        { sessionKey: "ch_a|ou_2", fileId: "f3", preview: "p3", status: "pending" },
        { fileId: "f4", preview: "没有会话键" },
      ],
    })
    const q = Object.fromEntries(items.map((i) => [i.sessionKey, i.queue.map((x) => x.fileId)]))
    expect(q).toEqual({ "ch_a|ou_me::D:/work": ["f1"], "ch_a|ou_2": ["f2", "f3"] })
  })

  it("主用户会话：当前会话、模型、供应商、目录（会话树没给就从会话键里取）", () => {
    const [main] = build({ groups: { main: [mainNode, node({ sessionKey: "ch_a|ou_me::D:/other", group: "main" })] } })
      .filter((i) => i.sessionKey === mainNode.sessionKey)
    expect(main.owner === "mine" && main.current).toBe(true)
    expect(main.model).toBe("gpt-5")
    expect(main.resourceId).toBe("r1")
    expect(main.running).toBe(true)
    const other = build({ groups: { main: [node({ sessionKey: "ch_a|ou_me::D:/other", group: "main" })] } })[0]
    expect(other.workspaceDir).toBe("D:/other")
    expect(other.owner === "mine" && other.current).toBe(false)
  })

  it("别人的会话：带上清单里的模型、预览、最近活动", () => {
    const [it0] = build({
      managed: [session({ sessionKey: "ch_a|ou_2", model: "claude-x", modelParams: "high", resourceId: "r9", preview: "你好", lastActiveAt: 42 })],
    })
    expect(it0.owner).toBe("others")
    expect(it0).toMatchObject({ model: "claude-x", modelParams: "high", resourceId: "r9", preview: "你好", lastActiveAt: 42 })
  })
})

describe("filterChips / resolveFilter", () => {
  const items = build({
    groups: { main: [node({ sessionKey: "ch_a|ou_me", group: "main", running: true })] },
    managed: [
      session({ sessionKey: "ch_a|ou_2", chatType: "p2p" }),
      session({ sessionKey: "ch_a|oc_1", chatType: "group", running: true }),
      session({ sessionKey: "ch_a|oc_2", chatType: "group" }),
      session({ sessionKey: "ch_a|ou_x", chatType: "unknown" }),
    ],
  })

  it("全部、有会话的各类型（带个数，顺序固定）、运行中；没有的类型不出标签，类型未知的只在「全部」里", () => {
    expect(filterChips(items).map((c) => [c.id, c.count])).toEqual([
      ["all", 5],
      ["main", 1],
      ["p2p", 1],
      ["group", 2],
      ["running", 2],
    ])
  })

  it("有项目 / 任务时才多出对应标签", () => {
    const more = build({
      groups: { project: [node({ sessionKey: "ch_a|ou_me::project_a", group: "project" })], task: [node({ sessionKey: "temp_1", group: "task" })] },
    })
    expect(filterChips(more).map((c) => c.id)).toEqual(["all", "project", "task", "running"])
  })

  it("没有会话时只有「全部」和「运行中」，个数都是 0", () => {
    expect(filterChips([])).toEqual([
      { id: "all", label: "全部", count: 0 },
      { id: "running", label: "运行中", count: 0 },
    ])
  })

  it("选中的筛选没有标签了就回到「全部」", () => {
    const chips = filterChips(items)
    expect(resolveFilter("group", chips)).toBe("group")
    expect(resolveFilter("running", chips)).toBe("running")
    expect(resolveFilter("project", chips)).toBe("all")
    expect(resolveFilter("other", chips)).toBe("all")
  })
})

describe("filterSessionItems", () => {
  const list = build({
    groups: {
      main: [node({ sessionKey: "ch_a|ou_me::D:/work", label: "📁 work", group: "main", running: true })],
      project: [node({ sessionKey: "ch_a|ou_me::project_abc", label: "📦 官网", group: "project" })],
    },
    managed: [
      session({ sessionKey: "k1", chatKey: "ch_a|ou_1", name: "张三", chatType: "p2p", preview: "帮我查下订单", running: true, lastActiveAt: 5 }),
      session({ sessionKey: "k2", name: "客服群 0042", chatType: "group", chatKey: "ch_a|oc_group42", workspaceDir: "D:/svc", lastActiveAt: 4 }),
      session({ sessionKey: "k3", name: "私聊 9f3a", chatType: "unknown", chatKey: "ch_a|ou_9f3a", lastActiveAt: 3 }),
    ],
  })

  it("没有条件时原样返回", () => {
    expect(keyOf(filterSessionItems(list, {}))).toEqual(keyOf(list))
  })

  it("按类型筛：主用户 / 私聊 / 群 / 项目各自只看自己的，类型未知的只在「全部」里", () => {
    expect(keyOf(filterSessionItems(list, { filter: "main" }))).toEqual(["ch_a|ou_me::D:/work"])
    expect(keyOf(filterSessionItems(list, { filter: "p2p" }))).toEqual(["k1"])
    expect(keyOf(filterSessionItems(list, { filter: "group" }))).toEqual(["k2"])
    expect(keyOf(filterSessionItems(list, { filter: "project" }))).toEqual(["ch_a|ou_me::project_abc"])
    expect(keyOf(filterSessionItems(list, { filter: "all" }))).toHaveLength(5)
    expect(keyOf(filterSessionItems(list, { filter: "all" }))).toContain("k3")
  })

  it("只看运行中：主用户的和别人的都算", () => {
    expect(keyOf(filterSessionItems(list, { filter: "running" })).sort()).toEqual(["ch_a|ou_me::D:/work", "k1"].sort())
  })

  it("搜索按名字 / 预览 / 目录 / 聊天 id 命中，不分大小写", () => {
    expect(keyOf(filterSessionItems(list, { query: "订单" }))).toEqual(["k1"])
    expect(keyOf(filterSessionItems(list, { query: "客服" }))).toEqual(["k2"])
    expect(keyOf(filterSessionItems(list, { query: "d:/SVC" }))).toEqual(["k2"])
    expect(keyOf(filterSessionItems(list, { query: "OC_GROUP42" }))).toEqual(["k2"])
    expect(keyOf(filterSessionItems(list, { query: "9F3A" }))).toEqual(["k3"])
  })

  it("主用户的会话也能搜：按名字和目录", () => {
    expect(keyOf(filterSessionItems(list, { query: "官网" }))).toEqual(["ch_a|ou_me::project_abc"])
    expect(keyOf(filterSessionItems(list, { query: "d:/work" }))).toEqual(["ch_a|ou_me::D:/work"])
  })

  it("搜索词按空白拆开，每个词都要命中", () => {
    expect(keyOf(filterSessionItems(list, { query: "张三 订单" }))).toEqual(["k1"])
    expect(keyOf(filterSessionItems(list, { query: "张三 客服" }))).toEqual([])
    expect(keyOf(filterSessionItems(list, { query: "   " }))).toHaveLength(5)
  })

  it("搜索和类型一起生效", () => {
    expect(keyOf(filterSessionItems(list, { query: "0042", filter: "p2p" }))).toEqual([])
    expect(keyOf(filterSessionItems(list, { query: "0042", filter: "group" }))).toEqual(["k2"])
  })

  it("会话键里的通道 id 前缀不参与搜索，免得搜 ch_ 命中全部", () => {
    const real = build({
      managed: [
        session({ sessionKey: "ch_a|ou_1::D:/work", chatKey: "ch_a|ou_1" }),
        session({ sessionKey: "ch_a|ou_2", chatKey: "ch_a|ou_2", name: "李四" }),
      ],
    })
    expect(filterSessionItems(real, { query: "ch_a" })).toEqual([])
    expect(filterSessionItems(real, { query: "ou_2" }).map((s) => s.name)).toEqual(["李四"])
  })
})

describe("queueCounts", () => {
  it("处理中和排队分开数，没有状态的算排队", () => {
    expect(queueCounts([])).toEqual({ processing: 0, pending: 0 })
    expect(queueCounts([
      { fileId: "a", preview: "", status: "processing" },
      { fileId: "b", preview: "", status: "pending" },
      { fileId: "c", preview: "" },
    ])).toEqual({ processing: 1, pending: 2 })
  })
})

describe("rowCapabilities", () => {
  const mineItem = (over: Partial<DashboardSessionNode> = {}, current = false): SessionItem => {
    const n = node({ sessionKey: "ch_a|ou_me::D:/work", group: "main", ...over })
    return build({ groups: { main: [{ ...n, current }] } })[0]
  }
  const othersItem = (over: Partial<ManagedSession> = {}): SessionItem => build({ managed: [session(over)] })[0]

  it("主用户的空闲会话：能激活；能不能删看会话树的 removable；没有重置 / 恢复默认", () => {
    expect(rowCapabilities(mineItem({ removable: true }))).toEqual({ stop: false, activate: true, restore: false, reset: false, remove: true })
    expect(rowCapabilities(mineItem({ removable: false })).remove).toBe(false)
    expect(rowCapabilities(mineItem({})).remove).toBe(false)
  })

  it("主用户的当前会话不用激活；运行中的不用激活、能停止", () => {
    expect(rowCapabilities(mineItem({}, true)).activate).toBe(false)
    const running = rowCapabilities(mineItem({ running: true }))
    expect(running.activate).toBe(false)
    expect(running.stop).toBe(true)
  })

  it("别人的会话：能重置、能删除、没有「激活」；停止只在运行中；恢复默认只在只改了模型时", () => {
    expect(rowCapabilities(othersItem())).toEqual({ stop: false, activate: false, restore: false, reset: true, remove: true })
    expect(rowCapabilities(othersItem({ running: true })).stop).toBe(true)
    expect(rowCapabilities(othersItem({ canRestoreDefault: true })).restore).toBe(true)
  })
})

describe("overrideBadge", () => {
  it("什么都没改过 → 没有标签", () => {
    expect(overrideBadge(session())).toBeUndefined()
  })

  it("只改了模型", () => {
    const b = overrideBadge(session({ modelSource: "session", customized: true, defaultModel: "gpt-5" }))
    expect(b?.text).toBe("已改模型")
    expect(b?.title).toContain("gpt-5")
  })

  it("通道没配默认模型时悬停说明写「自动」", () => {
    const b = overrideBadge(session({ modelSource: "session", customized: true, defaultModel: "" }))
    expect(b?.title).toContain("自动")
  })

  it("供应商单独指定优先于模型", () => {
    const b = overrideBadge(session({ resourceSource: "session", modelSource: "session", customized: true, resourceName: "备用线路" }))
    expect(b?.text).toBe("单独供应商")
    expect(b?.title).toContain("备用线路")
  })

  it("只改了推理档（模型 / 供应商都跟随通道）", () => {
    expect(overrideBadge(session({ customized: true }))?.text).toBe("已改推理档")
  })
})

describe("lastActiveText", () => {
  const now = 10 * 86_400_000
  it("没有活动时间", () => {
    expect(lastActiveText({ lastActiveAt: undefined }, now)).toBe("无记录")
  })
  it("有活动时间按距今描述", () => {
    expect(lastActiveText({ lastActiveAt: now - 3 * 86_400_000 }, now)).toBe("3 天前")
    expect(lastActiveText({ lastActiveAt: now }, now)).toBe("刚刚")
  })
  it("活动时间为 0 也算有记录，不是「无记录」", () => {
    expect(lastActiveText({ lastActiveAt: 0 }, now)).toBe("10 天前")
  })
})

describe("确认文案", () => {
  it("删除：写明名字和后果；运行中、有排队才多出对应提示", () => {
    const idle = deleteConfirmText(session({ name: "张三" }))
    expect(idle).toContain("「张三」")
    expect(idle).toContain("全新的会话")
    expect(idle).not.toContain("正在运行")
    expect(idle).not.toContain("排队")

    const busy = deleteConfirmText(session({ running: true, queued: 3 }))
    expect(busy).toContain("正在运行，会先被停止")
    expect(busy).toContain("3 条排队中的消息")
  })

  it("重置：会话和设置都保留；运行中提示先停止", () => {
    const idle = resetConfirmText(session({ name: "张三" }))
    expect(idle).toContain("「张三」")
    expect(idle).toContain("设置都保留")
    expect(idle).not.toContain("正在运行")
    expect(resetConfirmText(session({ running: true }))).toContain("正在运行，会先被停止")
  })

  it("恢复默认：写出通道默认模型，没配时写自动", () => {
    expect(restoreConfirmText(session({ defaultModel: "claude-x" }))).toContain("（claude-x）")
    expect(restoreConfirmText(session({ defaultModel: "" }))).toContain("（自动）")
    expect(restoreConfirmText(session({ running: true }))).toContain("正在运行")
    expect(restoreConfirmText(session())).not.toContain("正在运行")
  })
})

describe("cleanupSummary", () => {
  const plan = (over: Partial<CleanupPlan["excluded"]> = {}, n = 2): CleanupPlan => ({
    olderThanDays: 14,
    candidates: Array.from({ length: n }, (_, i) => session({ sessionKey: `k${i}` })),
    excluded: { notManageable: 0, running: 0, queued: 0, customized: 0, noActivityTime: 0, recent: 0, ...over },
  })

  it("标题写出天数和个数；没有被保留的就不出现保留行", () => {
    const s = cleanupSummary(plan())
    expect(s.headline).toBe("超过 14 天没有活动的会话：2 个")
    expect(s.kept).toEqual([])
  })

  it("每类被保留的原因各一行，为 0 的不显示，顺序固定", () => {
    const s = cleanupSummary(plan({ recent: 5, running: 1, customized: 4, queued: 2, noActivityTime: 3, notManageable: 6 }))
    expect(s.kept).toEqual([
      "1 个正在运行，已保留",
      "2 个有排队消息，已保留",
      "4 个改过模型 / 供应商 / 推理档，已保留",
      "5 个不足 14 天，已保留",
      "3 个没有活动记录，已保留",
      "6 个不在清理范围（主用户 / 项目 / 任务），已保留",
    ])
  })

  it("「不足 N 天」跟着计划里的天数走", () => {
    const p = { ...plan({ recent: 1 }), olderThanDays: 30 }
    expect(cleanupSummary(p).kept).toEqual(["1 个不足 30 天，已保留"])
    expect(cleanupSummary(p).headline).toContain("超过 30 天")
  })
})

describe("parseCleanupDays", () => {
  it("正整数按数字返回，两端空白忽略", () => {
    expect(parseCleanupDays("14")).toBe(14)
    expect(parseCleanupDays(" 7 ")).toBe(7)
    expect(parseCleanupDays("1")).toBe(1)
    expect(parseCleanupDays("3650")).toBe(3650)
  })

  it("空、0、负数、小数、带字母、超过上限都算没填好", () => {
    for (const bad of ["", "  ", "0", "-3", "1.5", "7天", "abc", "3651", "1e3", "0x10"]) {
      expect(parseCleanupDays(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it("前导 0 不影响数值", () => {
    expect(parseCleanupDays("007")).toBe(7)
  })
})

describe("CLEANUP_DEFAULT_DAYS", () => {
  it("和主进程的默认天数一致", () => {
    expect(CLEANUP_DEFAULT_DAYS).toBe(DEFAULT_CLEANUP_DAYS)
  })

  it("上限和主进程一致：界面放行的最大值，主进程不会再截断", () => {
    expect(normalizeCleanupDays(3650)).toBe(3650)
    expect(parseCleanupDays("3650")).toBe(3650)
    expect(parseCleanupDays("3651")).toBeUndefined()
  })
})

describe("sortCleanupCandidates", () => {
  it("最久没动的在前；没有活动时间的排最后；不改原数组", () => {
    const a = session({ sessionKey: "a", lastActiveAt: 300 })
    const b = session({ sessionKey: "b", lastActiveAt: 100 })
    const c = session({ sessionKey: "c", lastActiveAt: undefined })
    const d = session({ sessionKey: "d", lastActiveAt: 0 })
    const input = [a, c, b, d]
    expect(sortCleanupCandidates(input).map((s) => s.sessionKey)).toEqual(["d", "b", "a", "c"])
    expect(input.map((s) => s.sessionKey)).toEqual(["a", "c", "b", "d"])
  })
})

describe("cleanupResultText", () => {
  it("全部成功", () => {
    expect(cleanupResultText({ ok: true, deleted: ["a", "b"], skipped: [], failed: [] })).toBe("已删除 2 个会话")
  })

  it("有跳过和失败时带上去重后的原因", () => {
    const text = cleanupResultText({
      ok: true,
      deleted: ["a"],
      skipped: [
        { sessionKey: "b", reason: "正在运行" },
        { sessionKey: "c", reason: "正在运行" },
        { sessionKey: "d", reason: "有排队消息" },
      ],
      failed: [
        { sessionKey: "e", error: "磁盘占用" },
        { sessionKey: "f", error: "磁盘占用" },
        { sessionKey: "g", error: "权限不足" },
      ],
    })
    expect(text).toBe("已删除 1 个会话，跳过 3 个（正在运行；有排队消息），失败 3 个（磁盘占用；权限不足）")
  })

  it("整体失败时用错误信息，没有就给兜底", () => {
    expect(cleanupResultText({ ok: false, error: "服务未运行", deleted: [], skipped: [], failed: [] })).toBe("服务未运行")
    expect(cleanupResultText({ ok: false, deleted: [], skipped: [], failed: [] })).toBe("清理失败")
  })
})
