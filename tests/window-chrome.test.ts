import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  MAC_CONTROLS_INSET,
  MAC_TRAFFIC_LIGHT,
  TITLE_BAR_HEIGHT,
  titleBarLayout,
  windowChromeOptions,
} from "../src/shared/window-chrome"
import TitleBar, { TitleBarView } from "../src/renderer/components/TitleBar"

/**
 * 窗口外框按系统区分：macOS 用系统的红绿灯（左边、绿色是全屏），Windows / Linux 保持无边框 + 自绘按钮。
 * Mac 用户反馈的是：按钮在右边、「最大化」只是铺满屏幕、铺满后窗口还能拖。
 * 红绿灯是系统画的，这里测不到它长什么样；能测的是：选了什么窗口选项、标题栏有没有给它让位、自绘按钮有没有去掉。
 */

const ROOT = path.resolve(__dirname, "..")
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8")

describe("windowChromeOptions：创建窗口时的外框选项", () => {
  it("macOS：隐藏标题栏但保留红绿灯，不能是无边框（无边框就没有红绿灯了）", () => {
    const o = windowChromeOptions("darwin")
    expect(o).toMatchObject({ titleBarStyle: "hidden", trafficLightPosition: { x: MAC_TRAFFIC_LIGHT.x, y: MAC_TRAFFIC_LIGHT.y } })
    expect("frame" in o).toBe(false)
  })

  it("Windows / Linux：还是无边框，没有 macOS 的选项", () => {
    for (const p of ["win32", "linux"]) {
      const o = windowChromeOptions(p)
      expect(o, p).toEqual({ frame: false })
    }
  })

  it("红绿灯在标题栏里垂直居中、整个落在标题栏内", () => {
    // 按钮簇约 16px 高：上沿 y，中心 y + 8，应当等于标题栏中线
    expect(MAC_TRAFFIC_LIGHT.y + 8).toBe(TITLE_BAR_HEIGHT / 2)
    expect(MAC_TRAFFIC_LIGHT.y).toBeGreaterThanOrEqual(0)
    expect(MAC_TRAFFIC_LIGHT.y + 16).toBeLessThanOrEqual(TITLE_BAR_HEIGHT)
  })

  it("左侧让位的宽度盖得住红绿灯（左边距 + 三个按钮和间隙约 52px），还留有空隙", () => {
    expect(MAC_CONTROLS_INSET).toBeGreaterThan(MAC_TRAFFIC_LIGHT.x + 52)
  })
})

describe("titleBarLayout：标题栏布局", () => {
  it("macOS 窗口态：不画自绘按钮，左侧让出红绿灯的位置", () => {
    expect(titleBarLayout("darwin", false)).toEqual({ windowButtons: false, leftInset: MAC_CONTROLS_INSET })
  })

  it("macOS 全屏：红绿灯收起了，不再让位；自绘按钮仍然不画", () => {
    expect(titleBarLayout("darwin", true)).toEqual({ windowButtons: false, leftInset: 0 })
  })

  it("Windows / Linux：自绘按钮、不让位，和全屏无关（和改动前一致）", () => {
    for (const p of ["win32", "linux"]) {
      for (const full of [false, true]) expect(titleBarLayout(p, full), `${p} fullScreen=${full}`).toEqual({ windowButtons: true, leftInset: 0 })
    }
  })

  it("取不到系统（旧 preload、测试里的假 electronAPI）：按 Windows 处理", () => {
    expect(titleBarLayout(undefined, false)).toEqual({ windowButtons: true, leftInset: 0 })
  })
})

const view = (layout: ReturnType<typeof titleBarLayout>, over: { maximized?: boolean; actions?: string; children?: string } = {}) =>
  renderToStaticMarkup(
    createElement(
      TitleBarView,
      { layout, maximized: over.maximized ?? false, actions: over.actions ? createElement("span", null, over.actions) : undefined },
      over.children ?? "品牌",
    ),
  )
const buttons = (html: string) => (html.match(/<button/g) ?? []).length

