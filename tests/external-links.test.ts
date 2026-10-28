import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
// 「原生壳」是 Capacitor 注入页面的真实 native-bridge.js（取自已发布 APK），不是手写 mock
import { bootRealShell, installWindow } from "./helpers/real-native-shell"

/**
 * 回归：手机端 App 里点聊天中的链接，页面被目标网页替换，按返回键直接退出应用，回不到会话。
 * 原因：WebView 没开多窗口，target=_blank 被忽略；allowNavigation:["*"] 又让 Capacitor 不转交系统；
 * APK 里没有 @capacitor/app，返回键没人管。所以外链点击要拦下来，交给系统浏览器。
 *
 * 这里测拦截逻辑本身（不依赖 DOM 的替身）；真实 DOM、真实 Markdown 组件、真实点击的验证在 Electron 里另做。
 */

interface FakeClick {
  defaultPrevented: boolean
  target: unknown
  preventDefault: () => void
}

function makeDoc() {
  const listeners: Array<{ type: string; fn: (e: Event) => void; capture: boolean }> = []
  const doc = {
    addEventListener: (type: string, fn: (e: Event) => void, capture?: boolean | AddEventListenerOptions) => {
      listeners.push({ type, fn, capture: capture === true })
    },
    removeEventListener: (type: string, fn: (e: Event) => void, capture?: boolean | EventListenerOptions) => {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === (capture === true))
      if (at >= 0) listeners.splice(at, 1)
    },
  }
  /** 模拟用户点了 target：依次调用已注册的 click 监听，返回事件以便检查是否被 preventDefault */
  function click(target: unknown, opts: { alreadyPrevented?: boolean } = {}): FakeClick {
    const e: FakeClick = {
      defaultPrevented: opts.alreadyPrevented === true,
      target,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    for (const l of [...listeners]) if (l.type === "click") l.fn(e as unknown as Event)
    return e
  }
  return { doc: doc as unknown as Pick<Document, "addEventListener" | "removeEventListener">, listeners, click }
}

/** 点击目标：closest("a[href]") 能找到一个 <a>（真实 DOM 里点到链接里的文字/加粗也是这样） */
const anchorTarget = (href: string) => ({ closest: (sel: string) => (sel === "a[href]" ? { href } : null) })
/** 点到了普通文字 */
const plainTarget = { closest: () => null }

async function load() {
  vi.resetModules()
  return await import("../src/mobile/external-links")
}

beforeEach(() => installWindow({}))
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe("externalLinkOf", () => {
  it("取点击目标所在的 <a> 的地址，http 和 https 都认", async () => {
    const { externalLinkOf } = await load()
    expect(externalLinkOf(anchorTarget("https://example.com/a?b=1"))).toBe("https://example.com/a?b=1")
    expect(externalLinkOf(anchorTarget("http://192.168.1.2:8080/x"))).toBe("http://192.168.1.2:8080/x")
  })

  it("不是 http(s) 的链接、点到非链接、没有 closest 的目标：都不认", async () => {
    const { externalLinkOf } = await load()
    expect(externalLinkOf(anchorTarget("mailto:a@b.com"))).toBeNull()
    expect(externalLinkOf(anchorTarget("javascript:alert(1)"))).toBeNull()
    expect(externalLinkOf(anchorTarget("file:///etc/passwd"))).toBeNull()
    expect(externalLinkOf(anchorTarget("not a url"))).toBeNull()
    expect(externalLinkOf(plainTarget)).toBeNull()
    expect(externalLinkOf(null)).toBeNull()
    expect(externalLinkOf({})).toBeNull()
  })
})

describe("installExternalLinkHandler（真实原生桥）", () => {
  it("监听挂在捕获阶段，卸载后不再响应", async () => {
    const { installExternalLinkHandler } = await load()
    const { doc, listeners } = makeDoc()
    const off = installExternalLinkHandler(() => undefined, doc)
    expect(listeners).toHaveLength(1)
    expect(listeners[0]).toMatchObject({ type: "click", capture: true })
    off()
    expect(listeners).toHaveLength(0)
  })

  it("原生壳里点外链：拦下页面跳转，把 Browser.open 发给原生，成功后不报错", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { installExternalLinkHandler } = await load()
    const errors: string[] = []
    const { doc, click } = makeDoc()
    installExternalLinkHandler((m) => errors.push(m), doc)

    const e = click(anchorTarget("https://example.com/docs"))

    expect(e.defaultPrevented).toBe(true)
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]).toMatchObject({ pluginId: "Browser", methodName: "open", options: { url: "https://example.com/docs" } })
    shell.reply(shell.calls[0], { success: true, data: {} })
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toEqual([])
  })

  it("原生拒绝时：页面照样被拦住（不能让 WebView 跳走），错误里带原因和链接", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { installExternalLinkHandler } = await load()
    const errors: string[] = []
    const { doc, click } = makeDoc()
    installExternalLinkHandler((m) => errors.push(m), doc)

    const e = click(anchorTarget("https://example.com/docs"))
    shell.reply(shell.calls[0], { success: false, error: { message: "Unable to display URL" } })

    expect(e.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toContain("Unable to display URL")
    expect(errors[0]).toContain("https://example.com/docs")
  })

  it("原生一直不回复：超时后报错，页面同样已被拦住", async () => {
    vi.useFakeTimers()
    const shell = bootRealShell()
    installWindow(shell.win)
    const { installExternalLinkHandler } = await load()
    const errors: string[] = []
    const { doc, click } = makeDoc()
    installExternalLinkHandler((m) => errors.push(m), doc)

    const e = click(anchorTarget("https://example.com/docs"))
    await vi.advanceTimersByTimeAsync(15_000)

    expect(e.defaultPrevented).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/无响应/)
  })

  it("点到链接里的子元素（加粗、行内代码）也算点了链接", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { installExternalLinkHandler } = await load()
    const { doc, click } = makeDoc()
    installExternalLinkHandler(() => undefined, doc)

    const e = click(anchorTarget("https://example.com/x"))

    expect(e.defaultPrevented).toBe(true)
    expect(shell.calls).toHaveLength(1)
  })

  it("点普通文字、mailto 链接：不拦、不调原生", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { installExternalLinkHandler } = await load()
    const { doc, click } = makeDoc()
    installExternalLinkHandler(() => undefined, doc)

    expect(click(plainTarget).defaultPrevented).toBe(false)
    expect(click(anchorTarget("mailto:a@b.com")).defaultPrevented).toBe(false)
    expect(shell.calls).toHaveLength(0)
  })

  it("别处已经处理过这次点击（defaultPrevented）：不重复处理", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const { installExternalLinkHandler } = await load()
    const { doc, click } = makeDoc()
    installExternalLinkHandler(() => undefined, doc)

    click(anchorTarget("https://example.com/x"), { alreadyPrevented: true })

    expect(shell.calls).toHaveLength(0)
  })

  it("网页版（普通浏览器，不是原生壳）：不拦截，让浏览器按新标签页打开", async () => {
    const { installExternalLinkHandler } = await load()
    const errors: string[] = []
    const { doc, click } = makeDoc()
    installExternalLinkHandler((m) => errors.push(m), doc)

    const e = click(anchorTarget("https://example.com/docs"))

    expect(e.defaultPrevented).toBe(false)
    expect(errors).toEqual([])
  })
})
