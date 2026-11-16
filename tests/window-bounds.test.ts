import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  buildSavedBounds,
  DEFAULT_WINDOW_SIZE,
  findSavedDisplay,
  resolveWindowPlacement,
  toSavedDisplay,
  type DisplayLike,
  type Rect,
  type SavedWindowBounds,
  type SnapshotInput,
} from "../electron/window-bounds"

/** 主屏（屏幕一） */
const D1: DisplayLike = {
  id: 100,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
}
/** 右边的副屏（屏幕二）：和这台开发机的实际布局一致，纵向错开 3px */
const D2: DisplayLike = {
  id: 200,
  bounds: { x: 1920, y: 3, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 3, width: 1920, height: 1032 },
}
/** 主屏左边的屏：虚拟桌面里 x 是负数 */
const DL: DisplayLike = {
  id: 300,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1032 },
}

/** 窗口是一块 900×680，在主屏居中：旧版本一直把最大化窗口存成这个值 */
const CENTERED_ON_D1: Rect = { x: 510, y: 176, width: 900, height: 680 }

function saved(over: Partial<SavedWindowBounds> = {}): SavedWindowBounds {
  return { ...CENTERED_ON_D1, maximized: false, ...over }
}

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** 系统会把窗口算在哪块屏上：交集最大的那块（和 Windows 的 MonitorFromWindow 一致） */
function displayOf(r: Rect, displays: DisplayLike[]): DisplayLike {
  return displays.reduce((best, d) => (intersection(r, d.bounds) > intersection(r, best.bounds) ? d : best))
}

function rectOf(p: { x?: number; y?: number; width: number; height: number }): Rect {
  return { x: p.x ?? 0, y: p.y ?? 0, width: p.width, height: p.height }
}

describe("还原窗口位置：存的东西不可信时回落默认", () => {
  const fallback = { ...DEFAULT_WINDOW_SIZE, maximize: false }

  it("从没存过：默认大小、不指定位置、不最大化", () => {
    expect(resolveWindowPlacement(undefined, [D1, D2])).toEqual(fallback)
  })

  it("存的值不是有限数字（手改坏了）：当没存过", () => {
    expect(resolveWindowPlacement(saved({ x: Number.NaN }), [D1])).toEqual(fallback)
    expect(resolveWindowPlacement(saved({ width: Number.POSITIVE_INFINITY }), [D1])).toEqual(fallback)
    expect(resolveWindowPlacement(saved({ maximized: true, y: Number.NaN }), [D1])).toEqual(fallback)
  })

  it("窗口小到不合理（宽 < 400 或高 < 300）：当没存过，连最大化也不带", () => {
    expect(resolveWindowPlacement(saved({ width: 399 }), [D1])).toEqual(fallback)
    expect(resolveWindowPlacement(saved({ height: 299, maximized: true }), [D1])).toEqual(fallback)
  })

  it("刚好 400×300 是允许的最小值：照常还原，不回落", () => {
    expect(resolveWindowPlacement(saved({ width: 400, height: 300 }), [D1])).toEqual({ ...CENTERED_ON_D1, width: 400, height: 300, maximize: false })
    expect(resolveWindowPlacement(saved({ width: 400, height: 300, maximized: true }), [D1]).maximize).toBe(true)
  })
})

describe("还原窗口位置：没最大化", () => {
  it("位置看得见：原样放回", () => {
    const s = saved({ x: 100, y: 80, width: 1000, height: 700 })
    expect(resolveWindowPlacement(s, [D1, D2])).toEqual({ x: 100, y: 80, width: 1000, height: 700, maximize: false })
  })

  it("在副屏上：副屏的位置原样放回", () => {
    const s = saved({ x: 2500, y: 200 })
    expect(resolveWindowPlacement(s, [D1, D2])).toEqual({ x: 2500, y: 200, width: 900, height: 680, maximize: false })
  })

  it("在主屏左边的屏上（负坐标）：原样放回", () => {
    const s = saved({ x: -1500, y: 100 })
    expect(resolveWindowPlacement(s, [DL, D1])).toEqual({ x: -1500, y: 100, width: 900, height: 680, maximize: false })
  })

  it("副屏拔掉后位置看不见：回落默认，不会开到看不见的地方", () => {
    expect(resolveWindowPlacement(saved({ x: 2500, y: 200 }), [D1])).toEqual({ ...DEFAULT_WINDOW_SIZE, maximize: false })
  })

  it("只蹭到屏幕边缘不算看得见（重叠不足 50px）", () => {
    // 窗口 x=1890..2790，和主屏只重叠 30px；副屏拔了
    expect(resolveWindowPlacement(saved({ x: 1890, y: 100 }), [D1])).toEqual({ ...DEFAULT_WINDOW_SIZE, maximize: false })
  })
})

