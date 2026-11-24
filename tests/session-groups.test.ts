import { describe, expect, it } from "vitest"
import {
  applyGroupPatch,
  DEFAULT_GROUP_STATES,
  groupOf,
  parseGroupId,
  parseGroupPatch,
  parseGroupStates,
  splitGroups,
  splitTiers,
  summarizeStatus,
  viewGroup,
  type GroupViewState,
} from "../src/shared/session-groups"

/** 会话列表的分类（项目 / 会话 / 已归档）：怎么分、折叠和展开档位怎么算当前显示哪些行 */

describe("会话属于哪一类", () => {
  it("项目会话是项目，其余（目录会话、临时会话）都是会话", () => {
    expect(groupOf({ kind: "project" })).toBe("project")
    expect(groupOf({ kind: "dir" })).toBe("chat")
    expect(groupOf({ kind: "temp" })).toBe("chat")
  })

  it("归档的先算：已归档的项目属于已归档，不再算项目", () => {
    expect(groupOf({ kind: "project", archived: true })).toBe("archived")
    expect(groupOf({ kind: "project", archived: false })).toBe("project")
  })

  it("按类分开，各类内部保持原来的顺序，三类互不重叠", () => {
    const tabs = [
      { id: "a", kind: "dir" },
      { id: "b", kind: "project" },
      { id: "c", kind: "project", archived: true },
      { id: "d", kind: "temp" },
      { id: "e", kind: "project" },
    ]
    const groups = splitGroups(tabs)
    expect(groups.project.map((t) => t.id)).toEqual(["b", "e"])
    expect(groups.chat.map((t) => t.id)).toEqual(["a", "d"])
    expect(groups.archived.map((t) => t.id)).toEqual(["c"])
  })
})

describe("整理读到的分类状态", () => {
  it("没存过：项目、会话展开，已归档收起，都只显示前 5 个", () => {
    expect(parseGroupStates(undefined)).toEqual({
      project: { collapsed: false, level: 0 },
      chat: { collapsed: false, level: 0 },
      archived: { collapsed: true, level: 0 },
    })
  })

  it("格式不对（不是对象、数组、字符串）：当作没存过", () => {
    for (const raw of [null, "x", 1, [], true]) expect(parseGroupStates(raw)).toEqual(DEFAULT_GROUP_STATES)
  })

  it("只存了一部分：存了的照用，没存的用默认值", () => {
    const states = parseGroupStates({ chat: { collapsed: true }, archived: { level: 2 } })
    expect(states.chat).toEqual({ collapsed: true, level: 0 })
    expect(states.archived).toEqual({ collapsed: true, level: 2 })
    expect(states.project).toEqual({ collapsed: false, level: 0 })
  })

  it("某个字段不合法：只那个字段退回默认值，别的照用", () => {
    const states = parseGroupStates({ project: { collapsed: "yes", level: 1 }, chat: { collapsed: true, level: 3 }, archived: { level: "2" } })
    expect(states.project).toEqual({ collapsed: false, level: 1 })
    expect(states.chat).toEqual({ collapsed: true, level: 0 })
    expect(states.archived).toEqual({ collapsed: true, level: 0 })
  })

  it("整理出来的是新对象：外面改它不影响默认值", () => {
    const states = parseGroupStates(undefined)
    states.chat.collapsed = true
    expect(parseGroupStates(undefined).chat.collapsed).toBe(false)
    expect(DEFAULT_GROUP_STATES.chat.collapsed).toBe(false)
  })

  it("认类名：只认项目、会话、已归档三个", () => {
    expect(parseGroupId("project")).toBe("project")
    expect(parseGroupId("chat")).toBe("chat")
    expect(parseGroupId("archived")).toBe("archived")
    for (const raw of ["", "main", "Project", undefined, null, 1]) expect(parseGroupId(raw)).toBeUndefined()
  })

  it("从请求里取要改的字段：只留合法的，多余的丢掉，一个都没有就是没有", () => {
    expect(parseGroupPatch({ collapsed: true })).toEqual({ collapsed: true })
    expect(parseGroupPatch({ level: 2 })).toEqual({ level: 2 })
    expect(parseGroupPatch({ collapsed: false, level: 1, extra: 1 })).toEqual({ collapsed: false, level: 1 })
    expect(parseGroupPatch({ collapsed: "x", level: 5 })).toBeUndefined()
    expect(parseGroupPatch({})).toBeUndefined()
    for (const raw of [null, undefined, "x", 1]) expect(parseGroupPatch(raw)).toBeUndefined()
  })
})

