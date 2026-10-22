interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  registerPlugin?: <T>(name: string) => T
}

interface BrowserPlugin {
  open: (options: { url: string }) => Promise<void>
}

let browserPlugin: BrowserPlugin | null = null

/**
 * 用系统浏览器打开链接（Capacitor 的 Browser 插件，APK 打包时装入）。
 * 只在 Capacitor 原生壳里可用；普通浏览器、或插件不可用时返回 false，由调用方走自己的兜底。
 * 走全局的 registerPlugin 而不是 import，是为了让网页包不依赖 Capacitor 包。
 */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  const cap = (window as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap?.isNativePlatform?.() || !cap.registerPlugin) return false
  try {
    browserPlugin ??= cap.registerPlugin<BrowserPlugin>("Browser")
    await browserPlugin.open({ url })
    return true
  } catch {
    return false
  }
}
