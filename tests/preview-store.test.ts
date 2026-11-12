import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPreviewStore, previewSessionId, type PreviewHost, type PreviewStore } from "../src/renderer/components/preview/preview-store"
import { INITIAL_PREVIEW_STATE, MAX_LIVE_WEB_TABS, type WebTab } from "../src/renderer/components/preview/preview-tabs"

const A = "app:main::D:\\proj\\a"
const B = "app:main::D:\\proj\\b"
const C = "app:main::D:\\proj\\c"
const idA = previewSessionId(A)
const idB = previewSessionId(B)
const idC = previewSessionId(C)

let opened: Array<[string, string]>
let closed: string[]
let host: PreviewHost
let seq: number
let store: PreviewStore

function make(maxLiveWeb?: number): PreviewStore {
  seq = 0
  return createPreviewStore(host, { maxLiveWeb, newId: () => `t${++seq}` })
}

beforeEach(() => {
  opened = []
  closed = []
  host = { webOpen: (id, url) => { opened.push([id, url]) }, webClose: (id) => { closed.push(id) } }
  store = make()
})

const tabs = (id: string) => store.view(id).tabs
const web = (tabId: string) => store.all()[ownerKey(tabId)].tabs.find((t) => t.id === tabId) as WebTab
function ownerKey(tabId: string): string {
  for (const [key, s] of Object.entries(store.all())) if (s.tabs.some((t) => t.id === tabId)) return key
  throw new Error(`没有标签页 ${tabId}`)
}
const live = () => Object.values(store.all()).flatMap((s) => s.tabs).filter((t): t is WebTab => t.kind === "web" && !!t.url && !t.discarded)
const pushState = (tabId: string, patch: Partial<{ title: string; loading: boolean; url: string }> = {}) =>
  store.webState({ tabId, url: patch.url ?? "", title: patch.title ?? "", loading: patch.loading ?? false, canGoBack: false, canGoForward: false })