describe("还原窗口位置：最大化——要回到记下的那块屏（这就是「重启后跑到屏幕一」的 bug）", () => {
  it("记着屏幕二、还原位置在屏幕一：窗口放到屏幕二的可用范围里居中，再最大化", () => {
    // 这台机器上实际存的就是这样：还原位置是主屏居中的值，最大化在屏幕二
    const s = saved({ maximized: true, display: toSavedDisplay(D2) })
    const p = resolveWindowPlacement(s, [D1, D2])
    expect(p.maximize).toBe(true)
    expect(p).toMatchObject({ x: 2430, y: 179, width: 900, height: 680 })
    // 系统会把它最大化到屏幕二
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D2)
  })

  it("最大化时必须带上位置：不带位置，系统只会把它摆在主屏", () => {
    const p = resolveWindowPlacement(saved({ maximized: true, display: toSavedDisplay(D2) }), [D1, D2])
    expect(p.x).toBeDefined()
    expect(p.y).toBeDefined()
  })

  it("还原位置本来就在记下的那块屏上：原样放回，不动它", () => {
    const s = saved({ x: 2100, y: 60, maximized: true, display: toSavedDisplay(D2) })
    expect(resolveWindowPlacement(s, [D1, D2])).toEqual({ x: 2100, y: 60, width: 900, height: 680, maximize: true })
  })

  it("还原位置只有一小条蹭到记下的屏（超过 50px 但不到一半）：照样居中到那块屏，不然会被系统最大化到另一块", () => {
    // 窗口 x=1200..2100，在屏幕二上只有 180px 宽（20%），大半在屏幕一；原样放回的话会最大化到屏幕一
    const s = saved({ x: 1200, y: 100, maximized: true, display: toSavedDisplay(D2) })
    expect(displayOf({ x: 1200, y: 100, width: 900, height: 680 }, [D1, D2])).toBe(D1)
    const p = resolveWindowPlacement(s, [D1, D2])
    expect(p).toMatchObject({ x: 2430, y: 179 })
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D2)
  })

  it("还原位置在记下的屏上占了一多半：原样放回（不必居中）", () => {
    // 窗口 x=1500..2400，在屏幕二上 480px，超过一半
    const s = saved({ x: 1500, y: 100, maximized: true, display: toSavedDisplay(D2) })
    const p = resolveWindowPlacement(s, [D1, D2])
    expect(p).toEqual({ x: 1500, y: 100, width: 900, height: 680, maximize: true })
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D2)
  })

  it("记着主屏：照样放在主屏", () => {
    const s = saved({ x: 2100, y: 60, maximized: true, display: toSavedDisplay(D1) })
    const p = resolveWindowPlacement(s, [D1, D2])
    expect(p.maximize).toBe(true)
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D1)
  })

  it("记着主屏左边的屏（负坐标）：放过去", () => {
    const s = saved({ maximized: true, display: toSavedDisplay(DL) })
    const p = resolveWindowPlacement(s, [DL, D1, D2])
    expect(p.maximize).toBe(true)
    expect(p).toMatchObject({ x: -1410, y: 176 })
    expect(displayOf(rectOf(p), [DL, D1, D2])).toBe(DL)
  })

  it("显示器编号互换了（重启或换驱动后常见）但左右位置没变：按位置找，不按编号", () => {
    // 存的时候「右边那块」编号是 200；现在系统把编号 200 给了左边的屏、右边的屏变成 999
    const swappedD1: DisplayLike = { ...D1, id: 200 }
    const swappedD2: DisplayLike = { ...D2, id: 999 }
    const s = saved({ maximized: true, display: toSavedDisplay(D2) })
    const p = resolveWindowPlacement(s, [swappedD1, swappedD2])
    expect(displayOf(rectOf(p), [swappedD1, swappedD2])).toBe(swappedD2)
  })

  it("用户重新排过屏幕（范围变了）但这块屏的编号还在：退回按编号找", () => {
    const movedD2: DisplayLike = {
      id: 200,
      bounds: { x: 0, y: -1080, width: 1920, height: 1080 },
      workArea: { x: 0, y: -1080, width: 1920, height: 1040 },
    }
    const s = saved({ maximized: true, display: toSavedDisplay(D2) })
    const p = resolveWindowPlacement(s, [D1, movedD2])
    expect(displayOf(rectOf(p), [D1, movedD2])).toBe(movedD2)
  })

  it("任务栏在屏幕上方（可用范围有偏移）：居中按可用范围算，不压到任务栏下面", () => {
    const withTopBar: DisplayLike = {
      id: 400,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1920, y: 40, width: 1920, height: 1040 },
    }
    const s = saved({ maximized: true, display: toSavedDisplay(withTopBar) })
    const p = resolveWindowPlacement(s, [D1, withTopBar])
    expect(p.y).toBe(40 + Math.round((1040 - 680) / 2))
  })

  it("记下的窗口比那块屏的可用范围还大：缩到刚好放下", () => {
    const small: DisplayLike = {
      id: 500,
      bounds: { x: 1920, y: 0, width: 1280, height: 720 },
      workArea: { x: 1920, y: 0, width: 1280, height: 680 },
    }
    const s = saved({ width: 1600, height: 900, maximized: true, display: toSavedDisplay(small) })
    const p = resolveWindowPlacement(s, [D1, small])
    expect(p).toMatchObject({ x: 1920, y: 0, width: 1280, height: 680, maximize: true })
  })
})

