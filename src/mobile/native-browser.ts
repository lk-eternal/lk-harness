interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  /**
   * 原生桥（Capacitor 注入页面的 native-bridge.js）自带：把一次插件调用转给原生端，返回 Promise。
   * 注意没有 registerPlugin —— 那是 @capacitor/core 才加的，前端包没打进 core，APK 里 window.Capacitor 上并没有它。
   * 所以直接走 nativePromise；registerPlugin 的代理最终调的也是它。
   */
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** 是否运行在 Capacitor 原生壳（APK）里；普通浏览器里是 false */
export function isNativeShell(): boolean {
  return !!capacitor()?.isNativePlatform?.()
}

export type OpenResult = { ok: true } | { ok: false; reason: string }

/**
 * 原生端迟迟不回复就放弃等待。正常情况下拉起浏览器不到一秒；
 * 不设上限的话，原生端出了岔子，下载按钮会永远转圈。
 */
const NATIVE_OPEN_TIMEOUT_MS = 10_000

function describeError(err: unknown): string {
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return "未知错误"
}

/**
 * 用系统浏览器打开链接（Capacitor 的 Browser 插件，APK 打包时装入）。
 * 失败时带上原因：之前把原因吞掉，用户看到「无法调起」却没人知道到底卡在哪一步。
 */
export async function tryOpenInSystemBrowser(url: string): Promise<OpenResult> {
  const cap = capacitor()
  if (!cap?.isNativePlatform?.()) return { ok: false, reason: "当前不在 App 内" }
  if (typeof cap.nativePromise !== "function") return { ok: false, reason: "原生桥不可用，App 版本可能不匹配" }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const call = cap.nativePromise("Browser", "open", { url })
    // 超时落败之后原生才回复也不要紧：call 之后的 reject 会被下面的 race 接住，不会变成未处理的 rejection
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("系统浏览器无响应")), NATIVE_OPEN_TIMEOUT_MS)
    })
    await Promise.race([call, timeout])
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: describeError(err) }
  } finally {
    clearTimeout(timer)
  }
}

function clickDownloadAnchor(url: string, fileName: string): void {
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.rel = "noreferrer"
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * 把附件下载链接交给系统去下载（服务端以 attachment 返回）。
 * App 内的 WebView 没有下载监听，<a download> 点了不会有任何反应，所以原生壳里只能走系统浏览器；
 * 走不通时抛错并带上原因，让界面明说，而不是让用户对着一个没反应的按钮猜。
 * 普通浏览器里直接触发下载。
 */
export async function startFileDownload(
  url: string,
  fileName: string,
  anchorDownload: (url: string, fileName: string) => void = clickDownloadAnchor,
): Promise<void> {
  if (isNativeShell()) {
    const result = await tryOpenInSystemBrowser(url)
    if (!result.ok) throw new Error(`无法调起系统浏览器下载（${result.reason}）。请确认手机上装有浏览器`)
    return
  }
  anchorDownload(url, fileName)
}
