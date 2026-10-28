import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  FLICK_VELOCITY,
  HORIZONTAL_RATIO,
  LOCK_DISTANCE,
  canDrag,
  canScrollHorizontally,
  classifySwipe,
  findHorizontalScroller,
  opennessAfter,
  settleOpen,
  velocityOf,
} from "../src/mobile/drawer-swipe"

/**
 * 这里只测纯判定逻辑。触摸事件、样式、与浏览器滚动的配合要真实浏览器才说得清，
 * 由 Electron 里加载真实打包产物、用 CDP 发真实触摸事件的探针验证（不进仓库）。
 */

describe("classifySwipe：横滑还是竖滑", () => {
  it("没动够不下结论，避免把点按、手抖当手势", () => {
    expect(classifySwipe(0, 0)).toBe("pending")
    expect(classifySwipe(LOCK_DISTANCE - 1, 0)).toBe("pending")
    expect(classifySwipe(-(LOCK_DISTANCE - 1), LOCK_DISTANCE - 1)).toBe("pending")
  })

  it("基本水平 → 横滑，左右都一样", () => {
    expect(classifySwipe(LOCK_DISTANCE, 0)).toBe("horizontal")
    expect(classifySwipe(-40, 5)).toBe("horizontal")
  })

  it("竖着滚消息时拇指带点斜，不能当成开抽屉", () => {
    expect(classifySwipe(0, 30)).toBe("vertical")
    expect(classifySwipe(20, 30)).toBe("vertical")
    // 45 度也算竖滑：宁可让用户滑得平一点，也别在滚动时误开
    expect(classifySwipe(30, 30)).toBe("vertical")
  })

  it("按真实角度写死（不跟着常量走）：约 37° 的斜滑算竖滑，约 15° 的略斜横滑仍算横滑", () => {
    // 这两条把「阈值大概在哪」钉住：谁把比值调到 1.3 以下会让滚消息时误开抽屉，调到 4 以上会让正常横滑也开不了
    expect(classifySwipe(130, 100)).toBe("vertical")
    expect(classifySwipe(-130, 100)).toBe("vertical")
    expect(classifySwipe(230, 60)).toBe("horizontal")
    expect(classifySwipe(-230, -60)).toBe("horizontal")
  })

  it("横纵比刚好卡在阈值上：达到才算横滑", () => {
    expect(classifySwipe(HORIZONTAL_RATIO * 10, 10)).toBe("horizontal")
    expect(classifySwipe(HORIZONTAL_RATIO * 10 - 0.5, 10)).toBe("vertical")
  })
})

describe("canDrag：这次横滑对抽屉有没有意义", () => {
  it("全关时只有向右有意义，全开时只有向左有意义", () => {
    expect(canDrag(0, 30)).toBe(true)
    expect(canDrag(0, -30)).toBe(false)
    expect(canDrag(1, -30)).toBe(true)
    expect(canDrag(1, 30)).toBe(false)
  })

  it("动画走到一半时被按住，两个方向都能拖", () => {
    expect(canDrag(0.4, 30)).toBe(true)
    expect(canDrag(0.4, -30)).toBe(true)
  })
})

describe("opennessAfter", () => {
  it("按位移占抽屉宽度的比例变化", () => {
    expect(opennessAfter(0, 160, 320)).toBe(0.5)
    expect(opennessAfter(1, -80, 320)).toBe(0.75)
  })

  it("拖过头时夹在 0~1，不会把抽屉拖出屏幕或拉过头", () => {
    expect(opennessAfter(0, 900, 320)).toBe(1)
    expect(opennessAfter(1, -900, 320)).toBe(0)
  })

  it("宽度未知（0）时保持原位，不产生 NaN", () => {
    expect(opennessAfter(0.3, 100, 0)).toBe(0.3)
  })
})

describe("velocityOf", () => {
  it("向右快划为正、向左为负", () => {
    expect(velocityOf([{ x: 0, t: 0 }, { x: 30, t: 50 }])).toBeCloseTo(0.6)
    expect(velocityOf([{ x: 100, t: 0 }, { x: 70, t: 50 }])).toBeCloseTo(-0.6)
  })

  it("只看最近一小段：先慢后快，按末段算", () => {
    const slowThenFast = [
      { x: 0, t: 0 },
      { x: 5, t: 300 },
      { x: 10, t: 600 },
      { x: 40, t: 650 },
      { x: 80, t: 700 },
    ]
    expect(velocityOf(slowThenFast)).toBeGreaterThan(FLICK_VELOCITY)
  })

  it("手指停住一会儿再抬起：速度是 0，不能沿用停之前的速度", () => {
    const pausedThenLifted = [
      { x: 0, t: 0 },
      { x: 120, t: 100 },
      { x: 120, t: 400 },
    ]
    expect(velocityOf(pausedThenLifted)).toBe(0)
  })

  it("采样不足或间隔太短时不可信，当作 0", () => {
    expect(velocityOf([])).toBe(0)
    expect(velocityOf([{ x: 5, t: 0 }])).toBe(0)
    expect(velocityOf([{ x: 0, t: 0 }, { x: 50, t: 2 }])).toBe(0)
  })
})

