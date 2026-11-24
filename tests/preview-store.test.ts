import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPreviewStore, previewSessionId, type PreviewHost, type PreviewStore } from "../src/renderer/components/preview/preview-store"
import { INITIAL_PREVIEW_STATE, type WebTab } from "../src/renderer/components/preview/preview-tabs"

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

function make(): PreviewStore {
  seq = 0
  return createPreviewStore(host, { newId: () => `t${++seq}` })
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

describe("文件夹标签页", () => {
  it("openDir 开在对应会话里，navigateDir 换文件夹；全程不惊动主进程的网页视图", () => {
    store.openDir(A, { path: "D:\\proj\\a\\docs" })
    expect(tabs(idA)).toEqual([{ id: "t1", kind: "dir", sessionKey: A, path: "D:\\proj\\a\\docs", reload: 0 }])
    store.navigateDir("t1", "D:\\proj\\a\\docs\\img")
    expect(tabs(idA)[0]).toMatchObject({ kind: "dir", path: "D:\\proj\\a\\docs\\img" })
    store.close("t1")
    expect(opened).toEqual([])
    expect(closed).toEqual([])
  })

  it("navigateDir 按标签页 id 找到它所在的会话，别的会话不受影响", () => {
    store.openDir(A, { path: "D:\\a" })
    store.openDir(B, { path: "D:\\b" })
    const before = store.view(idA)
    store.navigateDir("t2", "D:\\b\\sub")
    expect(tabs(idB)[0]).toMatchObject({ path: "D:\\b\\sub" })
    expect(store.view(idA)).toBe(before)
  })

  it("已经在那个文件夹、标签页不存在：不通知订阅者", () => {
    store.openDir(A, { path: "D:\\a" })
    const listener = vi.fn()
    store.subscribe(listener)
    store.navigateDir("t1", "D:\\a")
    store.navigateDir("nope", "D:\\x")
    expect(listener).not.toHaveBeenCalled()
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

  it("网页里新开窗口：开在发起它的标签页所在的会话，不开在别的会话里", () => {
    store.openWeb(A, "https://a.com")
    store.openFile(B, { path: "/b.md", name: "b.md" })
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

  it("控制器只订阅当前会话的那一份；网页新开窗口按发起它的标签页走", () => {
    expect(context).toContain("useSyncExternalStore(store.subscribe")
    expect(context).toContain("store.openWebFrom(p.fromTabId, p.url)")
    expect(context).toContain("store.dispose()")
    expect(context).not.toContain("useReducer")
  })
})