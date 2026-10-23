import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Cap = { isNativePlatform?: () => boolean; registerPlugin?: (name: string) => unknown }

function setCapacitor(cap: Cap | undefined): void {
  ;(globalThis as { window?: unknown }).window = cap ? { Capacitor: cap } : {}
}

// 模块里缓存了插件代理，每个用例都要重新加载
async function load() {
  vi.resetModules()
  return await import("../src/mobile/native-browser")
}

beforeEach(() => setCapacitor(undefined))
afterEach(() => { delete (globalThis as { window?: unknown }).window })

describe("isNativeShell", () => {
  it("普通浏览器（没有 Capacitor）不是原生壳", async () => {
    const { isNativeShell } = await load()
    expect(isNativeShell()).toBe(false)
  })

  it("Capacitor 存在但不是原生平台（网页预览）不算", async () => {
    setCapacitor({ isNativePlatform: () => false })
    const { isNativeShell } = await load()
    expect(isNativeShell()).toBe(false)
  })

  it("原生平台是原生壳", async () => {
    setCapacitor({ isNativePlatform: () => true })
    const { isNativeShell } = await load()
    expect(isNativeShell()).toBe(true)
  })
})

describe("startFileDownload", () => {
  it("普通浏览器：走 <a download>", async () => {
    const anchor = vi.fn()
    const { startFileDownload } = await load()
    await startFileDownload("https://x/f?ticket=t", "video.mp4", anchor)
    expect(anchor).toHaveBeenCalledWith("https://x/f?ticket=t", "video.mp4")
  })

  it("原生壳里插件可用：交给系统浏览器，不再碰 <a download>", async () => {
    const open = vi.fn(async () => undefined)
    setCapacitor({ isNativePlatform: () => true, registerPlugin: () => ({ open }) })
    const anchor = vi.fn()
    const { startFileDownload } = await load()
    await startFileDownload("https://x/f?ticket=t", "video.mp4", anchor)
    expect(open).toHaveBeenCalledWith({ url: "https://x/f?ticket=t" })
    expect(anchor).not.toHaveBeenCalled()
  })

  it("原生壳里插件不可用：抛出明确的错误，不静默回落到在 WebView 里没用的 <a download>", async () => {
    const open = vi.fn(async () => { throw new Error("not implemented") })
    setCapacitor({ isNativePlatform: () => true, registerPlugin: () => ({ open }) })
    const anchor = vi.fn()
    const { startFileDownload } = await load()
    await expect(startFileDownload("https://x/f?ticket=t", "video.mp4", anchor)).rejects.toThrow(/系统浏览器/)
    expect(anchor).not.toHaveBeenCalled()
  })
})

describe("openInSystemBrowser", () => {
  it("普通浏览器里直接返回 false，由调用方走 <a download>", async () => {
    const { openInSystemBrowser } = await load()
    expect(await openInSystemBrowser("https://x/y")).toBe(false)
  })

  it("原生壳里用 Browser 插件打开链接并返回 true", async () => {
    const open = vi.fn(async () => undefined)
    const registerPlugin = vi.fn(() => ({ open }))
    setCapacitor({ isNativePlatform: () => true, registerPlugin })
    const { openInSystemBrowser } = await load()

    expect(await openInSystemBrowser("https://x/api/mobile/file?ticket=t")).toBe(true)
    expect(registerPlugin).toHaveBeenCalledWith("Browser")
    expect(open).toHaveBeenCalledWith({ url: "https://x/api/mobile/file?ticket=t" })
  })

  it("插件没装进 APK（open 抛 not implemented）时返回 false，不抛错", async () => {
    // 这正是已发布 APK 里的真实情况：capacitor.plugins.json 是空数组，调用会抛 UNIMPLEMENTED
    const open = vi.fn(async () => { throw new Error('"Browser" plugin is not implemented on android') })
    setCapacitor({ isNativePlatform: () => true, registerPlugin: () => ({ open }) })
    const { openInSystemBrowser, isNativeShell } = await load()

    expect(await openInSystemBrowser("https://x/y")).toBe(false)
    // 调用方据此区分「普通浏览器」和「原生壳里插件失败」，后者不能静默回落到没用的 <a download>
    expect(isNativeShell()).toBe(true)
  })

  it("registerPlugin 本身抛错或缺失也返回 false", async () => {
    setCapacitor({ isNativePlatform: () => true, registerPlugin: () => { throw new Error("boom") } })
    expect(await (await load()).openInSystemBrowser("https://x/y")).toBe(false)

    setCapacitor({ isNativePlatform: () => true })
    expect(await (await load()).openInSystemBrowser("https://x/y")).toBe(false)
  })
})
