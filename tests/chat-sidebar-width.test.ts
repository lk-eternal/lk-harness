import { describe, expect, it, vi } from "vitest"
import type { StorageLike } from "../src/renderer/components/chat/sidebar-state"
import {
  clampPreviewWidth, clampSidebarWidth, createSidebarDrag, createSidebarWidthStore, DEFAULT_SIDEBAR_WIDTH, draggedSidebarWidth, loadSidebarWidth,
  maxPreviewWidth, maxSidebarWidth, MAX_SIDEBAR_WIDTH, MIN_CHAT_WIDTH, MIN_PANEL_WIDTH, MIN_SIDEBAR_WIDTH, saveSidebarWidth,
  SIDEBAR_KEY_STEP, shownSidebarWidth, steppedSidebarWidth,
} from "../src/renderer/components/chat/sidebar-width"

const KEY = "lk.chat.sidebarWidth"

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string>; writes: number } {
  const data = { ...initial }
  const s = {
    data,
    writes: 0,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; s.writes++ },
  }
  return s
}

const brokenStorage: StorageLike = {
  getItem: () => { throw new Error("denied") },
  setItem: () => { throw new Error("denied") },
}

describe("会话栏宽度的范围", () => {
  it("最窄就是默认宽度：只能往宽调", () => {
    expect(MIN_SIDEBAR_WIDTH).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(240)
  })

  it("预览面板没展开：最宽到上限；窗口窄了就让给对话区", () => {
    expect(maxSidebarWidth(1600, false)).toBe(MAX_SIDEBAR_WIDTH)
    expect(maxSidebarWidth(MIN_CHAT_WIDTH + MAX_SIDEBAR_WIDTH, false)).toBe(MAX_SIDEBAR_WIDTH)
    expect(maxSidebarWidth(MIN_CHAT_WIDTH + MAX_SIDEBAR_WIDTH - 1, false)).toBe(MAX_SIDEBAR_WIDTH - 1)
    expect(maxSidebarWidth(700, false)).toBe(700 - MIN_CHAT_WIDTH)
    expect(maxSidebarWidth(600, false)).toBe(300)
  })

  it("预览面板展开着：还要给它留最小宽度", () => {
    expect(maxSidebarWidth(1600, true)).toBe(MAX_SIDEBAR_WIDTH)
    expect(maxSidebarWidth(1000, true)).toBe(1000 - MIN_CHAT_WIDTH - MIN_PANEL_WIDTH)
    expect(maxSidebarWidth(900, true)).toBe(900 - MIN_CHAT_WIDTH - MIN_PANEL_WIDTH)
  })

  it("窗口窄到连最小宽度都放不下：就是最窄，不会比默认还窄", () => {
    expect(maxSidebarWidth(780, true)).toBe(MIN_SIDEBAR_WIDTH)
    expect(maxSidebarWidth(500, false)).toBe(MIN_SIDEBAR_WIDTH)
    expect(maxSidebarWidth(0, true)).toBe(MIN_SIDEBAR_WIDTH)
  })

  it("宽度收进 [最窄, 最宽] 里", () => {
    expect(clampSidebarWidth(100, 1600, false)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(300, 1600, false)).toBe(300)
    expect(clampSidebarWidth(9999, 1600, false)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it("存着很宽、窗口缩小了：显示收窄；窗口放大后又回到存着的宽度", () => {
    expect(clampSidebarWidth(480, 1600, true)).toBe(480)
    expect(clampSidebarWidth(480, 900, true)).toBe(280)
    expect(clampSidebarWidth(480, 1600, true)).toBe(480)
  })

  it("收起时不占宽度，不管存着多少", () => {
    expect(shownSidebarWidth(400, 1600, false, true)).toBe(0)
    expect(shownSidebarWidth(400, 1600, false, false)).toBe(400)
  })
})

describe("会话栏和预览面板互相让位", () => {
  it("会话栏是默认宽度、没收起时：和原来写死 240 的算法完全一样", () => {
    const old = (width: number, windowWidth: number) =>
      Math.min(Math.max(width, 320), Math.max(320, windowWidth - (240 + 300)))
    for (const windowWidth of [780, 860, 900, 1000, 1280, 1920, 2560]) {
      for (const width of [100, 320, 520, 700, 1000, 3000]) {
        expect(clampPreviewWidth(width, windowWidth, 240)).toBe(old(width, windowWidth))
      }
    }
  })

  it("会话栏拖宽了：面板最宽相应变小，但不会比最小宽度更小", () => {
    expect(maxPreviewWidth(1200, 240)).toBe(660)
    expect(maxPreviewWidth(1200, 400)).toBe(500)
    expect(maxPreviewWidth(800, 480)).toBe(MIN_PANEL_WIDTH)
  })

  it("会话栏收起（占 0）：面板能用上这块地方", () => {
    expect(maxPreviewWidth(1200, 0)).toBe(900)
  })

  it("只要窗口放得下三块的最小宽度：会话栏 + 面板 + 对话区的最小宽度不超过窗口", () => {
    for (let windowWidth = MIN_SIDEBAR_WIDTH + MIN_PANEL_WIDTH + MIN_CHAT_WIDTH; windowWidth <= 2400; windowWidth += 20) {
      for (const stored of [MIN_SIDEBAR_WIDTH, 300, 400, MAX_SIDEBAR_WIDTH]) {
        for (const panel of [MIN_PANEL_WIDTH, 520, 900, 5000]) {
          const sidebar = shownSidebarWidth(stored, windowWidth, true, false)
          expect(sidebar + clampPreviewWidth(panel, windowWidth, sidebar) + MIN_CHAT_WIDTH).toBeLessThanOrEqual(windowWidth)
        }
      }
    }
  })
})

describe("拖动和键盘调整", () => {
  it("往右拖变宽，往左拖变窄，距离一一对应", () => {
    expect(draggedSidebarWidth(240, 240, 300, 1600, false)).toBe(300)
    expect(draggedSidebarWidth(300, 500, 460, 1600, false)).toBe(260)
  })

  it("往左拖不会比最窄更窄，往右拖不会超过最宽", () => {
    expect(draggedSidebarWidth(240, 240, 0, 1600, false)).toBe(MIN_SIDEBAR_WIDTH)
    expect(draggedSidebarWidth(240, 240, 5000, 1600, false)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it("预览面板展开着：拖不过给它留的位置", () => {
    expect(draggedSidebarWidth(240, 240, 5000, 1000, true)).toBe(1000 - MIN_CHAT_WIDTH - MIN_PANEL_WIDTH)
  })

  it("起点是显示出来的宽度，不是存着的：存着 480、显示被收到 280 时，从 280 开始拖", () => {
    const shown = clampSidebarWidth(480, 900, true)
    expect(shown).toBe(280)
    // 指针往左挪 10px，栏就从 280 变成 270；要是误把存着的 480 当起点，会算出 470 再收回 280，一动不动
    expect(draggedSidebarWidth(shown, 280, 270, 900, true)).toBe(270)
    expect(draggedSidebarWidth(480, 280, 270, 900, true)).toBe(280)
  })

  it("键盘：右键变宽、左键变窄，每次一个步长，同样受范围限制", () => {
    expect(steppedSidebarWidth(300, 1, 1600, false)).toBe(300 + SIDEBAR_KEY_STEP)
    expect(steppedSidebarWidth(300, -1, 1600, false)).toBe(300 - SIDEBAR_KEY_STEP)
    expect(steppedSidebarWidth(MIN_SIDEBAR_WIDTH, -1, 1600, false)).toBe(MIN_SIDEBAR_WIDTH)
    expect(steppedSidebarWidth(MAX_SIDEBAR_WIDTH, 1, 1600, false)).toBe(MAX_SIDEBAR_WIDTH)
  })
})

describe("宽度的记忆", () => {
  it("没存过：默认宽度", () => {
    expect(loadSidebarWidth(memoryStorage())).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it("存了：下次还是这个宽度", () => {
    const s = memoryStorage()
    saveSidebarWidth(360, s)
    expect(s.data[KEY]).toBe("360")
    expect(loadSidebarWidth(s)).toBe(360)
  })

  it("存的是小数：取整", () => {
    expect(loadSidebarWidth(memoryStorage({ [KEY]: "311.6" }))).toBe(312)
    const s = memoryStorage()
    saveSidebarWidth(311.4, s)
    expect(s.data[KEY]).toBe("311")
  })

  it("存的超出范围：收回范围内", () => {
    expect(loadSidebarWidth(memoryStorage({ [KEY]: "100" }))).toBe(MIN_SIDEBAR_WIDTH)
    expect(loadSidebarWidth(memoryStorage({ [KEY]: "99999" }))).toBe(MAX_SIDEBAR_WIDTH)
  })

  it("存的不是正数、不是数字：用默认宽度", () => {
    for (const bad of ["", " ", "0", "-300", "abc", "NaN", "Infinity", "undefined"]) {
      expect(loadSidebarWidth(memoryStorage({ [KEY]: bad }))).toBe(DEFAULT_SIDEBAR_WIDTH)
    }
  })

  it("存储读不了、写不了：不抛错，用默认宽度", () => {
    expect(loadSidebarWidth(brokenStorage)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(() => saveSidebarWidth(300, brokenStorage)).not.toThrow()
  })

  it("没有存储可用（比如不在浏览器里）：不抛错", () => {
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(() => saveSidebarWidth(300)).not.toThrow()
  })
})

/** 假的「让位」登记：记下登记了几次、撤销了几次，没撤销的算泄漏 */
function fakeOverlay() {
  const state = { acquired: 0, released: 0 }
  return {
    state,
    acquireOverlay: () => {
      state.acquired++
      let done = false
      return () => { if (!done) { done = true; state.released++ } }
    },
  }
}

function setupDrag(opts: { windowWidth?: number; previewShown?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const storage = opts.storage ?? memoryStorage()
  const store = createSidebarWidthStore(storage)
  const overlay = fakeOverlay()
  const drag = createSidebarDrag({
    store,
    acquireOverlay: overlay.acquireOverlay,
    windowWidth: () => opts.windowWidth ?? 1600,
    previewShown: () => opts.previewShown ?? false,
  })
  return { storage, store, overlay, drag }
}

describe("一次拖动的全过程", () => {
  it("开始：登记一次让位，进入拖动状态", () => {
    const { drag, overlay } = setupDrag()
    expect(drag.active).toBe(false)
    expect(drag.start(240, 240)).toBe(true)
    expect(drag.active).toBe(true)
    expect(overlay.state).toEqual({ acquired: 1, released: 0 })
  })

  it("拖动中：宽度跟着指针变，但存储一次都不写", () => {
    const { drag, store, storage } = setupDrag()
    drag.start(240, 240)
    drag.move(260)
    expect(store.get()).toBe(260)
    drag.move(400)
    expect(store.get()).toBe(400)
    drag.move(300)
    expect(store.get()).toBe(300)
    expect(storage.writes).toBe(0)
  })

  it("松手：撤销让位，把最终宽度存一次", () => {
    const { drag, overlay, storage } = setupDrag()
    drag.start(240, 240)
    drag.move(350)
    expect(drag.end()).toBe(true)
    expect(drag.active).toBe(false)
    expect(overlay.state).toEqual({ acquired: 1, released: 1 })
    expect(storage.writes).toBe(1)
    expect(storage.data[KEY]).toBe("350")
  })

  it("松手、取消、捕获丢失会连着触发：只算结束一次，不重复撤销、不重复存", () => {
    const { drag, overlay, storage } = setupDrag()
    drag.start(240, 240)
    drag.move(350)
    expect(drag.end()).toBe(true)
    expect(drag.end()).toBe(false)
    expect(drag.end()).toBe(false)
    expect(overlay.state).toEqual({ acquired: 1, released: 1 })
    expect(storage.writes).toBe(1)
  })

  it("没在拖动时松手、移动：什么都不发生", () => {
    const { drag, overlay, store, storage } = setupDrag()
    expect(drag.end()).toBe(false)
    drag.move(500)
    expect(store.get()).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(overlay.state).toEqual({ acquired: 0, released: 0 })
    expect(storage.writes).toBe(0)
  })

  it("已经在拖动时再开始：忽略，不会重复登记让位（否则撤销一次就漏一次）", () => {
    const { drag, overlay } = setupDrag()
    expect(drag.start(240, 240)).toBe(true)
    expect(drag.start(300, 300)).toBe(false)
    expect(overlay.state.acquired).toBe(1)
    drag.end()
    expect(overlay.state).toEqual({ acquired: 1, released: 1 })
  })

  it("拖完还能再拖：每次各登记、各撤销一次", () => {
    const { drag, overlay, store } = setupDrag()
    drag.start(240, 240); drag.move(300); drag.end()
    drag.start(300, 300); drag.move(280); drag.end()
    expect(store.get()).toBe(280)
    expect(overlay.state).toEqual({ acquired: 2, released: 2 })
  })

  it("拖动中组件被卸载（dispose）：撤销让位，但不存；之后的移动、松手都不再生效", () => {
    const { drag, overlay, store, storage } = setupDrag()
    drag.start(240, 240)
    drag.move(320)
    drag.dispose()
    expect(overlay.state).toEqual({ acquired: 1, released: 1 })
    expect(storage.writes).toBe(0)
    drag.move(400)
    expect(store.get()).toBe(320)
    expect(drag.end()).toBe(false)
    expect(overlay.state.released).toBe(1)
  })

  it("没在拖动时 dispose：不会多撤销", () => {
    const { drag, overlay } = setupDrag()
    drag.dispose()
    expect(overlay.state).toEqual({ acquired: 0, released: 0 })
  })

  it("宽度范围按窗口和预览面板算：预览展开着、窗口 1000 宽，最宽到 380", () => {
    const { drag, store } = setupDrag({ windowWidth: 1000, previewShown: true })
    drag.start(240, 240)
    drag.move(5000)
    expect(store.get()).toBe(380)
    drag.move(-5000)
    expect(store.get()).toBe(MIN_SIDEBAR_WIDTH)
  })

  it("预览面板是否展开读的是拖动当时的值，不是开始那一刻的", () => {
    let shown = false
    const store = createSidebarWidthStore(memoryStorage())
    const drag = createSidebarDrag({ store, acquireOverlay: fakeOverlay().acquireOverlay, windowWidth: () => 1000, previewShown: () => shown })
    drag.start(240, 240)
    drag.move(5000)
    expect(store.get()).toBe(480)
    shown = true
    drag.move(5000)
    expect(store.get()).toBe(380)
  })

  it("起点用显示出来的宽度：从 280 起拖、指针往左 10px，栏变成 270", () => {
    const { drag, store } = setupDrag({ windowWidth: 900, previewShown: true })
    drag.start(280, 280)
    drag.move(270)
    expect(store.get()).toBe(270)
  })
})

describe("宽度 store", () => {
  it("一开始是存着的宽度", () => {
    expect(createSidebarWidthStore(memoryStorage({ [KEY]: "333" })).get()).toBe(333)
    expect(createSidebarWidthStore(memoryStorage()).get()).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it("拖动中（preview）：值变了、订阅者收到通知，但不写存储", () => {
    const s = memoryStorage()
    const store = createSidebarWidthStore(s)
    const listener = vi.fn()
    store.subscribe(listener)
    for (const w of [250, 260, 270, 280]) store.preview(w)
    expect(store.get()).toBe(280)
    expect(listener).toHaveBeenCalledTimes(4)
    expect(s.writes).toBe(0)
  })

  it("定下来（commit）：写进存储；不传宽度就把当前值写进去", () => {
    const s = memoryStorage()
    const store = createSidebarWidthStore(s)
    store.preview(300)
    store.commit()
    expect(s.data[KEY]).toBe("300")
    store.commit(350)
    expect(store.get()).toBe(350)
    expect(s.data[KEY]).toBe("350")
  })

  it("拖动中途没存，下次启动还是上次定下来的宽度", () => {
    const s = memoryStorage()
    const first = createSidebarWidthStore(s)
    first.commit(300)
    first.preview(400)
    expect(createSidebarWidthStore(s).get()).toBe(300)
  })

  it("宽度没变：不通知，订阅者不会白白重绘", () => {
    const store = createSidebarWidthStore(memoryStorage())
    const listener = vi.fn()
    store.subscribe(listener)
    store.preview(DEFAULT_SIDEBAR_WIDTH)
    store.commit()
    expect(listener).not.toHaveBeenCalled()
  })

  it("小数取整、超出范围收回范围内", () => {
    const store = createSidebarWidthStore(memoryStorage())
    store.preview(300.4)
    expect(store.get()).toBe(300)
    store.preview(99999)
    expect(store.get()).toBe(MAX_SIDEBAR_WIDTH)
    store.preview(-5)
    expect(store.get()).toBe(MIN_SIDEBAR_WIDTH)
  })

  it("恢复默认：值回到默认并写进存储；本来就是默认也写（把之前存的覆盖掉）", () => {
    const s = memoryStorage({ [KEY]: "400" })
    const store = createSidebarWidthStore(s)
    store.reset()
    expect(store.get()).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(s.data[KEY]).toBe(String(DEFAULT_SIDEBAR_WIDTH))
    store.reset()
    expect(s.data[KEY]).toBe(String(DEFAULT_SIDEBAR_WIDTH))
  })

  it("取消订阅后不再收到通知；通知过程中取消订阅不影响别的订阅者", () => {
    const store = createSidebarWidthStore(memoryStorage())
    const a = vi.fn()
    const b = vi.fn()
    const offA = store.subscribe(() => { a(); offA() })
    store.subscribe(b)
    store.preview(300)
    store.preview(310)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it("存储写不了：值照样改，不抛错", () => {
    const store = createSidebarWidthStore(brokenStorage)
    expect(() => store.commit(300)).not.toThrow()
    expect(store.get()).toBe(300)
  })
})
