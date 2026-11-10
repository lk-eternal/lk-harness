import { describe, expect, it } from "vitest"
import { opensInApp } from "../src/renderer/components/preview/link-mode"
import {
  INITIAL_PREVIEW_STATE, MAX_PREVIEW_TABS, previewReducer, removedWebTabIds, tabTitle,
  type PreviewAction, type PreviewState, type WebTab,
} from "../src/renderer/components/preview/preview-tabs"

const run = (actions: PreviewAction[], from: PreviewState = INITIAL_PREVIEW_STATE) => actions.reduce(previewReducer, from)
const file = (id: string, path: string, sessionKey = "s1"): PreviewAction => ({ type: "openFile", id, sessionKey, path, name: path.split(/[\\/]/).pop()! })
const web = (id: string, url: string): PreviewAction => ({ type: "openWeb", id, url })
const ids = (s: PreviewState) => s.tabs.map((t) => t.id)
const webTab = (s: PreviewState, id: string) => s.tabs.find((t): t is WebTab => t.id === id && t.kind === "web")!

describe("打开文件", () => {
  it("新开一个文件标签页并展开面板、切过去", () => {
    const s = run([file("a", "D:\\x\\a.md")])
    expect(ids(s)).toEqual(["a"])
    expect(s.activeId).toBe("a")
    expect(s.open).toBe(true)
  })

  it("再次点开同一个文件：不新增标签页，切过去并让它重新读取", () => {
    const s = run([file("a", "D:\\x\\a.md"), file("b", "D:\\x\\b.md"), file("c", "d:/X/A.md")])
    expect(ids(s)).toEqual(["a", "b"])
    expect(s.activeId).toBe("a")
    expect(s.tabs[0]).toMatchObject({ kind: "file", reload: 1 })
  })

  it("重新点开时更新它所属的会话（授权跟着最近一次打开它的会话走）", () => {
    const s = run([file("a", "/w/a.txt", "s1"), file("x", "/w/a.txt", "s2")])
    expect(s.tabs[0]).toMatchObject({ sessionKey: "s2" })
  })

  it("不同路径是不同标签页", () => {
    expect(ids(run([file("a", "/w/a.txt"), file("b", "/w/b.txt")]))).toEqual(["a", "b"])
  })

  it("带行号打开：记在标签页上；不带行号就没有这个字段", () => {
    const withLine = run([{ ...(file("a", "/w/a.ts") as Extract<PreviewAction, { type: "openFile" }>), line: 42 }])
    expect(withLine.tabs[0]).toMatchObject({ line: 42 })
    expect("line" in run([file("b", "/w/b.ts")]).tabs[0]).toBe(false)
  })

  it("再次点开同一个文件：行号以最近一次为准，没带行号就清掉，回到顶部", () => {
    const open = (id: string, line?: number): PreviewAction => ({ ...(file(id, "/w/a.ts") as Extract<PreviewAction, { type: "openFile" }>), line })
    let s = run([open("a", 10)])
    expect(s.tabs[0]).toMatchObject({ line: 10, reload: 0 })
    s = run([open("x", 99)], s)
    expect(s.tabs[0]).toMatchObject({ line: 99, reload: 1 })
    s = run([open("y")], s)
    expect((s.tabs[0] as { line?: number }).line).toBeUndefined()
    expect(s.tabs[0]).toMatchObject({ reload: 2 })
  })
})