describe("改某一类的状态", () => {
  it("只改指定的类和指定的字段，别的不动，也不改传入的对象", () => {
    const before = parseGroupStates(undefined)
    const after = applyGroupPatch(before, "chat", { collapsed: true })
    expect(after.chat).toEqual({ collapsed: true, level: 0 })
    expect(after.project).toEqual(before.project)
    expect(after.archived).toEqual(before.archived)
    expect(before.chat.collapsed).toBe(false)
  })

  it("一次只改一个字段：另一个字段保留", () => {
    const states = applyGroupPatch(parseGroupStates({ chat: { collapsed: true, level: 1 } }), "chat", { level: 2 })
    expect(states.chat).toEqual({ collapsed: true, level: 2 })
  })

  it("已经是目标状态：原样返回同一个对象（调用方据此省掉写盘和刷新）", () => {
    const states = parseGroupStates(undefined)
    expect(applyGroupPatch(states, "chat", { collapsed: false })).toBe(states)
    expect(applyGroupPatch(states, "archived", { collapsed: true, level: 0 })).toBe(states)
  })
})

describe("一批会话里最该让用户知道的状态", () => {
  const statusOf = (s: string) => s as "working" | "unread" | "idle"

  it("没有会话、都没动静：idle", () => {
    expect(summarizeStatus([], statusOf)).toBe("idle")
    expect(summarizeStatus(["idle", "idle"], statusOf)).toBe("idle")
  })

  it("有新回复没看的：unread", () => {
    expect(summarizeStatus(["idle", "unread"], statusOf)).toBe("unread")
  })

  it("有在回复的：working，比 unread 优先", () => {
    expect(summarizeStatus(["unread", "idle", "working"], statusOf)).toBe("working")
    expect(summarizeStatus(["working", "unread"], statusOf)).toBe("working")
  })
})

