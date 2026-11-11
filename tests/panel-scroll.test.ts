import { describe, expect, it } from "vitest"
import { scrollActiveIntoView, scrollDelta } from "../src/renderer/components/panel-scroll"

describe("scrollDelta：选中行要滚多少才看得见", () => {
  const view = { top: 100, bottom: 400 }

  it("已经在可视区里：不滚", () => {
    expect(scrollDelta(view, { top: 150, bottom: 190 })).toBe(0)
    expect(scrollDelta(view, { top: 100, bottom: 140 })).toBe(0)
    expect(scrollDelta(view, { top: 360, bottom: 400 })).toBe(0)
  })

  it("在下沿之外：往下滚到刚好露出整行", () => {
    expect(scrollDelta(view, { top: 420, bottom: 460 })).toBe(60)
  })

  it("在上沿之外：往上滚到行顶对齐", () => {
    expect(scrollDelta(view, { top: 60, bottom: 100 })).toBe(-40)
  })

  it("粘性表头占着上沿：行藏在它下面也算看不见", () => {
    expect(scrollDelta(view, { top: 110, bottom: 150 }, 50)).toBe(-40)
    expect(scrollDelta(view, { top: 150, bottom: 190 }, 50)).toBe(0)
  })

  it("行比可视区还高：先保证行顶露出来，不为了露出行底把行顶滚没", () => {
    expect(scrollDelta(view, { top: 300, bottom: 800 })).toBe(200)
  })
})

interface FakeRect { top: number; bottom: number }

/** 只做 scrollActiveIntoView 用到的那几个方法；不起 DOM */
function fakeList(opts: { view: FakeRect; row?: FakeRect; heads?: FakeRect[]; scrollTop?: number }) {
  const rect = (r: FakeRect) => ({ getBoundingClientRect: () => r })
  const list = {
    scrollTop: opts.scrollTop ?? 0,
    getBoundingClientRect: () => opts.view,
    querySelector: (sel: string) => (sel === '[aria-current="true"]' && opts.row ? rect(opts.row) : null),
    querySelectorAll: (sel: string) => (sel === "[data-sticky-head]" ? (opts.heads ?? []).map(rect) : []),
  }
  return list
}
const asEl = (l: unknown) => l as HTMLElement

describe("scrollActiveIntoView", () => {
  it("没有列表、或没有选中行：什么也不做", () => {
    expect(() => scrollActiveIntoView(null)).not.toThrow()
    const list = fakeList({ view: { top: 0, bottom: 300 }, scrollTop: 20 })
    scrollActiveIntoView(asEl(list))
    expect(list.scrollTop).toBe(20)
  })

  it("选中行在下沿之外：只改这个列表的 scrollTop", () => {
    const list = fakeList({ view: { top: 0, bottom: 300 }, row: { top: 320, bottom: 360 }, scrollTop: 10 })
    scrollActiveIntoView(asEl(list))
    expect(list.scrollTop).toBe(70)
  })

  it("选中行已经看得见：scrollTop 不动", () => {
    const list = fakeList({ view: { top: 0, bottom: 300 }, row: { top: 100, bottom: 140 }, scrollTop: 10 })
    scrollActiveIntoView(asEl(list))
    expect(list.scrollTop).toBe(10)
  })

  it("表头粘在上沿时，被它盖住的选中行要多滚出表头那么高", () => {
    const list = fakeList({
      view: { top: 0, bottom: 300 },
      row: { top: 20, bottom: 60 },
      heads: [{ top: 0, bottom: 46 }],
      scrollTop: 200,
    })
    scrollActiveIntoView(asEl(list))
    expect(list.scrollTop).toBe(174)
  })

  it("还没粘住的表头（在可视区中间）不算占位", () => {
    const list = fakeList({
      view: { top: 0, bottom: 300 },
      row: { top: 20, bottom: 60 },
      heads: [{ top: 150, bottom: 196 }],
      scrollTop: 200,
    })
    scrollActiveIntoView(asEl(list))
    expect(list.scrollTop).toBe(200)
  })
})
