import { createElement, Fragment, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { renderSessionGroup } from "../src/renderer/components/chat/SessionGroupSection"
import { NO_GROUP_CONTROL, type SessionGroupControl } from "../src/renderer/components/chat/session-groups-state"
import { parseGroupStates, type GroupRowStatus, type SessionGroupStates, type SessionListGroupId } from "../src/shared/session-groups"

/** 会话列表里一类会话的画法：标题、折叠、展开按钮，以及折着的行里有动静时标题上的提示 */

interface Row {
  sessionKey: string
  pinned?: boolean
  status?: GroupRowStatus
}

const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ sessionKey: `s${i + 1}` }))
const renderRow = (row: Row): ReactNode => createElement("div", { key: row.sessionKey, "data-row": row.sessionKey }, row.sessionKey)

function control(states: SessionGroupStates, revealed: string[] = []) {
  const changes: [SessionListGroupId, object][] = []
  const clears = { count: 0 }
  const order: string[] = []
  const c: SessionGroupControl = {
    states,
    change: (group, patch) => { order.push("change"); changes.push([group, patch]) },
    isRevealed: (key) => revealed.includes(key),
    clearReveal: () => { order.push("clear"); clears.count++ },
  }
  return { c, changes, clears, order }
}

function draw(group: SessionListGroupId, rows: Row[], c: SessionGroupControl = NO_GROUP_CONTROL): ReactNode {
  return renderSessionGroup({
    id: `x-${group}`,
    group,
    rows,
    control: c,
    isPinned: (r) => !!r.pinned,
    statusOf: (r) => r.status ?? "idle",
    renderRow,
    variant: "desktop",
  })
}

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(Fragment, null, node))
const shownRows = (markup: string): string[] => [...markup.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])

describe("画一类会话：标题和行", () => {
  it("这一类没有会话：什么都不画", () => {
    expect(draw("project", [])).toBeNull()
  })

  it("标题是分类名加这一类的总数；展开时画出行", () => {
    const markup = html(draw("project", rowsOf(3)))
    expect(markup).toContain("项目")
    expect(markup).toMatch(/>3<\/span>/)
    expect(markup).toContain('aria-expanded="true"')
    expect(shownRows(markup)).toEqual(["s1", "s2", "s3"])
  })

  it("三类的标题：项目、会话、已归档", () => {
    expect(html(draw("chat", rowsOf(1)))).toContain("会话")
    expect(html(draw("archived", rowsOf(1), control(parseGroupStates({ archived: { collapsed: false } })).c))).toContain("已归档")
  })

  it("已归档默认折着：只有标题和总数，没有行", () => {
    const markup = html(draw("archived", rowsOf(3)))
    expect(markup).toContain('aria-expanded="false"')
    expect(shownRows(markup)).toEqual([])
    expect(markup).toMatch(/>3<\/span>/)
  })

  it("记下的是折着：不画行也不画展开按钮", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }))
    const markup = html(draw("chat", rowsOf(12), c))
    expect(shownRows(markup)).toEqual([])
    expect(markup).not.toContain("data-session-group-footer")
  })

  it("折着时，展开后的前 5 行已经交给分类组件（折起是先滑合再摘掉，滑的过程中还要画着）", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }))
    const node = draw("chat", rowsOf(12), c) as ReactElement<{ children: ReactElement[] }>
    expect(node.props.children.map((row) => row.key)).toEqual(["s1", "s2", "s3", "s4", "s5"])
  })
})

