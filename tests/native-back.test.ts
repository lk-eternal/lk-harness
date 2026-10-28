import { afterEach, describe, expect, it } from "vitest"
import { openOverlayCount, registerOverlay } from "../src/mobile/back-stack"
import { installNativeBackHandler } from "../src/mobile/native-back"
import { bootRealShell, installWindow, type NativeCall, type RealShell } from "./helpers/real-native-shell"

/**
 * 原生壳用 Capacitor 注入页面的真实 native-bridge.js（见 helpers/real-native-shell.ts）。
 * 「原生端按下返回键」= 原生往 App.addListener 登记过的 callbackId 回一条消息，和 AppPlugin.java 里
 * notifyListeners("backButton", { canGoBack }) 在桥上的样子一致。
 */

// back-stack 只在第一次登记浮层时给 window 挂一次 popstate 监听，之后的假 window 都得共用这份
const popstateListeners: (() => void)[] = []

function bootApk(plugins: string[]): RealShell {
  const shell = bootRealShell(plugins)
  Object.assign(shell.win, {
    addEventListener: (type: string, fn: () => void) => {
      if (type === "popstate") popstateListeners.push(fn)
    },
    // history.go 会异步触发 popstate，和浏览器一致；back-stack 靠它确认「程序发起的回退」已完成
    history: { pushState: () => undefined, go: () => queueMicrotask(() => popstateListeners.forEach((f) => f())) },
  })
  installWindow(shell.win)
  return shell
}

const callsTo = (shell: RealShell, method: string): NativeCall[] => shell.calls.filter((c) => c.methodName === method)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function pressBack(shell: RealShell): void {
  const listener = callsTo(shell, "addListener").find((c) => c.options.eventName === "backButton")
  if (!listener) throw new Error("页面没有登记 backButton 监听")
  shell.reply(listener, { success: true, data: { canGoBack: true } })
}

const cleanups: (() => void)[] = []
afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.()
  await flush()
  installWindow(undefined)
})

describe("APK 返回键接管", () => {
  it("装了 App 插件：向原生端登记 backButton 监听", () => {
    const shell = bootApk(["Browser", "App"])
    cleanups.push(installNativeBackHandler())
    const listeners = callsTo(shell, "addListener")
    expect(listeners).toHaveLength(1)
    expect(listeners[0]).toMatchObject({ pluginId: "App", options: { eventName: "backButton" } })
  })

  it("没有浮层时按返回：退到后台，不退出应用", async () => {
    const shell = bootApk(["App"])
    cleanups.push(installNativeBackHandler())
    pressBack(shell)
    await flush()
    expect(callsTo(shell, "minimizeApp")).toHaveLength(1)
    expect(callsTo(shell, "exitApp")).toHaveLength(0)
  })

  it("有浮层时按返回：每次只关最上面一个，关完才轮到退到后台", async () => {
    const shell = bootApk(["App"])
    cleanups.push(installNativeBackHandler())
    const closed: string[] = []
    // 浮层被关就等于组件把 open 置 false，effect 清理里注销登记
    let offDrawer = () => {}
    let offSheet = () => {}
    offDrawer = registerOverlay(() => {
      closed.push("drawer")
      offDrawer()
    })
    offSheet = registerOverlay(() => {
      closed.push("sheet")
      offSheet()
    })
    expect(openOverlayCount()).toBe(2)

    pressBack(shell)
    await flush()
    expect(closed).toEqual(["sheet"])
    expect(openOverlayCount()).toBe(1)
    expect(callsTo(shell, "minimizeApp")).toHaveLength(0)

    pressBack(shell)
    await flush()
    expect(closed).toEqual(["sheet", "drawer"])
    expect(openOverlayCount()).toBe(0)
    expect(callsTo(shell, "minimizeApp")).toHaveLength(0)

    pressBack(shell)
    await flush()
    expect(callsTo(shell, "minimizeApp")).toHaveLength(1)
  })

  it("退到后台失败（原生端出岔子）：改为退出应用，不能让返回键毫无反应", async () => {
    const shell = bootApk(["App"])
    cleanups.push(installNativeBackHandler())
    pressBack(shell)
    await flush()
    shell.reply(callsTo(shell, "minimizeApp")[0], { success: false, error: { message: "boom" } })
    await flush()
    expect(callsTo(shell, "exitApp")).toHaveLength(1)
  })

  it("取消时向原生端撤销监听", () => {
    const shell = bootApk(["App"])
    const off = installNativeBackHandler()
    const listener = callsTo(shell, "addListener")[0]
    off()
    const removed = callsTo(shell, "removeListener")
    expect(removed).toHaveLength(1)
    expect(removed[0].options).toMatchObject({ eventName: "backButton", callbackId: listener.callbackId })
  })

  it("旧 APK 没装 App 插件：什么都不登记（登记了也没人接）", () => {
    const shell = bootApk(["Browser"])
    const off = installNativeBackHandler()
    cleanups.push(off)
    expect(shell.calls).toHaveLength(0)
  })

  it("普通浏览器（没有原生桥）：不报错，也不登记", () => {
    installWindow({})
    expect(() => installNativeBackHandler()()).not.toThrow()
  })
})
