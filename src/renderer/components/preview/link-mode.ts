export type LinkMode = "internal" | "external"

/**
 * 点链接时在应用内打开还是交给系统浏览器：
 * 没有预览面板（手机端）一律交给系统；有的话按默认方式，按住 Ctrl（macOS 是 ⌘）就反过来。
 */
export function opensInApp(opts: { available: boolean; mode: LinkMode; modifierHeld: boolean }): boolean {
  if (!opts.available) return false
  return (opts.mode === "internal") !== opts.modifierHeld
}