describe("网页标签页", () => {
  it("openWeb：新标签页带待加载的网址，加载一经发出就清掉", () => {
    let s = run([web("w1", "https://a.com")])
    expect(webTab(s, "w1")).toMatchObject({ url: "https://a.com", pendingUrl: "https://a.com", loading: true })
    s = run([{ type: "webStarted", id: "w1" }], s)
    expect(webTab(s, "w1").pendingUrl).toBeUndefined()
  })

  it("同一个网址已经开着：切过去，不重复开", () => {
    const s = run([web("w1", "https://a.com"), file("f", "/a.txt"), web("w2", "https://a.com")])
    expect(ids(s)).toEqual(["w1", "f"])
    expect(s.activeId).toBe("w1")
  })

  it("非 http(s) 网址一律不开", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "lkfile://x/y", "ftp://a.com", ""]) {
      expect(run([web("w", url)])).toEqual(INITIAL_PREVIEW_STATE)
    }
  })

  it("openBlankWeb：空白标签页，没有网址也没有待加载的东西", () => {
    const s = run([{ type: "openBlankWeb", id: "b" }])
    expect(webTab(s, "b")).toMatchObject({ url: "", loading: false })
    expect(webTab(s, "b").pendingUrl).toBeUndefined()
  })

  it("navigateWeb：地址栏提交，写入待加载网址并清掉旧的错误；非 http(s) 忽略", () => {
    let s = run([{ type: "openBlankWeb", id: "b" }])
    s = run([{ type: "webState", state: { tabId: "b", url: "https://old.com", title: "", loading: false, canGoBack: false, canGoForward: false, error: "boom" } }], s)
    s = run([{ type: "navigateWeb", id: "b", url: "https://new.com" }], s)
    expect(webTab(s, "b")).toMatchObject({ url: "https://new.com", pendingUrl: "https://new.com", loading: true, error: undefined })
    expect(run([{ type: "navigateWeb", id: "b", url: "javascript:1" }], s)).toBe(s)
  })

  it("webState：主进程推来的状态合并进对应标签页；url 为空时保留原来的；别的标签页和文件标签页不受影响", () => {
    let s = run([web("w1", "https://a.com"), web("w2", "https://b.com"), file("f", "/a.txt")])
    s = run([{ type: "webState", state: { tabId: "w1", url: "", title: "标题", loading: false, canGoBack: true, canGoForward: false, favicon: "https://a.com/i.png" } }], s)
    expect(webTab(s, "w1")).toMatchObject({ url: "https://a.com", title: "标题", loading: false, canGoBack: true, favicon: "https://a.com/i.png" })
    expect(webTab(s, "w2")).toMatchObject({ title: "", loading: true })
    // 状态推送的 tabId 恰好是文件标签页的 id：忽略
    const same = run([{ type: "webState", state: { tabId: "f", url: "https://x.com", title: "x", loading: false, canGoBack: false, canGoForward: false } }], s)
    expect(same.tabs.find((t) => t.id === "f")).toEqual(s.tabs.find((t) => t.id === "f"))
  })
})

describe("文件标签页的操作", () => {
  it("reloadFile / asText 都让文件重新读取；asText 记下用户的选择", () => {
    let s = run([file("a", "/a.bin")])
    s = run([{ type: "reloadFile", id: "a" }], s)
    expect(s.tabs[0]).toMatchObject({ reload: 1 })
    s = run([{ type: "asText", id: "a" }], s)
    expect(s.tabs[0]).toMatchObject({ reload: 2, asText: true })
  })

  it("对网页标签页的 reloadFile / asText 无效", () => {
    const s = run([web("w", "https://a.com")])
    expect(run([{ type: "reloadFile", id: "w" }, { type: "asText", id: "w" }], s)).toEqual(s)
  })
})

