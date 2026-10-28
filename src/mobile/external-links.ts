import { isNativeShell, tryOpenInSystemBrowser, type OpenResult } from "./native-browser"

/**
 * App（APK）里点聊天中的链接：拦下来，交给系统浏览器打开，不让页面自己跳走。
 *
 * 为什么不能让 WebView 自己处理：
 * - Android WebView 没开多窗口，<a target="_blank"> 的 target 被忽略，目标页直接在当前 WebView 里加载；
 * - capacitor.config.json 的 allowNavigation: ["*"] 放行了所有域名，Capacitor 也就不会把外链转交系统；
 * - 于是聊天界面被目标网页整个替换掉。而 APK 里没有 @capacitor/app，没人处理系统返回键：
 *   按返回既不会回到上一页，也回不到会话，而是直接退出应用。
 *
 * 所以在原生壳里统一拦截外链点击：阻止页面跳转，改用系统浏览器（Custom Tab）打开，会话界面原样留着，
 * 关掉浏览页就回到会话。普通浏览器（网页版）里不拦截：新标签页打开，返回键行为本来就是对的。
 */

/** 点击事件里这里用到的部分（DOM 的 Event 满足它，测试里也能用不依赖 DOM 的替身） */
export interface LinkClickEvent {
  readonly defaultPrevented: boolean
  readonly target: unknown
  preventDefault(): void
}

interface ClosestCapable {
  closest(selector: string): unknown
}

function hasClosest(target: unknown): target is ClosestCapable {
  return !!target && typeof (target as ClosestCapable).closest === "function"
}

/**
 * 点击目标所在的 <a>，只认绝对 http(s) 链接，返回它的完整地址。
 * mailto:、tel:、javascript:、file: 等不碰：它们不会让 WebView 跳走，Agent 输出里的这类链接 Markdown 层本来也不渲染成链接。
 */
export function externalLinkOf(target: unknown): string | null {
  if (!hasClosest(target)) return null
  const anchor = target.closest("a[href]") as { href?: unknown } | null
  const href = anchor?.href // DOM 里的 a.href 已经按页面地址解析成绝对地址
  if (typeof href !== "string") return null
  try {
    const { protocol } = new URL(href)
    return protocol === "http:" || protocol === "https:" ? href : null
  } catch {
    return null
  }
}

export interface LinkClickDeps {
  isNative: () => boolean
  open: (url: string) => Promise<OpenResult>
  onError: (message: string) => void
}

export function handleLinkClick(e: LinkClickEvent, deps: LinkClickDeps): void {
  if (e.defaultPrevented || !deps.isNative()) return
  const url = externalLinkOf(e.target)
  if (!url) return
  // 不管能不能打开都要拦：放行的话 WebView 会自己跳过去，那正是要避免的
  e.preventDefault()
  void deps.open(url).then((result) => {
    if (!result.ok) deps.onError(`无法调起系统浏览器（${result.reason}）：${url}`)
  })
}

type ClickTarget = Pick<Document, "addEventListener" | "removeEventListener">

/** 在 document 上挂捕获阶段的点击监听，返回卸载函数 */
export function installExternalLinkHandler(
  onError: (message: string) => void,
  doc: ClickTarget = document,
  deps: Omit<LinkClickDeps, "onError"> = { isNative: isNativeShell, open: tryOpenInSystemBrowser },
): () => void {
  const listener = (e: Event) => handleLinkClick(e, { ...deps, onError })
  // 捕获阶段：先于页面里任何组件的点击处理，也不会被它们的 stopPropagation 挡住
  doc.addEventListener("click", listener, true)
  return () => doc.removeEventListener("click", listener, true)
}