describe("TitleBarView：渲染", () => {
  it("Windows 布局：最小化 / 最大化 / 关闭三个自绘按钮都在，左侧不额外让位", () => {
    const html = view(titleBarLayout("win32", false))
    expect(buttons(html)).toBe(3)
    expect(html).not.toContain("padding-left")
    expect(html).toContain("pr-3")
  })

  it("Windows 布局：最大化状态下，中间那个按钮换成「还原」图标", () => {
    const normal = view(titleBarLayout("win32", false), { maximized: false })
    const maxed = view(titleBarLayout("win32", false), { maximized: true })
    expect(normal).not.toContain("rotate-180")
    expect(maxed).toContain("rotate-180")
  })

  it("macOS 布局：一个自绘按钮都没有（用系统的红绿灯），左侧让出红绿灯的位置", () => {
    const html = view(titleBarLayout("darwin", false))
    expect(buttons(html)).toBe(0)
    expect(html).toContain(`padding-left:${MAC_CONTROLS_INSET}px`)
    expect(html).toContain("品牌")
  })

  it("macOS 全屏：不让位", () => {
    const html = view(titleBarLayout("darwin", true))
    expect(buttons(html)).toBe(0)
    expect(html).not.toContain("padding-left")
  })

  it("macOS 布局：右侧的操作区还在，只是少了窗口按钮，右边距换成和左边一样的 24px", () => {
    const html = view(titleBarLayout("darwin", false), { actions: "设置" })
    expect(html).toContain("设置")
    expect(buttons(html)).toBe(0)
    expect(html).toContain("pr-6")
    expect(html).not.toContain("pr-3")
  })

  it("两种布局下标题栏都还是整条可拖动的，右侧操作区不可拖动（点得到）", () => {
    for (const p of ["win32", "darwin"]) {
      const html = view(titleBarLayout(p, false))
      expect(html, p).toContain("-webkit-app-region:drag")
      expect(html, p).toContain("-webkit-app-region:no-drag")
    }
  })
})

describe("TitleBar：外壳从 electronAPI.platform 取系统", () => {
  afterEach(() => vi.unstubAllGlobals())
  const withPlatform = (platform: string | undefined) => {
    vi.stubGlobal("window", { electronAPI: { platform } })
    return renderToStaticMarkup(createElement(TitleBar, null, "品牌"))
  }

  it("platform 是 darwin：没有自绘按钮，左侧让位", () => {
    const html = withPlatform("darwin")
    expect(buttons(html)).toBe(0)
    expect(html).toContain(`padding-left:${MAC_CONTROLS_INSET}px`)
  })

  it("platform 是 win32 / linux / 取不到：三个自绘按钮", () => {
    for (const p of ["win32", "linux", undefined]) expect(buttons(withPlatform(p)), String(p)).toBe(3)
  })

  it("window 上根本没有 electronAPI（页面级的静态渲染测试就是这样）：不抛错，按 Windows 布局", () => {
    vi.stubGlobal("window", {})
    const html = renderToStaticMarkup(createElement(TitleBar, null, "品牌"))
    expect(buttons(html)).toBe(3)
    expect(html).not.toContain("padding-left")
  })
})

describe("接线：主进程 / preload / 界面类型", () => {
  const main = read("electron/main.ts")
  const preload = read("electron/preload.ts")
  const envDts = read("src/renderer/env.d.ts")

  it("主窗口的外框选项来自 windowChromeOptions，不再写死无边框", () => {
    expect(main).toMatch(/new BrowserWindow\(\{[\s\S]*?\.\.\.windowChromeOptions\(process\.platform\)/)
    expect(main).not.toMatch(/^\s*frame:\s*false/m)
  })

  it("全屏进出由主进程推给界面，界面能随时查当前是不是全屏", () => {
    expect(main).toMatch(/on\("enter-full-screen"[\s\S]{0,120}"window:fullscreen-change", true\)/)
    expect(main).toMatch(/on\("leave-full-screen"[\s\S]{0,120}"window:fullscreen-change", false\)/)
    expect(main).toMatch(/ipcMain\.handle\("window:is-fullscreen", \(\) => mainWindow\?\.isFullScreen\(\) \?\? false\)/)
  })

  it("preload 把 platform、查询、订阅都暴露出去，订阅返回取消函数；界面类型里都有", () => {
    expect(preload).toMatch(/\n  platform: process\.platform/)
    expect(preload).toMatch(/windowIsFullScreen: \(\): Promise<boolean> => ipcRenderer\.invoke\("window:is-fullscreen"\)/)
    const start = preload.indexOf("\n  onWindowFullScreenChange: ")
    expect(start).toBeGreaterThan(-1)
    const block = preload.slice(start, start + 400)
    expect(block).toMatch(/ipcRenderer\.on\("window:fullscreen-change"/)
    expect(block).toMatch(/removeListener\("window:fullscreen-change"/)
    expect(envDts).toMatch(/\n\s+platform: string/)
    expect(envDts).toMatch(/\bwindowIsFullScreen\(\)/)
    expect(envDts).toMatch(/\bonWindowFullScreenChange\(/)
  })
})