describe("还原窗口位置：最大化——找不到记下的屏", () => {
  it("旧版本存的（没有显示器这一项）、还原位置在副屏上：放在原处，最大化到那块屏", () => {
    const s = saved({ x: 2500, y: 200, maximized: true })
    const p = resolveWindowPlacement(s, [D1, D2])
    expect(p).toEqual({ x: 2500, y: 200, width: 900, height: 680, maximize: true })
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D2)
  })

  it("旧版本存的、还原位置在主屏：和以前一样最大化在主屏", () => {
    const p = resolveWindowPlacement(saved({ maximized: true }), [D1, D2])
    expect(p.maximize).toBe(true)
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D1)
  })

  it("记下的屏拔掉了、还原位置也看不见：不指定位置（系统摆在主屏），但仍然最大化，也保留还原后的大小", () => {
    const s = saved({ x: 2500, y: 200, width: 1100, height: 750, maximized: true, display: toSavedDisplay(D2) })
    const p = resolveWindowPlacement(s, [D1])
    expect(p).toEqual({ width: 1100, height: 750, maximize: true })
    expect("x" in p).toBe(false)
  })

  it("记下的屏拔掉了、但还原位置在剩下的屏上看得见：放在原处最大化", () => {
    const s = saved({ maximized: true, display: toSavedDisplay(D2) })
    const p = resolveWindowPlacement(s, [D1])
    expect(p).toEqual({ ...CENTERED_ON_D1, maximize: true })
  })

  it("maximized 不是 true（缺字段）：不当成最大化", () => {
    const s = { ...CENTERED_ON_D1 } as unknown as SavedWindowBounds
    expect(resolveWindowPlacement(s, [D1, D2]).maximize).toBe(false)
  })
})

describe("找回存下来的显示器", () => {
  it("范围优先于编号", () => {
    const a: DisplayLike = { ...D1, id: 2 }
    const b: DisplayLike = { ...D2, id: 1 }
    expect(findSavedDisplay({ id: 1, ...D1.bounds }, [a, b])).toBe(a)
  })

  it("范围对不上才比编号；都对不上返回 undefined", () => {
    expect(findSavedDisplay({ id: 100, x: 5, y: 5, width: 800, height: 600 }, [D1, D2])).toBe(D1)
    expect(findSavedDisplay({ id: 7, x: 5, y: 5, width: 800, height: 600 }, [D1, D2])).toBeUndefined()
  })

  it("没存过或存的不是有限数字：undefined", () => {
    expect(findSavedDisplay(undefined, [D1])).toBeUndefined()
    expect(findSavedDisplay({ id: 100, x: Number.NaN, y: 0, width: 1920, height: 1080 }, [D1])).toBeUndefined()
  })
})