describe("切换、关闭、收起", () => {
  const three = () => run([file("a", "/a.txt"), file("b", "/b.txt"), file("c", "/c.txt")])

  it("activate：切换并展开；不存在的 id 忽略", () => {
    let s = run([{ type: "setOpen", open: false }], three())
    s = run([{ type: "activate", id: "a" }], s)
    expect(s).toMatchObject({ activeId: "a", open: true })
    expect(run([{ type: "activate", id: "zzz" }], s)).toBe(s)
  })

  it("关掉当前标签页：切到右边那个；右边没有就切到左边", () => {
    let s = run([{ type: "activate", id: "b" }, { type: "close", id: "b" }], three())
    expect(s.activeId).toBe("c")
    s = run([{ type: "close", id: "c" }], s)
    expect(s.activeId).toBe("a")
  })

  it("关掉的不是当前标签页：当前的不变", () => {
    const s = run([{ type: "close", id: "a" }], three())
    expect(s.activeId).toBe("c")
    expect(ids(s)).toEqual(["b", "c"])
  })

  it("关掉最后一个：面板收起，没有当前标签页", () => {
    const s = run([file("a", "/a.txt"), { type: "close", id: "a" }])
    expect(s).toEqual({ tabs: [], activeId: null, open: false })
  })

  it("关不存在的 id：原样", () => {
    const s = three()
    expect(run([{ type: "close", id: "nope" }], s)).toBe(s)
  })

  it("setOpen：收起时标签页保留；没有标签页时不能展开", () => {
    const s = run([{ type: "setOpen", open: false }], three())
    expect(s.open).toBe(false)
    expect(ids(s)).toEqual(["a", "b", "c"])
    expect(run([{ type: "setOpen", open: true }], INITIAL_PREVIEW_STATE)).toBe(INITIAL_PREVIEW_STATE)
  })
})

describe("标签页数量上限", () => {
  it("超过上限丢最早打开的，新开的（当前正看的）一定留下", () => {
    const opens = Array.from({ length: MAX_PREVIEW_TABS + 3 }, (_, i) => file(`t${i}`, `/f/${i}.txt`))
    const s = run(opens)
    expect(s.tabs).toHaveLength(MAX_PREVIEW_TABS)
    expect(ids(s)[0]).toBe("t3")
    expect(s.activeId).toBe(`t${MAX_PREVIEW_TABS + 2}`)
  })
})

describe("removedWebTabIds", () => {
  it("只列出被移除的网页标签页（主进程里对应的视图要销毁）", () => {
    const prev = run([web("w1", "https://a.com"), file("f", "/a.txt"), web("w2", "https://b.com")])
    const next = run([{ type: "close", id: "w1" }, { type: "close", id: "f" }], prev)
    expect(removedWebTabIds(prev, next)).toEqual(["w1"])
    expect(removedWebTabIds(prev, prev)).toEqual([])
  })

  it("标签页被上限淘汰也算移除", () => {
    const prev = run([web("w0", "https://w0.com"), ...Array.from({ length: MAX_PREVIEW_TABS - 1 }, (_, i) => file(`f${i}`, `/f/${i}.txt`))])
    const next = run([file("extra", "/f/extra.txt")], prev)
    expect(removedWebTabIds(prev, next)).toEqual(["w0"])
  })
})

describe("tabTitle", () => {
  it("文件用文件名；网页优先用标题，没有就用主机名，空白页叫“新标签页”", () => {
    const s = run([file("f", "/a/readme.md"), web("w", "https://www.example.com/x"), { type: "openBlankWeb", id: "b" }])
    expect(tabTitle(s.tabs[0])).toBe("readme.md")
    expect(tabTitle(s.tabs[1])).toBe("example.com")
    expect(tabTitle(s.tabs[2])).toBe("新标签页")
    const titled = run([{ type: "webState", state: { tabId: "w", url: "", title: "示例站点", loading: false, canGoBack: false, canGoForward: false } }], s)
    expect(tabTitle(titled.tabs[1])).toBe("示例站点")
  })
})

describe("opensInApp（点链接去哪儿）", () => {
  it("没有预览面板（手机端）：永远交给系统浏览器", () => {
    for (const mode of ["internal", "external"] as const) {
      for (const modifierHeld of [false, true]) expect(opensInApp({ available: false, mode, modifierHeld })).toBe(false)
    }
  })
  it("默认内置：普通点击在应用内开，按住 Ctrl 反过来", () => {
    expect(opensInApp({ available: true, mode: "internal", modifierHeld: false })).toBe(true)
    expect(opensInApp({ available: true, mode: "internal", modifierHeld: true })).toBe(false)
  })
  it("默认系统：普通点击交给系统，按住 Ctrl 才在应用内开", () => {
    expect(opensInApp({ available: true, mode: "external", modifierHeld: false })).toBe(false)
    expect(opensInApp({ available: true, mode: "external", modifierHeld: true })).toBe(true)
  })
})