describe("和主进程的接线", () => {
  it("新开网页：网址只交给主进程一次，标签页上的待加载标记随即清掉", () => {
    store.openWeb(A, "https://a.com")
    expect(opened).toEqual([["t1", "https://a.com"]])
    expect(web("t1").pendingUrl).toBeUndefined()
    pushState("t1", { title: "A" })
    store.activate("t1")
    expect(opened).toHaveLength(1)
  })

  it("地址栏跳转：把新网址交给主进程", () => {
    store.openBlankWeb(A)
    expect(opened).toEqual([])
    store.navigate("t1", "https://new.com")
    expect(opened).toEqual([["t1", "https://new.com"]])
  })

  it("关掉网页标签页：销毁主进程里的视图；关文件标签页、空白标签页不惊动主进程", () => {
    store.openWeb(A, "https://a.com")
    store.openFile(A, { path: "/a.md", name: "a.md" })
    store.openBlankWeb(A)
    store.close("t2")
    store.close("t3")
    expect(closed).toEqual([])
    store.close("t1")
    expect(closed).toEqual(["t1"])
  })

  it("网页状态没变化：不通知订阅者（页面里隔一会儿推一条一样的状态，界面不能跟着一直重绘）", () => {
    store.openWeb(A, "https://a.com")
    pushState("t1", { title: "A", url: "https://a.com" })
    const listener = vi.fn()
    store.subscribe(listener)
    pushState("t1", { title: "A", url: "https://a.com" })
    pushState("t1", { title: "A" })
    expect(listener).not.toHaveBeenCalled()
    pushState("t1", { title: "B" })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("会话隔离", () => {
  it("A 里开的标签页，B 的视图里没有；切回 A 还在，展开状态各自保留", () => {
    store.openFile(A, { path: "/a.md", name: "a.md" })
    store.openWeb(A, "https://a.com")
    store.openFile(B, { path: "/b.md", name: "b.md" })
    expect(tabs(idA).map((t) => t.id)).toEqual(["t1", "t2"])
    expect(tabs(idB).map((t) => t.id)).toEqual(["t3"])
    store.setOpen(idA, false)
    expect(store.view(idA).open).toBe(false)
    expect(store.view(idB).open).toBe(true)
    expect(store.view(null)).toBe(INITIAL_PREVIEW_STATE)
    expect(store.view(idC)).toBe(INITIAL_PREVIEW_STATE)
  })

  it("会话键写法不同（盘符大小写、斜杠方向）算同一个会话", () => {
    store.openFile("app:main::D:\\proj\\a", { path: "/a.md", name: "a.md" })
    store.openFile("app:main::d:/proj/a", { path: "/b.md", name: "b.md" })
    expect(tabs(idA)).toHaveLength(2)
    expect(Object.keys(store.all())).toEqual([idA])
  })

  it("别的会话里的网页状态变了：当前会话的视图还是同一个对象，界面不会重绘；变的是自己这个会话才换", () => {
    store.openWeb(A, "https://a.com")
    store.openWeb(B, "https://b.com")
    const viewA = store.view(idA)
    const viewB = store.view(idB)
    pushState("t2", { title: "B 的新标题" })
    expect(store.view(idA)).toBe(viewA)
    expect(store.view(idB)).not.toBe(viewB)
    pushState("t1", { title: "A 的新标题" })
    expect(store.view(idA)).not.toBe(viewA)
  })

  it("网页里新开窗口：开在发起它的标签页所在的会话，用户此刻看着哪个会话无关", () => {
    store.openWeb(A, "https://a.com")
    store.openFile(B, { path: "/b.md", name: "b.md" })
    store.setViewing(idB)
    store.openWebFrom("t1", "https://pop.com")
    expect(tabs(idA).map((t) => (t as WebTab).url)).toEqual(["https://a.com", "https://pop.com"])
    expect(tabs(idB)).toHaveLength(1)
    expect(opened[opened.length - 1]).toEqual(["t3", "https://pop.com"])
    // 发起它的标签页已经关了：忽略，不开在别处
    store.close("t1")
    store.openWebFrom("t1", "https://late.com")
    expect(Object.values(store.all()).flatMap((s) => s.tabs).some((t) => (t as WebTab).url === "https://late.com")).toBe(false)
  })

  it("删除会话：它的标签页全没了，网页视图销毁；别的会话不受影响", () => {
    store.openWeb(A, "https://a.com")
    store.openFile(A, { path: "/a.md", name: "a.md" })
    store.openWeb(B, "https://b.com")
    store.dropSession(idA)
    expect(store.view(idA)).toBe(INITIAL_PREVIEW_STATE)
    expect(closed).toEqual(["t1"])
    expect(tabs(idB)).toHaveLength(1)
    // 重复删、删不存在的：不报错，不再惊动主进程
    store.dropSession(idA)
    store.dropSession("nope")
    expect(closed).toEqual(["t1"])
  })

  it("卸载：所有会话的网页视图都销毁，状态清空", () => {
    store.openWeb(A, "https://a.com")
    store.openWeb(B, "https://b.com")
    store.openFile(B, { path: "/b.md", name: "b.md" })
    store.dispose()
    expect(closed.sort()).toEqual(["t1", "t2"])
    expect(store.all()).toEqual({})
  })
})

describe("同时活着的网页视图有上限（性能兜底）", () => {
  it("超过上限：最久没看的会话里的网页被换出去（视图销毁），标签页还在、网址留着", () => {
    store = make(3)
    store.setViewing(idC)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2
    store.openWeb(C, "https://c1.com") // t3
    expect(closed).toEqual([])
    store.openWeb(C, "https://c2.com") // t4：超了一个
    expect(closed).toEqual(["t1"])
    expect(web("t1")).toMatchObject({ discarded: true, url: "https://a.com" })
    expect(tabs(idA)).toHaveLength(1)
    expect(live().map((t) => t.id).sort()).toEqual(["t2", "t3", "t4"])
  })

  it("「最久没看」按被看到的先后算，不是按开的先后：刚点回来看过的不会先走", () => {
    store = make(3)
    store.setViewing(idA)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2
    store.openWeb(C, "https://c.com") // t3
    store.setViewing(idA) // 没变化，不算
    store.setViewing(idB)
    store.setViewing(idA) // A 的 t1 刚被看过
    store.openWeb(A, "https://a2.com") // t4，超了一个
    // t1 刚看过，t2 在切到 B 时看过，t3 从开出来就没再看过 → t3 先走（按开的先后算的话会是 t1）
    expect(closed).toEqual(["t3"])
  })

  it("刚离开的会话里的网页，比一直在后台没看过的更晚走（看了多久都算到离开那一刻）", () => {
    store = make(2)
    store.setViewing(idA)
    store.openWeb(A, "https://a.com") // t1：在 A 里一直看着
    store.openWeb(B, "https://b.com") // t2：后台会话里开的，没人看过
    store.setViewing(idC) // 离开 A
    store.openWeb(C, "https://c.com") // t3 → 超了一个
    expect(closed).toEqual(["t2"])
    expect(web("t1").discarded).toBeUndefined()
  })

  it("在当前会话里切换标签页：被换下去的那个算刚看过", () => {
    store = make(3)
    store.setViewing(idA)
    store.openWeb(A, "https://a1.com") // t1
    store.openWeb(B, "https://b.com") // t2（后台）
    store.openWeb(C, "https://c.com") // t3（后台）
    store.openWeb(A, "https://a2.com") // t4 → 超了一个：t1 被换下去时才算刚看过，后台的 t2 先走
    expect(closed).toEqual(["t2"])
  })

  it("正在看的网页标签页不会被换出去，哪怕只有它是最老的", () => {
    store = make(2)
    store.openWeb(A, "https://a.com") // t1
    store.setViewing(idA)
    store.openWeb(B, "https://b.com") // t2
    store.openWeb(C, "https://c.com") // t3 → 超了；t1 是正在看的，走 t2
    expect(closed).toEqual(["t2"])
    expect(web("t1").discarded).toBeUndefined()
  })

  it("切到有被换出去的网页的会话：立刻换回来（重新加载最后的网址），同时再按上限换出别的", () => {
    store = make(2)
    store.setViewing(idC)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2
    store.openWeb(C, "https://c.com") // t3 → t1 被换出
    expect(web("t1").discarded).toBe(true)
    opened.length = 0
    closed.length = 0
    store.setViewing(idA)
    expect(web("t1").discarded).toBeUndefined()
    expect(opened).toEqual([["t1", "https://a.com"]])
    expect(web("t1")).toMatchObject({ loading: true })
    expect(web("t1").pendingUrl).toBeUndefined()
    expect(closed).toEqual(["t2"]) // t2 比 t3 更久没看
    expect(live()).toHaveLength(2)
  })

  it("换回来要通知界面（订阅者收到一次通知）；视图没变化的切换不通知", () => {
    store = make(1)
    store.setViewing(idB)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2 → t1 换出
    const listener = vi.fn()
    store.subscribe(listener)
    store.setViewing(idB)
    expect(listener).not.toHaveBeenCalled()
    store.setViewing(idA)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.view(idA).tabs[0]).toMatchObject({ loading: true })
  })

  it("面板收起的会话：切过去不换回来（没人看），点开面板时才换回来", () => {
    store = make(1)
    store.setViewing(idB)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2 → t1 换出
    store.setOpen(idA, false)
    opened.length = 0
    store.setViewing(idA)
    expect(web("t1").discarded).toBe(true)
    expect(opened).toEqual([])
    store.setOpen(idA, true)
    expect(web("t1").discarded).toBeUndefined()
    expect(opened).toEqual([["t1", "https://a.com"]])
  })

  it("在看的会话里自己点开已换出的标签页：换回来", () => {
    store = make(2)
    store.setViewing(idA)
    store.openWeb(A, "https://a1.com") // t1
    store.openWeb(A, "https://a2.com") // t2
    store.openWeb(A, "https://a3.com") // t3 → t1 换出（t3 是当前）
    expect(web("t1").discarded).toBe(true)
    opened.length = 0
    store.activate("t1")
    expect(opened).toEqual([["t1", "https://a1.com"]])
    expect(live()).toHaveLength(2)
  })

  it("换出去之后主进程晚到的网页状态被忽略：标签页保持换出状态", () => {
    store = make(1)
    store.setViewing(idB)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2 → t1 换出
    const before = store.view(idA)
    pushState("t1", { title: "晚到", loading: true })
    expect(store.view(idA)).toBe(before)
  })

  it("关掉换出去的标签页：不重复销毁", () => {
    store = make(1)
    store.setViewing(idB)
    store.openWeb(A, "https://a.com") // t1
    store.openWeb(B, "https://b.com") // t2 → t1 换出
    closed.length = 0
    store.close("t1")
    expect(closed).toEqual([])
  })

  it("正常使用（每会话几个网页）不会触发换出", () => {
    store.setViewing(idA)
    for (const key of [A, B, C]) for (let i = 0; i < 3; i++) store.openWeb(key, `https://${previewSessionId(key).slice(-1)}${i}.com`)
    expect(live().length).toBeLessThanOrEqual(MAX_LIVE_WEB_TABS)
    expect(closed).toEqual([])
  })

  it("一直开到远超上限：活着的视图数从不超过上限", () => {
    store = make(4)
    store.setViewing(idA)
    const keys = [A, B, C]
    for (let i = 0; i < 20; i++) {
      store.openWeb(keys[i % 3], `https://s${i}.com`)
      expect(live().length).toBeLessThanOrEqual(4)
    }
    // 每个会话当前正看的标签页没被换出
    expect(web(store.view(idA).activeId!).discarded).toBeUndefined()
  })

  it("销毁和加载的次数对得上：开 N 个、换出 M 个，主进程里恰好活着 N-M 个", () => {
    store = make(3)
    store.setViewing(idA)
    for (let i = 0; i < 7; i++) store.openWeb([A, B][i % 2], `https://s${i}.com`)
    const alive = new Set<string>()
    // 回放：按调用顺序模拟主进程
    for (const [id] of opened) alive.add(id)
    for (const id of closed) alive.delete(id)
    expect([...alive].sort()).toEqual(live().map((t) => t.id).sort())
  })
})

describe("长时间使用不攒东西", () => {
  it("反复开关文件和网页标签页、删会话：「最近看过」的记录只留活着视图的网页标签页", () => {
    store.setViewing(idA)
    for (let round = 0; round < 30; round++) {
      store.openFile(A, { path: `/f/${round}.md`, name: `${round}.md` })
      store.openWeb(A, `https://w${round}.com`)
      store.openWeb(B, `https://v${round}.com`)
      store.openBlankWeb(B)
      store.setViewing(round % 2 ? idA : idB)
      if (round % 3 === 0) store.dropSession(idB)
      for (const t of store.view(idA).tabs.slice(0, 2)) store.close(t.id)
    }
    expect(store.trackedTabCount()).toBeLessThanOrEqual(live().length)
    store.dispose()
    expect(store.trackedTabCount()).toBe(0)
  })

  it("每个会话的标签页数量有上限，旧的被淘汰后它的网页视图也销毁（不会越攒越多）", () => {
    for (let i = 0; i < 50; i++) store.openWeb(A, `https://w${i}.com`)
    expect(tabs(idA)).toHaveLength(12)
    expect(live()).toHaveLength(12)
    expect(closed).toHaveLength(38)
  })
})

describe("订阅", () => {
  it("取消订阅后不再收到通知", () => {
    const listener = vi.fn()
    const off = store.subscribe(listener)
    store.openFile(A, { path: "/a.md", name: "a.md" })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    store.openFile(A, { path: "/b.md", name: "b.md" })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("什么都没变的操作不通知", () => {
    const listener = vi.fn()
    store.subscribe(listener)
    store.close("nope")
    store.activate("nope")
    store.setOpen(idA, true)
    store.dropSession(idA)
    store.openWeb(A, "javascript:alert(1)")
    expect(listener).not.toHaveBeenCalled()
  })
})

describe("界面接线（真实 hook 要 DOM 环境，这里守住关键的几处接线不被改掉）", () => {
  const chatPage = readFileSync("src/renderer/pages/ChatPage.tsx", "utf8")
  const context = readFileSync("src/renderer/components/preview/PreviewContext.tsx", "utf8")
  const between = (src: string, start: string, end: string) => {
    const i = src.indexOf(start)
    expect(i, `找不到 ${start}`).toBeGreaterThanOrEqual(0)
    return src.slice(i, src.indexOf(end, i))
  }

  it("删会话、删项目：对话页要把这个会话的预览标签页一并关掉", () => {
    expect(between(chatPage, "const deleteSession = async", "const clearAll")).toContain("preview.dropSession(t.sessionKey)")
    expect(between(chatPage, "const projectDeleted = async", "const channelOf")).toContain("preview.dropSession(t.sessionKey)")
  })

  it("控制器只订阅当前会话的那一份，并告诉仓库正看着哪个会话；网页新开窗口按发起它的标签页走", () => {
    expect(context).toContain("useSyncExternalStore(store.subscribe")
    expect(context).toContain("store.setViewing(sessionId)")
    expect(context).toContain("store.openWebFrom(p.fromTabId, p.url)")
    expect(context).toContain("store.dispose()")
    expect(context).not.toContain("useReducer")
  })
})