import { readFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 这里的「原生壳」用的是 Capacitor 注入页面的真实 native-bridge.js（取自已发布 APK 的 assets），
 * 不是手写的 mock。上一版的测试就是 mock 了一个 window.Capacitor.registerPlugin，
 * 而真实桥里根本没有这个方法（它只在把 @capacitor/core 打进前端包时才有），结果测试全绿、真机上点下载却没反应。
 */
const BRIDGE_JS = readFileSync(join(__dirname, "fixtures", "capacitor-native-bridge.js"), "utf8")

interface NativeCall {
  callbackId: string
  pluginId: string
  methodName: string
  options: Record<string, unknown>
}

interface RealShell {
  /** 页面里的 window（同时是 vm 的全局对象） */
  win: Record<string, unknown> & { Capacitor: Record<string, unknown> }
  /** JS 侧发给原生的所有调用，和 Android 的 androidBridge.postMessage 收到的一致 */
  calls: NativeCall[]
  /** 原生回复一次调用，格式与 Android 回给 androidBridge.onmessage 的一致 */
  reply: (call: NativeCall, result: { success: true; data?: unknown } | { success: false; error: { message: string } }) => void
}

function bootRealShell(): RealShell {
  const calls: NativeCall[] = []
  const androidBridge: { postMessage: (s: string) => void; onmessage?: (e: { data: string }) => void } = {
    postMessage: (s) => { calls.push(JSON.parse(s) as NativeCall) },
  }
  // 桥脚本启动时会碰这些浏览器全局（备份 cookie 描述符、fetch/XHR 等），这里给最小的空壳，桥本身的逻辑一行不改
  class FakeXhr {}
  const win: Record<string, unknown> = {
    console,
    Document: class {},
    HTMLDocument: class {},
    document: { addEventListener: () => undefined },
    navigator: {},
    fetch: () => undefined,
    XMLHttpRequest: FakeXhr,
    androidBridge,
    WEBVIEW_SERVER_URL: "http://localhost",
    // Android 在页面脚本之前注入的，只有插件清单，没有 registerPlugin
    Capacitor: { PluginHeaders: [{ name: "Browser", methods: [{ name: "open", rtype: "promise" }, { name: "close", rtype: "promise" }] }] },
  }
  win.window = win
  vm.createContext(win)
  vm.runInContext(BRIDGE_JS, win)
  return {
    win: win as RealShell["win"],
    calls,
    reply: (call, result) => {
      androidBridge.onmessage?.({
        data: JSON.stringify({ callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, ...result }),
      })
    },
  }
}

function installWindow(win: unknown): void {
  ;(globalThis as { window?: unknown }).window = win
}

// 模块不缓存状态，但保持和以往一致：每个用例重新加载
async function load() {
  vi.resetModules()
  return await import("../src/mobile/native-browser")
}

beforeEach(() => installWindow({}))
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe("真实原生桥的形态（防止再用 mock 掩盖环境差异）", () => {
  it("有 nativePromise，没有 registerPlugin：前端包没打进 @capacitor/core 时就是这样", () => {
    const { win } = bootRealShell()
    expect(typeof win.Capacitor.nativePromise).toBe("function")
    expect(typeof win.Capacitor.isNativePlatform).toBe("function")
    expect(win.Capacitor.registerPlugin).toBeUndefined()
  })
})

describe("isNativeShell", () => {
  it("普通浏览器（没有 Capacitor）不是原生壳", async () => {
    const { isNativeShell } = await load()
    expect(isNativeShell()).toBe(false)
  })

  it("真实原生桥里是原生壳", async () => {
    installWindow(bootRealShell().win)
    const { isNativeShell } = await load()
    expect(isNativeShell()).toBe(true)
  })
})

describe("tryOpenInSystemBrowser（真实原生桥）", () => {
  it("把 Browser.open 发给原生，原生成功回复后返回 ok", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { tryOpenInSystemBrowser } = await load()

    const pending = tryOpenInSystemBrowser("http://192.168.1.2:8080/api/mobile/file?ticket=t")
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]).toMatchObject({
      pluginId: "Browser",
      methodName: "open",
      options: { url: "http://192.168.1.2:8080/api/mobile/file?ticket=t" },
    })
    shell.reply(shell.calls[0], { success: true, data: {} })

    expect(await pending).toEqual({ ok: true })
  })

  it("原生拒绝时返回失败并带上原生给出的原因", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { tryOpenInSystemBrowser } = await load()

    const pending = tryOpenInSystemBrowser("http://x/y")
    shell.reply(shell.calls[0], { success: false, error: { message: "Unable to display URL" } })

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.reason).toContain("Unable to display URL")
  })

  it("原生一直不回复：超时后返回失败，不让按钮永远转圈", async () => {
    vi.useFakeTimers()
    const shell = bootRealShell()
    installWindow(shell.win)
    const { tryOpenInSystemBrowser } = await load()

    const pending = tryOpenInSystemBrowser("http://x/y")
    await vi.advanceTimersByTimeAsync(15_000)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.reason).toMatch(/无响应|超时/)
  })

  it("超时之后原生才回复，不会让已经返回的结果翻转，也不抛未处理的错误", async () => {
    vi.useFakeTimers()
    const shell = bootRealShell()
    installWindow(shell.win)
    const { tryOpenInSystemBrowser } = await load()

    const pending = tryOpenInSystemBrowser("http://x/y")
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pending).ok).toBe(false)

    shell.reply(shell.calls[0], { success: true, data: {} })
    await vi.advanceTimersByTimeAsync(0)
  })

  it("普通浏览器里直接返回失败，由调用方走 <a download>", async () => {
    const { tryOpenInSystemBrowser } = await load()
    const result = await tryOpenInSystemBrowser("https://x/y")
    expect(result.ok).toBe(false)
  })

  it("原生桥里没有 nativePromise（异常的壳）：返回失败并说明原因，不抛错", async () => {
    installWindow({ Capacitor: { isNativePlatform: () => true } })
    const { tryOpenInSystemBrowser } = await load()
    const result = await tryOpenInSystemBrowser("https://x/y")
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.reason).toMatch(/原生桥/)
  })
})

describe("startFileDownload", () => {
  it("普通浏览器：走 <a download>", async () => {
    const anchor = vi.fn()
    const { startFileDownload } = await load()
    await startFileDownload("https://x/f?ticket=t", "video.mp4", anchor)
    expect(anchor).toHaveBeenCalledWith("https://x/f?ticket=t", "video.mp4")
  })

  it("原生壳里：交给系统浏览器，不再碰 <a download>（回归：之前在真实桥里直接报无法调起）", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const anchor = vi.fn()
    const { startFileDownload } = await load()

    const pending = startFileDownload("http://192.168.1.2:8080/api/mobile/file?ticket=t", "video.mp4", anchor)
    expect(shell.calls.map((c) => `${c.pluginId}.${c.methodName}`)).toEqual(["Browser.open"])
    shell.reply(shell.calls[0], { success: true, data: {} })

    await expect(pending).resolves.toBeUndefined()
    expect(anchor).not.toHaveBeenCalled()
  })

  it("原生壳里调起失败：抛出带原因的错误，不静默回落到在 WebView 里没用的 <a download>", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const anchor = vi.fn()
    const { startFileDownload } = await load()

    const pending = startFileDownload("http://x/f?ticket=t", "video.mp4", anchor)
    const assertion = expect(pending).rejects.toThrow(/系统浏览器.*Unable to display URL/)
    shell.reply(shell.calls[0], { success: false, error: { message: "Unable to display URL" } })

    await assertion
    expect(anchor).not.toHaveBeenCalled()
  })
})
