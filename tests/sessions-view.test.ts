import { describe, expect, it } from "vitest"
import { DEFAULT_CLEANUP_DAYS, normalizeCleanupDays, type CleanupPlan, type ManagedSession } from "../src/shared/managed-sessions"
import type { DashboardChannelNode, DashboardSessionNode, SessionGroupId } from "../src/shared/dashboard-tree"
import {
  CLEANUP_DEFAULT_DAYS,
  MY_GROUP_IDS,
  channelRunningCount,
  chatTag,
  cleanupResultText,
  cleanupSummary,
  deleteConfirmText,
  filterOthers,
  lastActiveText,
  othersOf,
  overrideBadge,
  parseCleanupDays,
  resetConfirmText,
  restoreConfirmText,
  sortCleanupCandidates,
  visibleMyGroups,
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

describe("visibleMyGroups", () => {
  it("主用户组常驻（即使是空的，要承载「+ 常用目录」），项目 / 任务有会话才出现", () => {
    expect(visibleMyGroups(channelNode({}))).toEqual(["main"])
    expect(visibleMyGroups(channelNode({ project: [node({ group: "project" })] }))).toEqual(["main", "project"])
    expect(visibleMyGroups(channelNode({ task: [node({ group: "task" })], project: [node({ group: "project" })] }))).toEqual(["main", "project", "task"])
  })

  it("私聊他人和群永远不在「我的会话」里，即使里面有运行中的会话", () => {
    const ch = channelNode({
      other_p2p: [node({ group: "other_p2p", running: true })],
      group: [node({ group: "group", running: true })],
    })
    expect(visibleMyGroups(ch)).toEqual(["main"])
    expect(MY_GROUP_IDS).not.toContain("other_p2p")
    expect(MY_GROUP_IDS).not.toContain("group")
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

describe("filterOthers", () => {
  const list = [
    session({ sessionKey: "k1", name: "张三", chatType: "p2p", preview: "帮我查下订单", running: true }),
    session({ sessionKey: "k2", name: "客服群 0042", chatType: "group", chatKey: "ch_a|oc_group42", workspaceDir: "D:/svc" }),
    session({ sessionKey: "k3", name: "私聊 9f3a", chatType: "unknown", chatKey: "ch_a|ou_9f3a" }),
  ]
  const keys = (r: ManagedSession[]) => r.map((s) => s.sessionKey)

  it("没有条件时原样返回", () => {
    expect(keys(filterOthers(list, {}))).toEqual(["k1", "k2", "k3"])
  })

  it("类型筛选：私聊 / 群只看路由表里明确知道类型的，未知的只在「全部」里", () => {
    expect(keys(filterOthers(list, { chat: "p2p" }))).toEqual(["k1"])
    expect(keys(filterOthers(list, { chat: "group" }))).toEqual(["k2"])
    expect(keys(filterOthers(list, { chat: "all" }))).toEqual(["k1", "k2", "k3"])
  })

  it("只看运行中", () => {
    expect(keys(filterOthers(list, { chat: "running" }))).toEqual(["k1"])
  })

  it("搜索按名字 / 预览 / 目录 / 聊天 id 命中，不分大小写", () => {
    expect(keys(filterOthers(list, { query: "订单" }))).toEqual(["k1"])
    expect(keys(filterOthers(list, { query: "客服" }))).toEqual(["k2"])
    expect(keys(filterOthers(list, { query: "d:/SVC" }))).toEqual(["k2"])
    expect(keys(filterOthers(list, { query: "OC_GROUP42" }))).toEqual(["k2"])
    expect(keys(filterOthers(list, { query: "9F3A" }))).toEqual(["k3"])
  })

  it("搜索词按空白拆开，每个词都要命中", () => {
    expect(keys(filterOthers(list, { query: "张三 订单" }))).toEqual(["k1"])
    expect(keys(filterOthers(list, { query: "张三 客服" }))).toEqual([])
    expect(keys(filterOthers(list, { query: "   " }))).toEqual(["k1", "k2", "k3"])
  })

  it("搜索和类型一起生效", () => {
    expect(keys(filterOthers(list, { query: "0042", chat: "p2p" }))).toEqual([])
    expect(keys(filterOthers(list, { query: "0042", chat: "group" }))).toEqual(["k2"])
  })

  it("会话键里的通道 id 前缀不参与搜索，免得搜 ch_ 命中全部", () => {
    const real = [
      session({ sessionKey: "ch_a|ou_1::D:/work", chatKey: "ch_a|ou_1" }),
      session({ sessionKey: "ch_a|ou_2", chatKey: "ch_a|ou_2", name: "李四" }),
    ]
    expect(filterOthers(real, { query: "ch_a" })).toEqual([])
    expect(filterOthers(real, { query: "ou_2" }).map((s) => s.name)).toEqual(["李四"])
  })
})

describe("chatTag", () => {
  it("私聊 / 群 / 未知", () => {
    expect(chatTag({ chatType: "p2p" })).toBe("私聊")
    expect(chatTag({ chatType: "group" })).toBe("群")
    expect(chatTag({ chatType: "unknown" })).toBe("会话")
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
