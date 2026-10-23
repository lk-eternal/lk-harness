interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  registerPlugin?: <T>(name: string) => T
}

interface BrowserPlugin {
  open: (options: { url: string }) => Promise<void>
}

let browserPlugin: BrowserPlugin | null = null

function capacitor(): CapacitorGlobal | undefined {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** 是否运行在 Capacitor 原生壳（APK）里；普通浏览器里是 false */
export function isNativeShell(): boolean {
  return !!capacitor()?.isNativePlatform?.()
}

/**
 * 用系统浏览器打开链接（Capacitor 的 Browser 插件，APK 打包时装入）。
 * 只在 Capacitor 原生壳里可用；普通浏览器、或插件不可用时返回 false，由调用方走自己的兜底。
 * 走全局的 registerPlugin 而不是 import，是为了让网页包不依赖 Capacitor 包。
 */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  const cap = capacitor()
  if (!cap?.isNativePlatform?.() || !cap.registerPlugin) return false
  try {
    browserPlugin ??= cap.registerPlugin<BrowserPlugin>("Browser")
    await browserPlugin.open({ url })
    return true
  } catch {
    return false
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
 * 走不通（插件缺失、手机上没有浏览器）时抛错，让界面明说，而不是让用户对着一个没反应的按钮猜。
 * 普通浏览器里直接触发下载。
 */
export async function startFileDownload(
  url: string,
  fileName: string,
  anchorDownload: (url: string, fileName: string) => void = clickDownloadAnchor,
): Promise<void> {
  if (await openInSystemBrowser(url)) return
  if (isNativeShell()) {
    throw new Error("无法调起系统浏览器下载。请把 App 更新到最新版本，并确认手机上装有浏览器")
  }
  anchorDownload(url, fileName)
}