describe("这一类此刻该显示哪些行", () => {
  const ids = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
  const state = (level: 0 | 1 | 2, collapsed = false): GroupViewState => ({ collapsed, level })
  const isPinned = (row: string) => row.startsWith("p")
  const view = (rows: string[], s: GroupViewState, keep?: (row: string) => boolean) => viewGroup(rows, s, { isPinned, keep })

  describe("展开档位：5 → 10 → 全部 → 收起", () => {
    it("不超过 5 个：全显示，没有展开按钮", () => {
      const v = view(ids(5), state(0))
      expect(v.shown).toEqual(ids(5))
      expect(v.hidden).toEqual([])
      expect(v.footer).toBeNull()
    })

    it("超过 5 个：先显示前 5 个，底部是「展开更多」，点了去 10 个", () => {
      const v = view(ids(12), state(0))
      expect(v.shown).toEqual(ids(5))
      expect(v.hidden).toEqual(ids(12).slice(5))
      expect(v.footer).toEqual({ kind: "more", to: 1 })
    })

    it("10 个档位：显示前 10 个，还有就是「展开全部」", () => {
      const v = view(ids(12), state(1))
      expect(v.shown).toEqual(ids(10))
      expect(v.hidden).toEqual(["r11", "r12"])
      expect(v.footer).toEqual({ kind: "all", to: 2 })
    })

    it("全部档位：全显示，底部是「收起」，点了回到前 5 个", () => {
      const v = view(ids(12), state(2))
      expect(v.shown).toEqual(ids(12))
      expect(v.hidden).toEqual([])
      expect(v.footer).toEqual({ kind: "less", to: 0 })
    })

    it("一共不到 10 个，点一次「展开更多」就全出来了：下一步是「收起」，不是「展开全部」", () => {
      const v = view(ids(8), state(1))
      expect(v.shown).toEqual(ids(8))
      expect(v.footer).toEqual({ kind: "less", to: 0 })
    })

    it("不超过 5 个，哪怕记下的是「全部」档位：也没有「收起」", () => {
      expect(view(ids(5), state(2)).footer).toBeNull()
      expect(view(ids(3), state(1)).footer).toBeNull()
    })

    it("没有会话：什么都不显示", () => {
      const v = view([], state(0))
      expect(v).toEqual({ collapsed: false, shown: [], hidden: [], footer: null })
    })
  })

  describe("置顶的行", () => {
    it("置顶的始终显示，也算在前 5 个名额里：置顶 2 个，其余的先显示 3 个", () => {
      const v = view([...ids(2, "p"), ...ids(8)], state(0))
      expect(v.shown).toEqual(["p1", "p2", "r1", "r2", "r3"])
      expect(v.hidden).toEqual(ids(8).slice(3))
      expect(v.footer).toEqual({ kind: "more", to: 1 })
    })

    it("有置顶的「展开更多」：其余的再多 5 个（置顶 2 个时一共 10 行），再点是「展开全部」", () => {
      const rows = [...ids(2, "p"), ...ids(12)]
      const more = view(rows, state(1))
      expect(more.shown).toEqual(["p1", "p2", ...ids(8)])
      expect(more.footer).toEqual({ kind: "all", to: 2 })
      const all = view(rows, state(2))
      expect(all.shown).toEqual(rows)
      expect(all.footer).toEqual({ kind: "less", to: 0 })
    })

    it("置顶不少于 5 个：置顶的全显示，其余的先一个都不显示，底部是「展开更多」", () => {
      const rows = [...ids(7, "p"), ...ids(3)]
      const v = view(rows, state(0))
      expect(v.shown).toEqual(ids(7, "p"))
      expect(v.hidden).toEqual(ids(3))
      expect(v.footer).toEqual({ kind: "more", to: 1 })
    })

    it("置顶不少于 5 个：「展开更多」显示其余的 5 个，不受置顶个数影响；再点「展开全部」", () => {
      const rows = [...ids(7, "p"), ...ids(12)]
      const more = view(rows, state(1))
      expect(more.shown).toEqual([...ids(7, "p"), ...ids(5)])
      expect(more.footer).toEqual({ kind: "all", to: 2 })
      expect(view(rows, state(2)).shown).toEqual(rows)
    })

    it("置顶不少于 5 个、其余的不到 5 个：点一次「展开更多」就全出来了，下一步是「收起」", () => {
      const v = view([...ids(7, "p"), ...ids(3)], state(1))
      expect(v.shown).toHaveLength(10)
      expect(v.hidden).toEqual([])
      expect(v.footer).toEqual({ kind: "less", to: 0 })
    })

    it("置顶加其余刚好 5 个：没有展开按钮；置顶刚好 5 个、没有其余的：同样没有", () => {
      expect(view([...ids(2, "p"), ...ids(3)], state(0)).footer).toBeNull()
      const five = view(ids(5, "p"), state(0))
      expect(five.shown).toEqual(ids(5, "p"))
      expect(five.footer).toBeNull()
    })

    it("置顶 5 个、其余还有会话：默认只显示置顶的，有「展开更多」", () => {
      const v = view([...ids(5, "p"), ...ids(2)], state(0))
      expect(v.shown).toEqual(ids(5, "p"))
      expect(v.footer).toEqual({ kind: "more", to: 1 })
    })

    it("置顶的排在最前，两组内部保持传入的顺序", () => {
      const v = view(["r1", "p2", "r2", "p1"], state(0))
      expect(v.shown).toEqual(["p2", "p1", "r1", "r2"])
    })
  })

  describe("折叠", () => {
    it("整类折着：一行都不显示，没有展开按钮，被收起的是全部", () => {
      const v = view([...ids(2, "p"), ...ids(8)], state(1, true))
      expect(v).toEqual({ collapsed: true, shown: [], hidden: [...ids(2, "p"), ...ids(8)], footer: null })
    })

    it("折着的那一类里有刚选中的会话：此刻先展开（记下的状态不变，由调用方的 keep 决定）", () => {
      const v = view(ids(8), state(0, true), (row) => row === "r3")
      expect(v.collapsed).toBe(false)
      expect(v.shown).toEqual(ids(5))
    })

    it("keep 的会话不在这一类里：折着就还是折着", () => {
      expect(view(ids(8), state(0, true), (row) => row === "x").collapsed).toBe(true)
    })
  })

  describe("刚选中的会话要看得见", () => {
    it("它在被收起的行里：档位提到刚好够看见它，不多展开", () => {
      const v = view(ids(30), state(0), (row) => row === "r8")
      expect(v.shown).toEqual(ids(10))
      expect(v.footer).toEqual({ kind: "all", to: 2 })
    })

    it("它排在 10 个之后：展开全部", () => {
      const v = view(ids(30), state(0), (row) => row === "r25")
      expect(v.shown).toEqual(ids(30))
      expect(v.footer).toEqual({ kind: "less", to: 0 })
    })

    it("它本来就看得见（在前 5 个里，或是置顶的）：档位不变", () => {
      expect(view(ids(30), state(0), (row) => row === "r2").shown).toEqual(ids(5))
      expect(view([...ids(1, "p"), ...ids(30)], state(0), (row) => row === "p1").shown).toEqual(["p1", ...ids(4)])
    })

    it("置顶占了名额：第 5 个其余的行已经在前 5 个之外，要档位提到够看见它", () => {
      const rows = [...ids(1, "p"), ...ids(30)]
      expect(view(rows, state(0), (row) => row === "r4").shown).toEqual(["p1", ...ids(4)])
      expect(view(rows, state(0), (row) => row === "r5").shown).toEqual(["p1", ...ids(9)])
    })

    it("置顶不少于 5 个：其余的第一个也在前 5 个之外，先提到「展开更多」那档", () => {
      const rows = [...ids(7, "p"), ...ids(30)]
      expect(view(rows, state(0), (row) => row === "r1").shown).toEqual([...ids(7, "p"), ...ids(5)])
      expect(view(rows, state(0), (row) => row === "r6").shown).toEqual(rows)
    })

    it("记下的档位已经够看见它：不改", () => {
      expect(view(ids(30), state(1), (row) => row === "r8").shown).toEqual(ids(10))
    })

    it("不改传入的数组", () => {
      const rows = ids(8)
      view(rows, state(0), (row) => row === "r8")
      expect(rows).toEqual(ids(8))
    })
  })
})

