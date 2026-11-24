import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { canDropOn, dropPlacement, pinDragRow, type Dragging, type DropOver, type PinDragActions } from "../src/renderer/components/chat/pin-drag"
import type { PinPlacement } from "../src/shared/app-chat-pins"

/** 会话栏里置顶的会话拖动换位置：谁能拖、能落在哪、松手时交给谁 */

const ZONE = "c1-chat"
const OTHER_ZONE = "c1-project"

function harness(initial: { dragging?: Dragging; over?: DropOver } = {}) {
  const st = { dragging: initial.dragging ?? null as Dragging | null, over: initial.over ?? null as DropOver | null }
  const moves: [string, string, PinPlacement][] = []
  const overSets: (DropOver | null)[] = []
  const actions: PinDragActions = {
    setDragging: (v) => { st.dragging = typeof v === "function" ? v(st.dragging) : v },
    setOver: (v) => {
      st.over = typeof v === "function" ? v(st.over) : v
      overSets.push(st.over)
    },
    move: (...args) => { moves.push(args) },
  }
  const row = (zone: string, key: string, pinned = true) => pinDragRow({ dragging: st.dragging, over: st.over }, actions, zone, key, pinned)
  return { st, moves, overSets, row }
}

/** 假的拖放事件：这一行从 top=100 开始、高 40，鼠标在 clientY */
function fakeEvent(clientY = 0, over: { contains?: boolean } = {}) {
  const dataTransfer = { effectAllowed: "", dropEffect: "", data: {} as Record<string, string>, setData(type: string, value: string) { this.data[type] = value } }
  const counts = { prevented: 0 }
  const e = {
    clientY,
    relatedTarget: null,
    dataTransfer,
    preventDefault: () => { counts.prevented++ },
    currentTarget: { getBoundingClientRect: () => ({ top: 100, height: 40 }), contains: () => over.contains ?? false },
  } as never
  return { e, dataTransfer, counts }
}

describe("拖到一行的哪一边", () => {
  it("上半边放到它前面，下半边放到它后面", () => {
    expect(dropPlacement(0, 40)).toBe("before")
    expect(dropPlacement(19, 40)).toBe("before")
    expect(dropPlacement(20, 40)).toBe("after")
    expect(dropPlacement(39, 40)).toBe("after")
  })
})

describe("能不能落在这一行", () => {
  const drag: Dragging = { key: "a", zone: ZONE }

  it("同一类里别的会话：可以", () => {
    expect(canDropOn(drag, ZONE, "b")).toBe(true)
  })

  it("别的类里的会话、自己、没有在拖：不行", () => {
    expect(canDropOn(drag, OTHER_ZONE, "b")).toBe(false)
    expect(canDropOn(drag, ZONE, "a")).toBe(false)
    expect(canDropOn(null, ZONE, "b")).toBe(false)
  })
})

describe("置顶的会话拖动：开始", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("没置顶的行：不能拖，也不响应任何拖放", () => {
    const { row } = harness({ dragging: { key: "a", zone: ZONE } })
    expect(row(ZONE, "b", false).props).toEqual({})
  })

  it("置顶的行：能拖", () => {
    expect(harness().row(ZONE, "a").props.draggable).toBe(true)
  })

  it("开始拖：标明是移动；记下谁在哪一类里拖，但晚一拍（要让浏览器先给这一行截图，影子才不是淡的）", () => {
    const { st, row } = harness()
    const { e, dataTransfer } = fakeEvent()
    row(ZONE, "a").props.onDragStart?.(e)
    expect(dataTransfer.effectAllowed).toBe("move")
    expect(dataTransfer.data["text/plain"]).toBe("a")
    expect(st.dragging).toBeNull()
    vi.runAllTimers()
    expect(st.dragging).toEqual({ key: "a", zone: ZONE })
  })
})

