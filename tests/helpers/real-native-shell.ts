import { readFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"

/**
 * 这里的「原生壳」用的是 Capacitor 注入页面的真实 native-bridge.js（取自已发布 APK 的 assets），
 * 不是手写的 mock。上一版的测试就是 mock 了一个 window.Capacitor.registerPlugin，
 * 而真实桥里根本没有这个方法（它只在把 @capacitor/core 打进前端包时才有），结果测试全绿、真机上点下载却没反应。
 */
const BRIDGE_JS = readFileSync(join(__dirname, "..", "fixtures", "capacitor-native-bridge.js"), "utf8")

export interface NativeCall {
  callbackId: string
  pluginId: string
  methodName: string
  options: Record<string, unknown>
}

export interface RealShell {
  /** 页面里的 window（同时是 vm 的全局对象） */
  win: Record<string, unknown> & { Capacitor: Record<string, unknown> }
  /** JS 侧发给原生的所有调用，和 Android 的 androidBridge.postMessage 收到的一致 */
  calls: NativeCall[]
  /** 原生回复一次调用，格式与 Android 回给 androidBridge.onmessage 的一致 */
  reply: (call: NativeCall, result: { success: true; data?: unknown } | { success: false; error: { message: string } }) => void
}

const PLUGIN_METHODS: Record<string, { name: string; rtype: string }[]> = {
  Browser: [{ name: "open", rtype: "promise" }, { name: "close", rtype: "promise" }],
  App: [
    { name: "exitApp", rtype: "promise" },
    { name: "minimizeApp", rtype: "promise" },
    { name: "addListener", rtype: "callback" },
    { name: "removeListener", rtype: "callback" },
  ],
}

/** plugins：这个「APK」里装了哪些原生插件，对应 Android 在页面脚本之前注入的 PluginHeaders */
export function bootRealShell(plugins: string[] = ["Browser"]): RealShell {
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
    Capacitor: { PluginHeaders: plugins.map((name) => ({ name, methods: PLUGIN_METHODS[name] ?? [] })) },
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

export function installWindow(win: unknown): void {
  ;(globalThis as { window?: unknown }).window = win
}