describe("按档位分块（展开更多 / 展开全部 / 收起时整块滑开滑合）", () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `r${i + 1}`)
  const range = (from: number, to: number): string[] => ids(to).slice(from - 1)

  it("没有置顶：前 5 个是 head，第 6 到 10 个是第一块，其余是第二块", () => {
    const { head, more } = splitTiers(ids(30), 5, 0)
    expect(head).toEqual(ids(5))
    expect(more.map((m) => [m.tier, m.rows])).toEqual([[1, range(6, 10)], [2, range(11, 30)]])
  })

  it("块跟着显示个数开：5 个都关，10 个开第一块，再多两块都开", () => {
    const opens = (shown: number) => splitTiers(ids(30), shown, 0).more.map((m) => m.open)
    expect(opens(5)).toEqual([false, false])
    expect(opens(10)).toEqual([true, false])
    expect(opens(30)).toEqual([true, true])
  })

  it("关着的块也给出：收起时它要先滑合、滑完才摘掉，行得还在", () => {
    const { more } = splitTiers(ids(30), 5, 0)
    expect(more.every((m) => !m.open && m.rows.length > 0)).toBe(true)
  })

  it("不到 6 个：没有块；6 到 10 个：只有第一块", () => {
    expect(splitTiers(ids(5), 5, 0)).toEqual({ head: ids(5), more: [] })
    expect(splitTiers(ids(8), 8, 0).more).toEqual([{ tier: 1, rows: range(6, 8), open: true }])
    expect(splitTiers(ids(10), 5, 0).more).toEqual([{ tier: 1, rows: range(6, 10), open: false }])
  })

  it("没有行：什么都没有", () => {
    expect(splitTiers([], 0, 0)).toEqual({ head: [], more: [] })
  })

  it("置顶占了名额：置顶 2 个时 head 只有 3 个，第一块是接着的 5 个", () => {
    const { head, more } = splitTiers(ids(30), 3, 2)
    expect(head).toEqual(ids(3))
    expect(more.map((m) => [m.tier, m.rows, m.open])).toEqual([[1, range(4, 8), false], [2, range(9, 30), false]])
  })

  it("置顶不少于 5 个：head 是空的，第一块从其余的第一个开始", () => {
    const { head, more } = splitTiers(ids(30), 0, 7)
    expect(head).toEqual([])
    expect(more.map((m) => [m.tier, m.rows, m.open])).toEqual([[1, ids(5), false], [2, range(6, 30), false]])
    expect(splitTiers(ids(30), 5, 7).more.map((m) => m.open)).toEqual([true, false])
  })

  it("和 viewGroup 对得上：置顶的加 head 加开着的块，就是此刻要显示的行（含为选中会话撑开的）", () => {
    const pins = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i + 1}`)
    const keeps = [undefined, "r2", "r4", "r8", "r25"]
    for (const pinnedCount of [0, 1, 2, 4, 5, 7, 12]) {
      for (const n of [0, 3, 5, 6, 10, 11, 30]) {
        for (const level of [0, 1, 2] as const) {
          for (const keepKey of keeps) {
            const pinned = pins(pinnedCount)
            const rest = ids(n)
            const v = viewGroup([...pinned, ...rest], { collapsed: false, level }, { isPinned: (row) => row.startsWith("p"), keep: (row) => row === keepKey })
            const { head, more } = splitTiers(rest, rest.length - v.hidden.length, pinnedCount)
            const drawn = [...pinned, ...head, ...more.filter((m) => m.open).flatMap((m) => m.rows)]
            expect(drawn, `pinned=${pinnedCount} n=${n} level=${level} keep=${keepKey}`).toEqual(v.shown)
          }
        }
      }
    }
  })

  it("不改传入的数组", () => {
    const rows = ids(12)
    splitTiers(rows, 12, 0)
    expect(rows).toEqual(ids(12))
  })
})