describe("画一类会话：展开按钮", () => {
  const states = (level: 0 | 1 | 2) => control(parseGroupStates({ chat: { level } })).c

  it("超过 5 个：前 5 个 +「展开更多（还有 N 个）」", () => {
    const markup = html(draw("chat", rowsOf(12), states(0)))
    expect(shownRows(markup)).toEqual(["s1", "s2", "s3", "s4", "s5"])
    expect(markup).toContain('data-session-group-footer="more"')
    expect(markup).toContain("展开更多（还有 7 个）")
  })

  it("10 个档位还有没显示的：「展开全部（还有 N 个）」", () => {
    const markup = html(draw("chat", rowsOf(12), states(1)))
    expect(shownRows(markup)).toHaveLength(10)
    expect(markup).toContain('data-session-group-footer="all"')
    expect(markup).toContain("展开全部（还有 2 个）")
  })

  it("全部展开后：「收起」", () => {
    const markup = html(draw("chat", rowsOf(12), states(2)))
    expect(shownRows(markup)).toHaveLength(12)
    expect(markup).toContain('data-session-group-footer="less"')
    expect(markup).toContain("收起")
  })

  it("不超过 5 个：没有展开按钮", () => {
    expect(html(draw("chat", rowsOf(5), states(0)))).not.toContain("data-session-group-footer")
  })

  it("置顶的不占 5 个名额，始终显示", () => {
    const rows: Row[] = [{ sessionKey: "p1", pinned: true }, { sessionKey: "p2", pinned: true }, ...rowsOf(8)]
    const markup = html(draw("chat", rows, states(0)))
    expect(shownRows(markup)).toEqual(["p1", "p2", "s1", "s2", "s3", "s4", "s5"])
    expect(markup).toContain("展开更多（还有 3 个）")
  })
})

describe("画一类会话：置顶的几行一起画", () => {
  const pinnedRows = (): Row[] => [{ sessionKey: "p1", pinned: true }, { sessionKey: "p2", pinned: true }, ...rowsOf(8)]

  function drawWithPinned(rows: Row[], c: SessionGroupControl = NO_GROUP_CONTROL) {
    const calls: string[][] = []
    const node = renderSessionGroup({
      id: "x-chat",
      group: "chat",
      rows,
      control: c,
      isPinned: (r) => !!r.pinned,
      statusOf: () => "idle",
      renderRow,
      renderPinned: (pinned) => {
        calls.push(pinned.map((r) => r.sessionKey))
        return createElement("section", { key: "pinned" }, pinned.map(renderRow))
      },
      variant: "desktop",
    })
    return { calls, markup: html(node) }
  }

  it("置顶的几行一次交给 renderPinned，排在其余行前面；其余行仍一行行画，名额照旧只算它们", () => {
    const { calls, markup } = drawWithPinned(pinnedRows(), control(parseGroupStates({ chat: { level: 0 } })).c)
    expect(calls).toEqual([["p1", "p2"]])
    expect(shownRows(markup)).toEqual(["p1", "p2", "s1", "s2", "s3", "s4", "s5"])
    const block = /<section>(.*?)<\/section>/.exec(markup)
    expect(shownRows(block?.[1] ?? "")).toEqual(["p1", "p2"])
    expect(markup).toContain("展开更多（还有 3 个）")
  })

  it("没有置顶的行：不调用 renderPinned", () => {
    expect(drawWithPinned(rowsOf(3)).calls).toEqual([])
  })

  it("这一类折着：界面上不画，但置顶的行照样交给 renderPinned（折起的动画还要画着它们）", () => {
    const folded = control(parseGroupStates({ chat: { collapsed: true } })).c
    const { calls, markup } = drawWithPinned(pinnedRows(), folded)
    expect(calls).toEqual([["p1", "p2"]])
    expect(shownRows(markup)).toEqual([])
  })
})

