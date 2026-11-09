import { describe, expect, it } from "vitest"
import {
  applyOrder,
  createReorderTracker,
  reorderById,
  resolveOverIndex,
  type Snapshot,
} from "../src/renderer/components/sortable-list-logic"

const id = (x: { id: string }) => x.id
const mk = (...ids: string[]) => ids.map((i) => ({ id: i }))
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join("")

/** 6 行，行高 40，中线 100/140/180/220/260/300 */
const SNAPS: Snapshot[] = [100, 140, 180, 220, 260, 300].map((midY, i) => ({ id: "abcdef"[i], midY }))

describe("resolveOverIndex", () => {
  it("指针还在自己那一行附近：不动", () => {
    expect(resolveOverIndex(180, 2, SNAPS)).toBe(2)
    expect(resolveOverIndex(170, 2, SNAPS)).toBe(2) // 在上一行中线(140)以下
    expect(resolveOverIndex(200, 2, SNAPS)).toBe(2) // 在下一行中线(220)以上
  })

  it("往下拖一格 / 多格", () => {
    expect(resolveOverIndex(225, 2, SNAPS)).toBe(3)
    expect(resolveOverIndex(270, 0, SNAPS)).toBe(4)
    expect(resolveOverIndex(999, 0, SNAPS)).toBe(5)
  })

  it("往上拖一格", () => {
    expect(resolveOverIndex(135, 2, SNAPS)).toBe(1)
  })

  // 回归：原来往上拖时取了「越过的行里最靠下的一个」，同一次拖动最多只能上移一格
  it("往上拖多格：落在越过的最靠上一行", () => {
    expect(resolveOverIndex(90, 5, SNAPS)).toBe(0)
    expect(resolveOverIndex(-50, 5, SNAPS)).toBe(0)
    expect(resolveOverIndex(150, 5, SNAPS)).toBe(2) // 越过 180/220/260，没越过 140
    expect(resolveOverIndex(100, 3, SNAPS)).toBe(0) // 恰在第 0 行中线上，算越过
  })

  it("边界：指针正好在某行中线上算越过（往下、往上一致）", () => {
    expect(resolveOverIndex(220, 2, SNAPS)).toBe(3)
    expect(resolveOverIndex(140, 2, SNAPS)).toBe(1)
  })

  it("只有一行或空：返回原下标", () => {
    expect(resolveOverIndex(500, 0, [{ id: "a", midY: 10 }])).toBe(0)
    expect(resolveOverIndex(500, 0, [])).toBe(0)
  })

  it("扫过所有指针位置：结果与独立算法一致，且指针往下移时落点不会往回退", () => {
    // 行高不一致的列表
    const mids = [30, 95, 140, 230, 275, 390, 430]
    const snaps: Snapshot[] = mids.map((midY, i) => ({ id: String(i), midY }))
    for (let from = 0; from < snaps.length; from++) {
      let prev = -1
      for (let y = -20; y <= 480; y += 1) {
        // 独立算法：往下数越过了几行、往上数越过了几行
        const below = snaps.filter((s, i) => i > from && y >= s.midY).length
        const above = snaps.filter((s, i) => i < from && y <= s.midY).length
        expect(resolveOverIndex(y, from, snaps)).toBe(from + below - above)
        const got = resolveOverIndex(y, from, snaps)
        expect(got).toBeGreaterThanOrEqual(prev)
        prev = got
      }
    }
  })
})

describe("reorderById", () => {
  it("往下 / 往上移动", () => {
    expect(ids(reorderById(mk("a", "b", "c", "d"), "a", "c", id))).toBe("bcad")
    expect(ids(reorderById(mk("a", "b", "c", "d"), "d", "b", id))).toBe("adbc")
  })

  it("同一项、找不到的 id：原样返回同一个数组", () => {
    const items = mk("a", "b", "c")
    expect(reorderById(items, "b", "b", id)).toBe(items)
    expect(reorderById(items, "x", "b", id)).toBe(items)
    expect(reorderById(items, "a", "x", id)).toBe(items)
  })

  it("不修改传入的数组", () => {
    const items = mk("a", "b", "c")
    reorderById(items, "a", "c", id)
    expect(ids(items)).toBe("abc")
  })
})

describe("applyOrder", () => {
  it("按给定顺序排列，保留原对象", () => {
    const items = mk("a", "b", "c", "d")
    const out = applyOrder(items, ["c", "a", "d", "b"], id)
    expect(ids(out)).toBe("cadb")
    expect(out[0]).toBe(items[2])
  })

  it("顺序里没有的项排在最后、保持原相对顺序（保存期间别处新增了）", () => {
    const out = applyOrder(mk("a", "b", "n1", "c", "n2"), ["c", "b", "a"], id)
    expect(out.map(id)).toEqual(["c", "b", "a", "n1", "n2"])
  })

  it("顺序里有、列表里已经没有的项忽略（保存期间别处删除了）", () => {
    expect(ids(applyOrder(mk("a", "c"), ["c", "gone", "a"], id))).toBe("ca")
  })

  it("空顺序：保持原样；不修改入参", () => {
    const items = mk("a", "b", "c")
    expect(ids(applyOrder(items, [], id))).toBe("abc")
    applyOrder(items, ["c", "b", "a"], id)
    expect(ids(items)).toBe("abc")
  })
})

describe("createReorderTracker", () => {
  it("一次保存：开始后显示新顺序，结束后撤掉", () => {
    const t = createReorderTracker()
    expect(t.order).toBeNull()
    t.begin(["b", "a"])
    expect(t.order).toEqual(["b", "a"])
    expect(t.inflight).toBe(1)
    expect(t.end()).toBe(true)
    expect(t.order).toBeNull()
    expect(t.inflight).toBe(0)
  })

  it("连着拖两次：显示始终是最近一次的顺序，全部结束才撤掉（先结束的那次不能提前撤）", () => {
    const t = createReorderTracker()
    t.begin(["b", "a", "c"])
    t.begin(["c", "b", "a"])
    expect(t.order).toEqual(["c", "b", "a"])
    expect(t.end()).toBe(false)
    expect(t.order).toEqual(["c", "b", "a"])
    expect(t.end()).toBe(true)
    expect(t.order).toBeNull()
  })

  it("多结束一次不会变成负数，之后还能正常用", () => {
    const t = createReorderTracker()
    expect(t.end()).toBe(true)
    expect(t.inflight).toBe(0)
    t.begin(["a"])
    expect(t.inflight).toBe(1)
    expect(t.end()).toBe(true)
  })
})
