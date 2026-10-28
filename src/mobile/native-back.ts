import { closeTopOverlay } from "./back-stack"
import { nativeBridge } from "./native-browser"

/** 当前 APK 里有没有装这个原生插件（以原生端注入的插件清单为准，不靠猜） */
export function hasNativePlugin(name: string): boolean {
  const headers = nativeBridge()?.PluginHeaders
  return Array.isArray(headers) && headers.some((h) => h?.name === name)
}

/**
 * APK 里的返回键。
 *
 * 只靠 Capacitor 核心，按返回键会直接退出应用，页面里的抽屉、弹窗来不及关。
 * 装了 @capacitor/app 后原生端会接管返回键，但默认只做「WebView 有历史就后退，没有就什么都不做」：
 * 有浮层时能关，可没有浮层时就再也退不出应用了。所以页面要自己注册 backButton 监听：
 *   有浮层 → 关最上面一个；没有 → 把应用退到后台（和 Android 12 起默认的返回行为一致，回来时对话还在原处）。
 *
 * 没装 @capacitor/app 的旧 APK、普通浏览器里不注册，保持原样（浏览器靠 back-stack 的 history 记录）。
 * 返回的函数用来取消监听。
 */
export function installNativeBackHandler(): () => void {
  const cap = nativeBridge()
  if (!cap?.isNativePlatform?.() || typeof cap.addListener !== "function" || !hasNativePlugin("App")) {
    return () => {}
  }
  const listener = cap.addListener("App", "backButton", () => {
    if (closeTopOverlay()) return
    const call = (method: string) => cap.nativePromise?.("App", method)
    // 退到后台没成功（原生端出了岔子）就退出，总比按了返回键毫无反应强
    void call("minimizeApp")?.catch(() => call("exitApp")?.catch(() => undefined))
  })
  return () => {
    void listener.remove()
  }
}