describe("置顶的会话拖动：经过别的行", () => {
  const dragging: Dragging = { key: "a", zone: ZONE }

  it("同一类里别的置顶会话：允许落下，记下落在这一行的哪一边（上半边在前、下半边在后）", () => {
    const { st, row } = harness({ dragging })
    const top = fakeEvent(105)
    row(ZONE, "b").props.onDragOver?.(top.e)
    expect(top.counts.prevented).toBe(1)
    expect(top.dataTransfer.dropEffect).toBe("move")
    expect(st.over).toEqual({ key: "b", placement: "before" })
    const bottom = fakeEvent(135)
    row(ZONE, "b").props.onDragOver?.(bottom.e)
    expect(st.over).toEqual({ key: "b", placement: "after" })
  })

  it("位置没变就不重复更新（鼠标在一行里动，浏览器每几十毫秒触发一次）", () => {
    const { overSets, row } = harness({ dragging, over: { key: "b", placement: "before" } })
    row(ZONE, "b").props.onDragOver?.(fakeEvent(105).e)
    expect(overSets).toEqual([])
  })

  it("别的类里的会话、自己、没在拖（比如拖进来一个文件）：不允许落下，也不画指示线", () => {
    const h = harness({ dragging })
    for (const [zone, key] of [[OTHER_ZONE, "b"], [ZONE, "a"]] as const) {
      const { e, counts } = fakeEvent(105)
      h.row(zone, key).props.onDragOver?.(e)
      expect(counts.prevented).toBe(0)
    }
    const idle = harness()
    const { e, counts } = fakeEvent(105)
    idle.row(ZONE, "b").props.onDragOver?.(e)
    expect(counts.prevented).toBe(0)
    expect(h.st.over).toBeNull()
    expect(idle.st.over).toBeNull()
  })

  it("真的离开这一行：清掉它的指示线；只是移进了行里的按钮：不清", () => {
    const h = harness({ dragging, over: { key: "b", placement: "after" } })
    h.row(ZONE, "b").props.onDragLeave?.(fakeEvent(0, { contains: true }).e)
    expect(h.st.over).toEqual({ key: "b", placement: "after" })
    h.row(ZONE, "b").props.onDragLeave?.(fakeEvent(0, { contains: false }).e)
    expect(h.st.over).toBeNull()
  })

  it("离开的不是指示线所在的那一行（先进了下一行再触发上一行的离开）：不动当前的指示线", () => {
    const h = harness({ dragging, over: { key: "c", placement: "before" } })
    h.row(ZONE, "b").props.onDragLeave?.(fakeEvent().e)
    expect(h.st.over).toEqual({ key: "c", placement: "before" })
  })
})

describe("置顶的会话拖动：松手", () => {
  const dragging: Dragging = { key: "a", zone: ZONE }

  it("落在同一类里别的置顶会话上：交给 move（谁、挪到谁的哪一边），并清掉拖动状态", () => {
    const h = harness({ dragging, over: { key: "b", placement: "after" } })
    const { e, counts } = fakeEvent(135)
    h.row(ZONE, "b").props.onDrop?.(e)
    expect(h.moves).toEqual([["a", "b", "after"]])
    expect(counts.prevented).toBe(1)
    expect(h.st.dragging).toBeNull()
    expect(h.st.over).toBeNull()
  })

  it("哪一边按松手时鼠标的位置算，不按上一次经过时记下的", () => {
    const h = harness({ dragging, over: { key: "b", placement: "after" } })
    h.row(ZONE, "b").props.onDrop?.(fakeEvent(102).e)
    expect(h.moves).toEqual([["a", "b", "before"]])
  })

  it("落在别的类里、自己身上：什么都不改，但拖动状态要清掉", () => {
    const h = harness({ dragging, over: { key: "b", placement: "after" } })
    h.row(OTHER_ZONE, "b").props.onDrop?.(fakeEvent(105).e)
    h.row(ZONE, "a").props.onDrop?.(fakeEvent(105).e)
    expect(h.moves).toEqual([])
    expect(h.st.dragging).toBeNull()
    expect(h.st.over).toBeNull()
  })

  it("没拖就松手（比如拖进来的是文件）：不管", () => {
    const h = harness()
    const { e, counts } = fakeEvent(105)
    h.row(ZONE, "b").props.onDrop?.(e)
    expect(h.moves).toEqual([])
    expect(counts.prevented).toBe(0)
  })

  it("拖到一半放弃（Esc、拖到窗口外）：拖动状态清掉", () => {
    const h = harness({ dragging, over: { key: "b", placement: "before" } })
    h.row(ZONE, "a").props.onDragEnd?.(fakeEvent().e)
    expect(h.moves).toEqual([])
    expect(h.st.dragging).toBeNull()
    expect(h.st.over).toBeNull()
  })
})

describe("拖动时每一行的样子", () => {
  it("被拖的那一行标记在拖；指示线只在落点那一行", () => {
    const h = harness({ dragging: { key: "a", zone: ZONE }, over: { key: "b", placement: "before" } })
    expect(h.row(ZONE, "a")).toMatchObject({ dragging: true, dropAt: undefined })
    expect(h.row(ZONE, "b")).toMatchObject({ dragging: false, dropAt: "before" })
    expect(h.row(ZONE, "c")).toMatchObject({ dragging: false, dropAt: undefined })
  })
})
