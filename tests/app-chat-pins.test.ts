import { describe, expect, it } from "vitest"
import { isSessionPinned, parsePinnedIds, pinFirst, setSessionPinned } from "../src/shared/app-chat-pins"
import { appChatSessionId } from "../src/shared/app-chat-types"

const tab = (sessionKey: string) => ({ sessionKey })
const keys = (tabs: { sessionKey: string }[]) => tabs.map((t) => t.sessionKey)

describe("整理读到的置顶列表", () => {
  it("正常的列表原样得到", () => {
    expect(parsePinnedIds(["a", "b"])).toEqual(["a", "b"])
  })

  it("没有、格式不对（比如旧版电脑端没有这个字段）：当作没有置顶", () => {
    expect(parsePinnedIds(undefined)).toEqual([])
    expect(parsePinnedIds(null)).toEqual([])
    expect(parsePinnedIds("a")).toEqual([])
    expect(parsePinnedIds({ a: 1 })).toEqual([])
  })

  it("混进别的东西：只留非空字符串，重复的只留一个", () => {
    expect(parsePinnedIds(["a", 1, null, "", { x: 1 }, "a", "b"])).toEqual(["a", "b"])
  })
})

describe("置顶 / 取消置顶", () => {
  it("置顶后能查到，取消后查不到", () => {
    const pinned = setSessionPinned([], "app:chan:D:/work/a", true)
    expect(isSessionPinned(pinned, "app:chan:D:/work/a")).toBe(true)
    expect(isSessionPinned(pinned, "app:chan:D:/work/b")).toBe(false)
    expect(isSessionPinned(setSessionPinned(pinned, "app:chan:D:/work/a", false), "app:chan:D:/work/a")).toBe(false)
  })

  it("只取消指定的那个，别的不动；后置顶的排在后面", () => {
    const a = appChatSessionId("a")
    const b = appChatSessionId("b")
    expect(setSessionPinned([a, b], "a", false)).toEqual([b])
    expect(setSessionPinned([a], "b", true)).toEqual([a, b])
  })

  it("已经是目标状态：原样返回同一个数组（不触发多余的写盘和刷新）", () => {
    const pinned = setSessionPinned([], "a", true)
    expect(setSessionPinned(pinned, "a", true)).toBe(pinned)
    const empty: string[] = []
    expect(setSessionPinned(empty, "a", false)).toBe(empty)
  })

  it("路径分隔符、大小写写法不同的同一个会话，认作同一个（电脑和手机写法可能不一样）", () => {
    const pinned = setSessionPinned([], "app:chan:D:\\Work\\Proj", true)
    expect(isSessionPinned(pinned, "app:chan:d:/work/proj")).toBe(true)
    expect(setSessionPinned(pinned, "app:chan:d:/work/proj", true)).toBe(pinned)
    expect(setSessionPinned(pinned, "app:chan:d:/work/proj", false)).toEqual([])
  })
})

describe("置顶的排在最前面", () => {
  const ordered = [tab("a"), tab("b"), tab("c"), tab("d")]

  it("没有置顶：顺序不变", () => {
    expect(keys(pinFirst(ordered, []))).toEqual(["a", "b", "c", "d"])
  })

  it("置顶的挪到最前，两组内部各自保持原顺序", () => {
    const ids = [appChatSessionId("d"), appChatSessionId("b")]
    expect(keys(pinFirst(ordered, ids))).toEqual(["b", "d", "a", "c"])
  })

  it("置顶之间的顺序跟传入的顺序（最近对话）走，跟置顶先后无关", () => {
    const ids = [appChatSessionId("c"), appChatSessionId("a")]
    expect(keys(pinFirst(ordered, ids))).toEqual(["a", "c", "b", "d"])
  })

  it("置顶列表里有已经不存在的会话：忽略它", () => {
    expect(keys(pinFirst(ordered, [appChatSessionId("gone"), appChatSessionId("c")]))).toEqual(["c", "a", "b", "d"])
  })

  it("全都置顶了：顺序不变", () => {
    expect(keys(pinFirst(ordered, ordered.map((t) => appChatSessionId(t.sessionKey))))).toEqual(["a", "b", "c", "d"])
  })

  it("不改传入的数组，也保留会话上的其它字段", () => {
    const input = [{ sessionKey: "a", label: "A" }, { sessionKey: "b", label: "B" }]
    const out = pinFirst(input, [appChatSessionId("b")])
    expect(out).toEqual([{ sessionKey: "b", label: "B" }, { sessionKey: "a", label: "A" }])
    expect(input.map((t) => t.sessionKey)).toEqual(["a", "b"])
  })

  it("路径写法不同也认得出：会话键里的目录大小写、分隔符混写", () => {
    const tabs = [tab("app:chan:D:/work/x"), tab("app:chan:D:\\Work\\Y")]
    expect(keys(pinFirst(tabs, [appChatSessionId("app:chan:d:/work/y")]))).toEqual(["app:chan:D:\\Work\\Y", "app:chan:D:/work/x"])
  })
})
