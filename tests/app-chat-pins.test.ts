import { describe, expect, it } from "vitest"
import { isSessionPinned, movePinned, parsePinnedIds, parsePinPlacement, pinFirst, setSessionPinned } from "../src/shared/app-chat-pins"
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

  it("只取消指定的那个，别的不动；新置顶的放在最前面", () => {
    const a = appChatSessionId("a")
    const b = appChatSessionId("b")
    expect(setSessionPinned([a, b], "a", false)).toEqual([b])
    expect(setSessionPinned([a], "b", true)).toEqual([b, a])
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

  it("置顶的挪到最前、按置顶列表里的顺序；其余的保持传入的顺序", () => {
    const ids = [appChatSessionId("d"), appChatSessionId("b")]
    expect(keys(pinFirst(ordered, ids))).toEqual(["d", "b", "a", "c"])
  })

  it("置顶之间的顺序跟置顶列表走（用户拖的），不跟传入的顺序（最近对话）走", () => {
    const ids = [appChatSessionId("c"), appChatSessionId("a")]
    expect(keys(pinFirst(ordered, ids))).toEqual(["c", "a", "b", "d"])
    expect(keys(pinFirst([...ordered].reverse(), ids))).toEqual(["c", "a", "d", "b"])
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

describe("拖动调整置顶的顺序", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map(appChatSessionId)

  it("挪到某个会话前面 / 后面", () => {
    expect(movePinned([a, b, c, d], "d", "b", "before")).toEqual([a, d, b, c])
    expect(movePinned([a, b, c, d], "a", "c", "after")).toEqual([b, c, a, d])
    expect(movePinned([a, b, c, d], "a", "d", "after")).toEqual([b, c, d, a])
    expect(movePinned([a, b, c, d], "d", "a", "before")).toEqual([d, a, b, c])
  })

  it("挪完顺序没变（放回原位、或本来就紧挨着）：原样返回同一个数组，不触发写盘和刷新", () => {
    const ids = [a, b, c]
    expect(movePinned(ids, "b", "a", "after")).toBe(ids)
    expect(movePinned(ids, "b", "c", "before")).toBe(ids)
    expect(movePinned(ids, "a", "b", "before")).toBe(ids)
  })

  it("自己挪到自己、有一个没置顶、两个都没置顶：什么都不做", () => {
    const ids = [a, b]
    expect(movePinned(ids, "a", "a", "before")).toBe(ids)
    expect(movePinned(ids, "a", "c", "before")).toBe(ids)
    expect(movePinned(ids, "c", "a", "before")).toBe(ids)
    expect(movePinned(ids, "c", "d", "after")).toBe(ids)
  })

  it("列表里夹着别的类、别的通道的置顶：被挪的和目标在列表里隔得再远，也只改这两个的相对位置，别的相对顺序不变", () => {
    const ids = [a, b, c, d]
    // a 和 d 是同一类，中间的 b、c 是别的类的
    const next = movePinned(ids, "d", "a", "before")
    expect(next).toEqual([d, a, b, c])
    expect(movePinned(ids, "a", "d", "after")).toEqual([b, c, d, a])
  })

  it("不改传入的数组", () => {
    const ids = [a, b, c]
    movePinned(ids, "c", "a", "before")
    expect(ids).toEqual([a, b, c])
  })

  it("路径写法不同也认得出（电脑和手机写法可能不一样）", () => {
    const x = appChatSessionId("app:chan:D:/work/x")
    const y = appChatSessionId("app:chan:D:/work/y")
    expect(movePinned([x, y], "app:chan:d:\\Work\\Y", "app:chan:D:\\work\\X", "before")).toEqual([y, x])
  })

  it("拖到的位置：只认 before / after", () => {
    expect(parsePinPlacement("before")).toBe("before")
    expect(parsePinPlacement("after")).toBe("after")
    expect(parsePinPlacement("left")).toBeUndefined()
    expect(parsePinPlacement(undefined)).toBeUndefined()
    expect(parsePinPlacement(1)).toBeUndefined()
  })
})
