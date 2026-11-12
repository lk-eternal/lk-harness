import { describe, expect, it } from "vitest"
import { opensInApp } from "../src/renderer/components/preview/link-mode"
import {
  INITIAL_PREVIEW_STATE, MAX_PREVIEW_TABS, NO_SESSIONS, ownerSession, pickDiscards, previewReducer, previewSessionsReducer, releasedWebTabIds,
  sessionPreview, tabTitle,
  type PreviewAction, type PreviewSessions, type PreviewSessionsAction, type PreviewState, type WebTab,
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

describe("webState 的重绘开销", () => {
  const push = (id: string, patch: Partial<{ url: string; title: string; loading: boolean; canGoBack: boolean; error: string }> = {}): PreviewAction => ({
    type: "webState", state: { tabId: id, url: "https://a.com", title: "A", loading: false, canGoBack: false, canGoForward: false, ...patch },
  })

  it("推来的状态和标签页上已有的完全一样：原样返回同一个对象，订阅它的界面不用重绘", () => {
    const s = run([web("w1", "https://a.com"), push("w1")])
    expect(run([push("w1")], s)).toBe(s)
    expect(run([push("w1", { url: "" })], s)).toBe(s)
  })

  it("哪怕一个字段变了也要更新", () => {
    const s = run([web("w1", "https://a.com"), push("w1")])
    for (const patch of [{ title: "B" }, { loading: true }, { canGoBack: true }, { error: "boom" }, { url: "https://a.com/x" }]) {
      expect(run([push("w1", patch)], s)).not.toBe(s)
    }
  })

  it("不认识的标签页：原样", () => {
    const s = run([web("w1", "https://a.com")])
    expect(run([push("nope")], s)).toBe(s)
  })
})

describe("换出去和换回来（discard / revive）", () => {
  const live = () => run([web("w1", "https://a.com"), web("w2", "https://b.com"), file("f", "/a.txt"), { type: "openBlankWeb", id: "blank" }])

  it("discard：只换出有页面的网页标签页，网址和标题留着，清掉加载中、待加载、前进后退和错误", () => {
    let s = live()
    s = run([{ type: "webState", state: { tabId: "w1", url: "https://a.com/p", title: "标题", loading: true, canGoBack: true, canGoForward: true, error: "x" } }], s)
    s = run([{ type: "discard", ids: ["w1", "f", "blank", "nope"] }], s)
    expect(webTab(s, "w1")).toMatchObject({ discarded: true, url: "https://a.com/p", title: "标题", loading: false, canGoBack: false, canGoForward: false })
    expect(webTab(s, "w1").pendingUrl).toBeUndefined()
    expect(webTab(s, "w1").error).toBeUndefined()
    // 文件标签页、空白标签页（主进程里没有视图）、没点名的不动
    expect(s.tabs.find((t) => t.id === "f")).toEqual(live().tabs.find((t) => t.id === "f"))
    expect(webTab(s, "blank").discarded).toBeUndefined()
    expect(webTab(s, "w2").discarded).toBeUndefined()
  })

  it("discard 没有可换的：原样；已经换出去的不重复", () => {
    const s = live()
    expect(run([{ type: "discard", ids: ["f", "blank"] }], s)).toBe(s)
    const once = run([{ type: "discard", ids: ["w1"] }], s)
    expect(run([{ type: "discard", ids: ["w1"] }], once)).toBe(once)
  })

  it("换出去的标签页：晚到的网页状态不能盖掉它", () => {
    const s = run([{ type: "discard", ids: ["w1"] }], live())
    expect(run([{ type: "webState", state: { tabId: "w1", url: "https://a.com", title: "晚到", loading: true, canGoBack: true, canGoForward: false } }], s)).toBe(s)
  })

  it("revive：换回来，重新加载它最后停留的网址", () => {
    const s = run([{ type: "discard", ids: ["w1"] }, { type: "revive", id: "w1" }], live())
    expect(webTab(s, "w1")).toMatchObject({ url: "https://a.com", pendingUrl: "https://a.com", loading: true })
    expect(webTab(s, "w1").discarded).toBeUndefined()
  })

  it("revive 没有可换回的（没换出去、不是网页、不存在）：原样", () => {
    const s = live()
    expect(run([{ type: "revive", id: "w1" }, { type: "revive", id: "f" }, { type: "revive", id: "nope" }], s)).toBe(s)
  })

  it("换出去的标签页在地址栏里跳转：当作新的加载，不再是换出状态", () => {
    const s = run([{ type: "discard", ids: ["w1"] }, { type: "navigateWeb", id: "w1", url: "https://new.com" }], live())
    expect(webTab(s, "w1")).toMatchObject({ url: "https://new.com", pendingUrl: "https://new.com", loading: true })
    expect(webTab(s, "w1").discarded).toBeUndefined()
  })

  it("关掉换出去的标签页：和关别的一样", () => {
    const s = run([{ type: "discard", ids: ["w1"] }, { type: "close", id: "w1" }], live())
    expect(ids(s)).toEqual(["w2", "f", "blank"])
  })
})

// ── 每个会话各一份 ─────────────────────────────────────────────────────────

const A = "app:main::d:/proj/a"
const B = "app:main::d:/proj/b"
const inS = (session: string, action: PreviewAction): PreviewSessionsAction => ({ type: "in", session, action })
const onTab = (tabId: string, action: PreviewAction): PreviewSessionsAction => ({ type: "byTab", tabId, action })
const runAll = (actions: PreviewSessionsAction[], from: PreviewSessions = NO_SESSIONS) => actions.reduce(previewSessionsReducer, from)
const idsIn = (s: PreviewSessions, session: string) => sessionPreview(s, session).tabs.map((t) => t.id)

describe("标签页跟着会话走", () => {
  it("A 里开的文件和网页，B 里看不到；各会话各有自己的当前标签页和展开状态", () => {
    const s = runAll([inS(A, file("a1", "/w/a.md", A)), inS(A, web("a2", "https://a.com")), inS(B, file("b1", "/w/b.md", B))])
    expect(idsIn(s, A)).toEqual(["a1", "a2"])
    expect(idsIn(s, B)).toEqual(["b1"])
    expect(sessionPreview(s, A)).toMatchObject({ activeId: "a2", open: true })
    expect(sessionPreview(s, B)).toMatchObject({ activeId: "b1", open: true })
  })

  it("同一个文件、同一个网址可以在不同会话里各开一个（只在同一会话里合并）", () => {
    const s = runAll([
      inS(A, file("a1", "/w/x.md", A)), inS(B, file("b1", "/w/x.md", B)),
      inS(A, web("a2", "https://x.com")), inS(B, web("b2", "https://x.com")),
      inS(A, file("a3", "/w/x.md", A)),
    ])
    expect(idsIn(s, A)).toEqual(["a1", "a2"])
    expect(idsIn(s, B)).toEqual(["b1", "b2"])
  })

  it("收起、切换、关闭只影响自己的会话", () => {
    let s = runAll([inS(A, file("a1", "/a1")), inS(A, file("a2", "/a2")), inS(B, file("b1", "/b1"))])
    s = runAll([inS(A, { type: "setOpen", open: false })], s)
    expect(sessionPreview(s, A).open).toBe(false)
    expect(sessionPreview(s, B).open).toBe(true)
    s = runAll([onTab("a1", { type: "activate", id: "a1" })], s)
    expect(sessionPreview(s, A)).toMatchObject({ activeId: "a1", open: true })
    expect(sessionPreview(s, B)).toMatchObject({ activeId: "b1" })
    s = runAll([onTab("a1", { type: "close", id: "a1" })], s)
    expect(idsIn(s, A)).toEqual(["a2"])
    expect(idsIn(s, B)).toEqual(["b1"])
  })

  it("标签页数量上限按会话算：A 开满了不占 B 的名额", () => {
    const fill = Array.from({ length: MAX_PREVIEW_TABS + 2 }, (_, i) => inS(A, file(`a${i}`, `/f/${i}`)))
    const s = runAll([...fill, inS(B, file("b0", "/b/0"))])
    expect(idsIn(s, A)).toHaveLength(MAX_PREVIEW_TABS)
    expect(idsIn(s, B)).toEqual(["b0"])
  })

  it("byTab：按标签页 id 找到它所在的会话；找不到的忽略", () => {
    const s = runAll([inS(A, web("a1", "https://a.com")), inS(B, web("b1", "https://b.com"))])
    expect(ownerSession(s, "b1")).toBe(B)
    expect(ownerSession(s, "zzz")).toBeUndefined()
    const next = runAll([onTab("b1", { type: "webState", state: { tabId: "b1", url: "", title: "B站", loading: false, canGoBack: false, canGoForward: false } })], s)
    expect(sessionPreview(next, B).tabs[0]).toMatchObject({ title: "B站" })
    // 没动的那个会话是同一个对象：订阅它的界面不会重绘
    expect(sessionPreview(next, A)).toBe(sessionPreview(s, A))
    expect(runAll([onTab("zzz", { type: "close", id: "zzz" })], s)).toBe(s)
  })

  it("网页里新开窗口（byTab + openWeb）：开在发起它的标签页所在的会话，当前看着哪个会话无关", () => {
    const s = runAll([inS(A, web("a1", "https://a.com")), inS(B, file("b1", "/b1")), onTab("a1", { type: "openWeb", id: "a2", url: "https://pop.com" })])
    expect(idsIn(s, A)).toEqual(["a1", "a2"])
    expect(idsIn(s, B)).toEqual(["b1"])
  })

  it("关掉会话里最后一个标签页：这个会话不再留记录", () => {
    const s = runAll([inS(A, file("a1", "/a")), onTab("a1", { type: "close", id: "a1" })])
    expect(s).toEqual({})
    expect(sessionPreview(s, A)).toBe(INITIAL_PREVIEW_STATE)
  })

  it("没有标签页的会话：拿到共用的空状态（引用稳定，可以直接当订阅快照）；没有会话也一样", () => {
    expect(sessionPreview(NO_SESSIONS, A)).toBe(INITIAL_PREVIEW_STATE)
    expect(sessionPreview(NO_SESSIONS, null)).toBe(INITIAL_PREVIEW_STATE)
    expect(sessionPreview(runAll([inS(A, file("a1", "/a"))]), null)).toBe(INITIAL_PREVIEW_STATE)
  })

  it("对一个没有标签页的会话做不起作用的事：原样（不凭空造出空记录）", () => {
    expect(runAll([inS(A, { type: "setOpen", open: true })])).toBe(NO_SESSIONS)
    expect(runAll([inS(A, { type: "close", id: "x" })])).toBe(NO_SESSIONS)
    expect(runAll([inS(A, web("w", "javascript:1"))])).toBe(NO_SESSIONS)
  })

  it("drop：会话没了，它的标签页全部丢掉，别的会话不动；不存在的会话原样", () => {
    const s = runAll([inS(A, file("a1", "/a")), inS(B, file("b1", "/b"))])
    const next = runAll([{ type: "drop", session: A }], s)
    expect(Object.keys(next)).toEqual([B])
    expect(sessionPreview(next, B)).toBe(sessionPreview(s, B))
    expect(runAll([{ type: "drop", session: "nope" }], s)).toBe(s)
  })

  it("discard 跨会话：点名的标签页不管在哪个会话里都换出去，别的不动", () => {
    const s = runAll([inS(A, web("a1", "https://a.com")), inS(B, web("b1", "https://b.com")), inS(B, web("b2", "https://c.com"))])
    const next = runAll([{ type: "discard", ids: ["a1", "b2"] }], s)
    expect((sessionPreview(next, A).tabs[0] as WebTab).discarded).toBe(true)
    expect(sessionPreview(next, B).tabs.map((t) => (t as WebTab).discarded)).toEqual([undefined, true])
    expect(runAll([{ type: "discard", ids: ["nope"] }], s)).toBe(s)
  })
})

describe("releasedWebTabIds（主进程里的网页视图要销毁哪些）", () => {
  const two = () => runAll([inS(A, web("a1", "https://a.com")), inS(A, file("af", "/a")), inS(B, web("b1", "https://b.com")), inS(B, { type: "openBlankWeb", id: "bb" })])

  it("关掉的、会话没了的、换出去的网页标签页；文件标签页和没有页面的空白标签页不算", () => {
    const prev = two()
    expect(releasedWebTabIds(prev, runAll([onTab("a1", { type: "close", id: "a1" }), onTab("af", { type: "close", id: "af" })], prev))).toEqual(["a1"])
    expect(releasedWebTabIds(prev, runAll([{ type: "drop", session: B }], prev))).toEqual(["b1"])
    expect(releasedWebTabIds(prev, runAll([{ type: "discard", ids: ["a1", "bb"] }], prev))).toEqual(["a1"])
    expect(releasedWebTabIds(prev, prev)).toEqual([])
  })

  it("标签页被上限淘汰也算", () => {
    const prev = runAll([inS(A, web("w0", "https://w0.com")), ...Array.from({ length: MAX_PREVIEW_TABS - 1 }, (_, i) => inS(A, file(`f${i}`, `/f/${i}`)))])
    const next = runAll([inS(A, file("extra", "/f/extra"))], prev)
    expect(releasedWebTabIds(prev, next)).toEqual(["w0"])
  })

  it("换出去的标签页再被关掉：视图早就销毁了，不重复销毁", () => {
    const prev = runAll([{ type: "discard", ids: ["a1"] }], two())
    expect(releasedWebTabIds(prev, runAll([onTab("a1", { type: "close", id: "a1" })], prev))).toEqual([])
  })

  it("换回来（revive）不算销毁", () => {
    const prev = runAll([{ type: "discard", ids: ["a1"] }], two())
    expect(releasedWebTabIds(prev, runAll([onTab("a1", { type: "revive", id: "a1" })], prev))).toEqual([])
  })
})

describe("pickDiscards（网页视图超过上限时换出谁）", () => {
  const many = (n: number, spread = false) => runAll(Array.from({ length: n }, (_, i) => inS(spread && i % 2 ? B : A, web(`w${i}`, `https://w${i}.com`))))
  const used = (...pairs: Array<[string, number]>) => new Map(pairs)

  it("没超上限：不换", () => {
    expect(pickDiscards(many(4), used(), null, 4)).toEqual([])
  })

  it("超几个换几个，最久没看的先走（跨会话比）", () => {
    const s = many(5, true)
    expect(pickDiscards(s, used(["w0", 10], ["w1", 3], ["w2", 7], ["w3", 1], ["w4", 9]), null, 3)).toEqual(["w3", "w1"])
  })

  it("没有记录的按最久没看算；同样久的按先开的先走", () => {
    expect(pickDiscards(many(4), used(["w0", 5]), null, 2)).toEqual(["w1", "w2"])
  })

  it("正在看的那个一定留下，哪怕它最久没被记录", () => {
    expect(pickDiscards(many(3), used(["w0", 9], ["w1", 8], ["w2", 7]), "w2", 2)).toEqual(["w1"])
  })

  it("已经换出去的、文件标签页、空白标签页不占名额", () => {
    const s = runAll([
      ...Array.from({ length: 3 }, (_, i) => inS(A, web(`w${i}`, `https://w${i}.com`))),
      inS(A, file("f", "/f")), inS(A, { type: "openBlankWeb", id: "blank" }),
      { type: "discard", ids: ["w0"] },
    ])
    expect(pickDiscards(s, used(), null, 2)).toEqual([])
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