describe("落盘：记下窗口所在的显示器和最大化状态", () => {
  const normal = { x: 300, y: 120, width: 1000, height: 700 }

  /** 默认是「没最小化、没最大化、之前什么都没记过」，每个用例只写它关心的那几项 */
  function snap(over: Partial<SnapshotInput> = {}): SavedWindowBounds {
    return buildSavedBounds({
      normal,
      maximized: false,
      minimized: false,
      display: undefined,
      previousMaximized: false,
      previousDisplay: undefined,
      ...over,
    })
  }

  it("记下当前所在的显示器，还原位置和最大化原样记", () => {
    expect(snap({ maximized: true, display: D2 })).toEqual({
      ...normal,
      maximized: true,
      display: { id: 200, x: 1920, y: 3, width: 1920, height: 1080 },
    })
  })

  it("没最大化也记（窗口的位置本身就能还原，显示器只在最大化时用，记着不碍事）", () => {
    const s = snap({ display: D1 })
    expect(s.maximized).toBe(false)
    expect(s.display).toEqual(toSavedDisplay(D1))
  })

  it("没最大化、也没读到显示器、之前也没记过：不带显示器这一项", () => {
    expect("display" in snap()).toBe(false)
  })

  it("读不到当前显示器时沿用上一次的", () => {
    const prev = toSavedDisplay(D2)
    expect(snap({ previousDisplay: prev }).display).toEqual(prev)
  })

  describe("最小化时窗口自己报的状态不可靠（最大化的窗口一最小化，isMaximized() 就变 false）", () => {
    it("沿用上一次的最大化状态：最大化的窗口被最小化后落盘，仍记为最大化", () => {
      // Electron 在 Windows 上实测：最小化时 isMaximized() === false，getBounds() 是还原矩形
      const s = snap({ minimized: true, maximized: false, previousMaximized: true, previousDisplay: toSavedDisplay(D2) })
      expect(s.maximized).toBe(true)
    })

    it("没最大化的窗口被最小化：仍记为没最大化", () => {
      expect(snap({ minimized: true, maximized: false, previousMaximized: false }).maximized).toBe(false)
    })

    it("最小化时就算窗口谎报了 true，也以上一次为准", () => {
      expect(snap({ minimized: true, maximized: true, previousMaximized: false }).maximized).toBe(false)
    })

    it("沿用上一次记下的显示器，不去读当前的（最小化后的位置不代表它在哪块屏上）", () => {
      const prev = toSavedDisplay(D2)
      expect(snap({ minimized: true, display: D1, previousMaximized: true, previousDisplay: prev }).display).toEqual(prev)
    })

    it("从没记过显示器：不带这一项", () => {
      expect("display" in snap({ minimized: true, previousMaximized: true })).toBe(false)
    })

    it("没最小化时以窗口当前的状态为准（用户把窗口还原了就是还原了）", () => {
      expect(snap({ maximized: false, previousMaximized: true }).maximized).toBe(false)
      expect(snap({ maximized: true, previousMaximized: false }).maximized).toBe(true)
    })

    it("还原位置照常取窗口给的（最小化时 getNormalBounds 仍然是对的）", () => {
      const s = snap({ minimized: true, previousMaximized: true })
      expect(s).toMatchObject(normal)
    })
  })
})

