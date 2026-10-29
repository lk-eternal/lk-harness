import { describe, expect, it } from "vitest"
import type { DashboardChannelNode, DashboardSessionNode, SessionGroupId } from "../src/shared/dashboard-tree"
import {
  DASHBOARD_TABS,
  DEFAULT_DASHBOARD_TAB,
  activeCardSub,
  activeChannelCount,
  channelsCardSub,
  queueCardSub,
} from "../src/renderer/components/dashboard/dashboard-view"

function node(over: Partial<DashboardSessionNode> = {}): DashboardSessionNode {
  return { sessionKey: "k", label: "k", group: "main", running: false, queue: [], ...over }
}

function channel(groups: Partial<Record<SessionGroupId, DashboardSessionNode[]>>): Pick<DashboardChannelNode, "groups"> {
  const all: SessionGroupId[] = ["main", "other_p2p", "group", "project", "task"]
  return { groups: Object.fromEntries(all.map((g) => [g, { sessions: groups[g] ?? [] }])) as DashboardChannelNode["groups"] }
}

describe("工作台页签", () => {
  it("四个页签：日志 / 消息通道 / 活跃会话 / 消息队列，顺序和卡片一致", () => {
    expect([...DASHBOARD_TABS]).toEqual(["logs", "channels", "sessions", "queue"])
  })

  it("启动时默认看日志（和改版前一致）", () => {
    expect(DEFAULT_DASHBOARD_TAB).toBe("logs")
  })
})

describe("消息通道卡副标题", () => {
  it("有几个通道就写几个；没有通道写没配置。不再写「点击展开 / 收起」", () => {
    expect(channelsCardSub(6)).toBe("共 6 个通道")
    expect(channelsCardSub(1)).toBe("共 1 个通道")
    expect(channelsCardSub(0)).toBe("尚未配置通道")
    for (const n of [0, 1, 6]) expect(channelsCardSub(n)).not.toMatch(/点击|展开|收起/)
  })
})

describe("activeChannelCount", () => {
  it("有运行中会话的通道个数（任何分组里运行中都算），全空闲的通道不算", () => {
    const channels = [
      channel({ main: [node({ running: true })] }),
      channel({ group: [node({ running: true })], other_p2p: [node()] }),
      channel({ main: [node()], project: [node()] }),
      channel({}),
    ]
    expect(activeChannelCount(channels)).toBe(2)
    expect(activeChannelCount([])).toBe(0)
  })

  it("同一个通道里跑了多个会话也只算一个通道", () => {
    expect(activeChannelCount([channel({ main: [node({ running: true }), node({ running: true })], group: [node({ running: true })] })])).toBe(1)
  })
})

describe("活跃会话卡副标题", () => {
  it("没有会话：等待消息；有会话：来自几个通道", () => {
    expect(activeCardSub(0, 0)).toBe("等待消息")
    expect(activeCardSub(0, 3)).toBe("等待消息")
    expect(activeCardSub(5, 2)).toBe("来自 2 个通道")
  })

  it("会话个数和会话树偶尔差一拍：有会话但树里还没对上时只说运行中，不写「来自 0 个通道」", () => {
    expect(activeCardSub(2, 0)).toBe("运行中")
  })

  it("不再写「点击查看 / 收起」", () => {
    for (const [s, c] of [[0, 0], [1, 0], [3, 2]]) expect(activeCardSub(s, c)).not.toMatch(/点击|展开|收起/)
  })
})

describe("消息队列卡副标题", () => {
  it("有消息写总条数，没有写队列为空（没拿到数时也当作空）", () => {
    expect(queueCardSub(7)).toBe("共 7 条")
    expect(queueCardSub(0)).toBe("队列为空")
    expect(queueCardSub(undefined)).toBe("队列为空")
    expect(queueCardSub(7)).not.toMatch(/点击|展开|收起/)
  })
})