describe("画一类会话：折起来的行里有动静", () => {
  const rowsWith = (status: GroupRowStatus, at: number): Row[] => rowsOf(12).map((r, i) => (i === at ? { ...r, status } : r))
  const WORKING = 'aria-label="有会话正在回复"'
  const UNREAD = 'aria-label="有会话有新回复"'

  it("整类折着：标题上提示有在回复的", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }))
    expect(html(draw("chat", rowsWith("working", 7), c))).toContain(WORKING)
  })

  it("整类折着：标题上提示有新回复没看的；回复中比新回复优先", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }))
    expect(html(draw("chat", rowsWith("unread", 7), c))).toContain(UNREAD)
    const both = rowsOf(3).map((r, i) => ({ ...r, status: (i === 0 ? "unread" : i === 1 ? "working" : "idle") as GroupRowStatus }))
    const markup = html(draw("chat", both, c))
    expect(markup).toContain(WORKING)
    expect(markup).not.toContain(UNREAD)
  })

  it("整类折着、都没动静：没有提示", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }))
    const markup = html(draw("chat", rowsOf(12), c))
    expect(markup).not.toContain(WORKING)
    expect(markup).not.toContain(UNREAD)
  })

  it("展开着、被收起的行里有动静：提示在底部按钮上", () => {
    const markup = html(draw("chat", rowsWith("unread", 9), control(parseGroupStates(undefined)).c))
    expect(markup).toContain(UNREAD)
    expect(markup.indexOf(UNREAD)).toBeGreaterThan(markup.indexOf("data-session-group-footer"))
  })

  it("展开着、动静的那一行本来就显示着：不提示（行上自己有转圈和绿点）", () => {
    const markup = html(draw("chat", rowsWith("working", 2), control(parseGroupStates(undefined)).c))
    expect(markup).not.toContain(WORKING)
  })
})

describe("画一类会话：刚选中的会话要看得见", () => {
  it("它在折着的这一类里：这一类先展开", () => {
    const { c } = control(parseGroupStates({ chat: { collapsed: true } }), ["s3"])
    const markup = html(draw("chat", rowsOf(8), c))
    expect(markup).toContain('aria-expanded="true"')
    expect(shownRows(markup)).toEqual(["s1", "s2", "s3", "s4", "s5"])
  })

  it("它在被收起的行里：展开到刚好看得见它", () => {
    const { c } = control(parseGroupStates(undefined), ["s8"])
    expect(shownRows(html(draw("chat", rowsOf(30), c)))).toHaveLength(10)
  })
})

describe("画一类会话：点击", () => {
  const element = (node: ReactNode) => node as ReactElement<{ onToggle: () => void; onFooter: (to: 0 | 1 | 2) => void }>

  it("点标题：先收回为选中会话临时撑开的，再记下折叠", () => {
    const { c, changes, order } = control(parseGroupStates(undefined))
    element(draw("chat", rowsOf(3), c)).props.onToggle()
    expect(changes).toEqual([["chat", { collapsed: true }]])
    expect(order).toEqual(["clear", "change"])
  })

  it("折着的点标题：记下展开", () => {
    const { c, changes } = control(parseGroupStates({ project: { collapsed: true } }))
    element(draw("project", rowsOf(3), c)).props.onToggle()
    expect(changes).toEqual([["project", { collapsed: false }]])
  })

  it("记下的是折着、但此刻被选中的会话撑开着：点标题就是折起来（按看到的状态翻，不是按记下的）", () => {
    const { c, changes, clears } = control(parseGroupStates({ chat: { collapsed: true } }), ["s2"])
    element(draw("chat", rowsOf(3), c)).props.onToggle()
    expect(changes).toEqual([["chat", { collapsed: true }]])
    expect(clears.count).toBe(1)
  })

  it("点底部按钮：记下它要去的档位，同样先收回临时撑开的", () => {
    const { c, changes, order } = control(parseGroupStates(undefined))
    element(draw("chat", rowsOf(12), c)).props.onFooter(1)
    expect(changes).toEqual([["chat", { level: 1 }]])
    expect(order).toEqual(["clear", "change"])
  })

  it("没接分类状态（默认的 NO_GROUP_CONTROL）：点了也没有任何效果，不报错", () => {
    expect(() => element(draw("chat", rowsOf(3))).props.onToggle()).not.toThrow()
  })
})