describe("记下再还原：连续重启不会漂回主屏", () => {
  /** 模拟一次「启动 → 窗口按 placement 创建 → 防抖落盘」；最大化不改变还原矩形，窗口落在 placement 所在的屏上 */
  function restart(state: SavedWindowBounds, displays: DisplayLike[]): SavedWindowBounds {
    const p = resolveWindowPlacement(state, displays)
    const rect = rectOf(p)
    return buildSavedBounds({
      normal: rect,
      maximized: p.maximize,
      minimized: false,
      display: displayOf(rect, displays),
      previousMaximized: state.maximized,
      previousDisplay: state.display,
    })
  }

  /** 用户在 display 上最大化窗口后第一次落盘 */
  function firstSave(display: DisplayLike): SavedWindowBounds {
    return buildSavedBounds({
      normal: CENTERED_ON_D1,
      maximized: true,
      minimized: false,
      display,
      previousMaximized: false,
      previousDisplay: undefined,
    })
  }

  it.each([
    ["屏幕一", D1],
    ["屏幕二", D2],
    ["左边的屏", DL],
  ])("在%s上最大化后连续重启 5 次，每次都还在那块屏上", (_name, target) => {
    const displays = [DL, D1, D2]
    // 第一次：用户在 target 上最大化，还原矩形是主屏居中的值（最容易出错的组合）
    let state = firstSave(target)
    for (let i = 0; i < 5; i++) {
      const p = resolveWindowPlacement(state, displays)
      expect(p.maximize).toBe(true)
      expect(displayOf(rectOf(p), displays)).toBe(target)
      state = restart(state, displays)
      expect(state.display).toEqual(toSavedDisplay(target))
    }
  })

  it("还原矩形在第一次重启后稳定下来，后面不再变", () => {
    const displays = [D1, D2]
    let state = firstSave(D2)
    state = restart(state, displays)
    const settled = { x: state.x, y: state.y, width: state.width, height: state.height }
    for (let i = 0; i < 3; i++) {
      state = restart(state, displays)
      expect({ x: state.x, y: state.y, width: state.width, height: state.height }).toEqual(settled)
    }
  })

  it("在屏幕二最大化后又最小化、窗口最小化着退出（此时它自己报 isMaximized=false）：重启后仍在屏幕二最大化", () => {
    const displays = [D1, D2]
    const maximizedOnD2 = firstSave(D2)
    // 最小化后 Electron 报的：没最大化、位置是还原矩形；落盘必须沿用上一次的最大化状态和显示器
    const whileMinimized = buildSavedBounds({
      normal: { x: 2430, y: 179, width: 900, height: 680 },
      maximized: false,
      minimized: true,
      display: undefined,
      previousMaximized: maximizedOnD2.maximized,
      previousDisplay: maximizedOnD2.display,
    })
    const p = resolveWindowPlacement(whileMinimized, displays)
    expect(p.maximize).toBe(true)
    expect(displayOf(rectOf(p), displays)).toBe(D2)
  })

  it("副屏拔掉后重启：回到主屏最大化；再接回副屏，不会自动跑回去（记的是最近一次所在的屏）", () => {
    let state = firstSave(D2)
    state = restart(state, [D1])
    expect(state.maximized).toBe(true)
    expect(state.display).toEqual(toSavedDisplay(D1))
    const p = resolveWindowPlacement(state, [D1, D2])
    expect(displayOf(rectOf(p), [D1, D2])).toBe(D1)
  })
})

describe("主进程接线（读源码：这些地方被改回去，bug 就回来了）", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n")
  const main = read("electron/main.ts")

  it("创建窗口时位置不再按「是不是最大化」取舍：只要算出了位置就传给 BrowserWindow", () => {
    expect(main).toMatch(/placement\.x !== undefined && placement\.y !== undefined \? \{ x: placement\.x, y: placement\.y \} : \{\}/)
    expect(main).not.toMatch(/saved && !saved\.maximized \? \{ x: saved\.x/)
  })

  it("位置和是否最大化都来自 resolveWindowPlacement", () => {
    expect(main).toContain("resolveWindowPlacement(saved, screen.getAllDisplays())")
    expect(main).toMatch(/if \(placement\.maximize\) mainWindow\.maximize\(\)/)
    expect(main).not.toMatch(/if \(saved\?\.maximized\) mainWindow\.maximize\(\)/)
  })

  it("落盘走 buildSavedBounds：带上当前所在的显示器，最小化时沿用上一次的", () => {
    expect(main).toContain("buildSavedBounds({")
    expect(main).toContain("screen.getDisplayMatching(win.getBounds())")
    expect(main).toContain("previousDisplay: lastDisplay")
    expect(main).toContain("previousMaximized: lastMaximized")
    expect(main).toContain("trackWindowBounds(mainWindow, { maximized: placement.maximize, display: saved?.display })")
    // 每次落盘后更新「上一次」，最小化时才有可靠的值可沿用
    expect(main).toContain("lastDisplay = next.display")
    expect(main).toContain("lastMaximized = next.maximized")
  })

  it("最大化/还原也触发落盘（把最大化的窗口用快捷键送到另一块屏时，要重新记）", () => {
    expect(main).toMatch(/win\.on\("maximize", schedule\)/)
    expect(main).toMatch(/win\.on\("unmaximize", schedule\)/)
    expect(main).toMatch(/win\.on\("move", schedule\)/)
    expect(main).toMatch(/win\.on\("resize", schedule\)/)
  })

  it("配置里的 windowBounds 类型带显示器", () => {
    expect(read("electron/config-store.ts")).toMatch(/windowBounds\?: SavedWindowBounds/)
  })
})