describe("settleOpen：松手后去哪", () => {
  it("慢慢拖：过半就开，不过半就关", () => {
    expect(settleOpen(0.51, 0)).toBe(true)
    expect(settleOpen(0.49, 0)).toBe(false)
    expect(settleOpen(0.5, 0)).toBe(true)
  })

  it("快速一甩：顺着方向走，哪怕只拖了一点", () => {
    expect(settleOpen(0.1, FLICK_VELOCITY)).toBe(true)
    expect(settleOpen(0.9, -FLICK_VELOCITY)).toBe(false)
  })

  it("速度不够快就还是看位置", () => {
    expect(settleOpen(0.3, FLICK_VELOCITY - 0.05)).toBe(false)
    expect(settleOpen(0.7, -(FLICK_VELOCITY - 0.05))).toBe(true)
  })
})

describe("canScrollHorizontally：横向滚动区朝手指方向还有没有余地", () => {
  const box = (scrollLeft: number, scrollWidth = 600, clientWidth = 300) => ({ scrollLeft, scrollWidth, clientWidth })

  it("内容没溢出：不能滚", () => {
    expect(canScrollHorizontally(box(0, 300, 300), 30)).toBe(false)
    expect(canScrollHorizontally(box(0, 300.5, 300), -30)).toBe(false)
  })

  it("在最左端：手指右滑（内容回卷）没有余地，左滑有", () => {
    expect(canScrollHorizontally(box(0), 30)).toBe(false)
    expect(canScrollHorizontally(box(0), -30)).toBe(true)
  })

  it("在最右端：手指左滑没有余地，右滑有", () => {
    expect(canScrollHorizontally(box(300), -30)).toBe(false)
    expect(canScrollHorizontally(box(300), 30)).toBe(true)
  })

  it("中间：两个方向都有", () => {
    expect(canScrollHorizontally(box(120), 30)).toBe(true)
    expect(canScrollHorizontally(box(120), -30)).toBe(true)
  })

  it("亚像素误差不算还能滚", () => {
    expect(canScrollHorizontally(box(299.6), -30)).toBe(false)
  })
})

describe("findHorizontalScroller：触点到根之间有没有要让路的容器", () => {
  interface FakeEl {
    parentElement: FakeEl | null
    overflowX: string
    scrollLeft: number
    scrollWidth: number
    clientWidth: number
  }
  const el = (parent: FakeEl | null, over: Partial<FakeEl> = {}): FakeEl => ({
    parentElement: parent,
    overflowX: "visible",
    scrollLeft: 0,
    scrollWidth: 300,
    clientWidth: 300,
    ...over,
  })
  const find = (start: FakeEl, stop: FakeEl, dx: number) =>
    findHorizontalScroller(start as unknown as Element, stop as unknown as Element, dx)

  // node 里没有 getComputedStyle：用假元素自带的 overflowX 代替
  beforeEach(() => vi.stubGlobal("getComputedStyle", (e: FakeEl) => ({ overflowX: e.overflowX })))
  afterEach(() => vi.unstubAllGlobals())

  it("代码块还能向手指方向滚：让给它", () => {
    const root = el(null)
    const pre = el(root, { overflowX: "auto", scrollLeft: 50, scrollWidth: 900 })
    const code = el(pre)
    expect(find(code, root, 30)).toBe(pre)
    expect(find(code, root, -30)).toBe(pre)
  })

  it("代码块已在最左端，用户还往右滑：这时是想开抽屉，不让路", () => {
    const root = el(null)
    const pre = el(root, { overflowX: "auto", scrollLeft: 0, scrollWidth: 900 })
    expect(find(pre, root, 30)).toBeNull()
    expect(find(pre, root, -30)).toBe(pre)
  })

  it("overflow 不是 auto/scroll 的容器，哪怕内容溢出也不算", () => {
    const root = el(null)
    const box = el(root, { overflowX: "hidden", scrollLeft: 50, scrollWidth: 900 })
    expect(find(box, root, 30)).toBeNull()
  })

  it("只往上找到根为止，根之外的容器不管", () => {
    const outside = el(null, { overflowX: "auto", scrollLeft: 50, scrollWidth: 900 })
    const root = el(outside)
    const inner = el(root)
    expect(find(inner, root, 30)).toBeNull()
  })

  it("竖向滚动容器的 overflow-x 会被算成 auto，但没有横向溢出就不能当成要让路的", () => {
    const root = el(null)
    const list = el(root, { overflowX: "auto", scrollWidth: 300, clientWidth: 300 })
    expect(find(list, root, 30)).toBeNull()
  })
})
