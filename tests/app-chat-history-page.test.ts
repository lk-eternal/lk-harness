import { describe, expect, it } from "vitest"
import {
  HISTORY_PAGE_LIMIT_MAX,
  HISTORY_PAGE_MAX_CHARS,
  historyCursorOf,
  isBeyondLoadedWindow,
  keepsLoadedHistory,
  pageChatHistory,
  parseHistoryQuery,
  replaceHistoryTail,
} from "../src/shared/app-chat-history-page"
import type { AppChatItem } from "../src/shared/app-chat-types"

const user = (n: number): AppChatItem => ({ kind: "user", id: `u${n}`, ts: n * 1000, text: `问题 ${n}` })
const ids = (items: readonly AppChatItem[]) => items.map((i) => i.id)
/** 一张体积很大的回复卡：思考文字占的体积 */
const bigCard = (n: number, chars: number): AppChatItem => ({
  kind: "assistant", id: `a${n}`, ts: n * 1000, finished: true,
  segments: [{ type: "thinking", text: "x".repeat(chars) }, { type: "reply", text: "好的" }],
})
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => user(from + i))

describe("pageChatHistory：切出一页", () => {
  it("不带 limit 是整段历史、没有更多——老版本手机 App 的请求就是这样，不能被截断", () => {
    const all = range(1, 50)
    const page = pageChatHistory(all, {})
    expect(page.items).toHaveLength(50)
    expect(page.hasMore).toBe(false)
  })

  it("带 limit：给最近的 limit 条，并说明前面还有", () => {
    const page = pageChatHistory(range(1, 50), { limit: 10 })
    expect(ids(page.items)).toEqual(ids(range(41, 50)))
    expect(page.hasMore).toBe(true)
  })

  it("历史不够一页：全给，没有更多", () => {
    const page = pageChatHistory(range(1, 5), { limit: 10 })
    expect(page.items).toHaveLength(5)
    expect(page.hasMore).toBe(false)
  })

  it("空历史：空页，没有更多", () => {
    expect(pageChatHistory([], { limit: 10 })).toEqual({ items: [], hasMore: false })
  })

  it("加载更早：从游标之前再取一页，不含游标本身，翻到头就没有更多", () => {
    const all = range(1, 50)
    const first = pageChatHistory(all, { limit: 20 })
    expect(ids(first.items)[0]).toBe("u31")

    const second = pageChatHistory(all, { limit: 20, beforeId: "u31", beforeTs: 31000 })
    expect(ids(second.items)).toEqual(ids(range(11, 30)))
    expect(second.hasMore).toBe(true)

    const third = pageChatHistory(all, { limit: 20, beforeId: "u11", beforeTs: 11000 })
    expect(ids(third.items)).toEqual(ids(range(1, 10)))
    expect(third.hasMore).toBe(false)
  })

  it("游标那条被移除了（暂存区撤回）：按 ts 定位，不会取不到也不会重复", () => {
    const all = [...range(1, 10), ...range(12, 20)] // u11 不在了
    const page = pageChatHistory(all, { limit: 5, beforeId: "u11", beforeTs: 11000 })
    expect(ids(page.items)).toEqual(ids(range(6, 10)))
    expect(page.hasMore).toBe(true)
  })

  it("游标比所有记录都新、id 又找不到：当作从末尾取", () => {
    const page = pageChatHistory(range(1, 10), { limit: 3, beforeId: "gone", beforeTs: 99_999_000 })
    expect(ids(page.items)).toEqual(["u8", "u9", "u10"])
  })

  it("体积先到上限：条数没到也收页，大会话的一页不会有几 MB", () => {
    const half = Math.floor(HISTORY_PAGE_MAX_CHARS / 2)
    const all = [user(1), bigCard(2, half), bigCard(3, half), bigCard(4, half), bigCard(5, half)]
    const page = pageChatHistory(all, { limit: 30 })
    expect(ids(page.items)).toEqual(["a5"]) // 两张半数上限的卡加起来就超了，只给最近一张
    expect(page.hasMore).toBe(true)
  })

  it("单条就超过体积上限：仍然给这一条，不能返回空页卡住「加载更早」", () => {
    const all = [user(1), bigCard(2, HISTORY_PAGE_MAX_CHARS * 2)]
    const page = pageChatHistory(all, { limit: 30 })
    expect(ids(page.items)).toEqual(["a2"])
    expect(page.hasMore).toBe(true)

    const earlier = pageChatHistory(all, { limit: 30, beforeId: "a2", beforeTs: 2000 })
    expect(ids(earlier.items)).toEqual(["u1"])
    expect(earlier.hasMore).toBe(false)
  })

  it("一页一页翻下来，拼起来正好是完整历史，不丢不重", () => {
    const all = [...range(1, 20), bigCard(21, HISTORY_PAGE_MAX_CHARS), ...range(22, 60), bigCard(61, 300_000), user(62)]
    let collected: AppChatItem[] = []
    let query = { limit: 12 } as Parameters<typeof pageChatHistory>[1]
    for (let guard = 0; guard < 100; guard++) {
      const page = pageChatHistory(all, query)
      collected = [...page.items, ...collected]
      if (!page.hasMore) break
      const cursor = historyCursorOf(page.items)!
      query = { limit: 12, beforeId: cursor.id, beforeTs: cursor.ts }
    }
    expect(ids(collected)).toEqual(ids(all))
  })
})

describe("parseHistoryQuery：请求体不可信", () => {
  it("合法字段原样取，limit 取整", () => {
    expect(parseHistoryQuery({ limit: 30.9, beforeId: "u1", beforeTs: 5 })).toEqual({ limit: 30, beforeId: "u1", beforeTs: 5 })
  })

  it("limit 有服务端上限：手机端传多大都不能把整段历史要走", () => {
    expect(parseHistoryQuery({ limit: 1_000_000 }).limit).toBe(HISTORY_PAGE_LIMIT_MAX)
  })

  it("不合法的字段当没给（字符串数字、负数、NaN、0）", () => {
    expect(parseHistoryQuery({ limit: "30" })).toEqual({})
    expect(parseHistoryQuery({ limit: -1 })).toEqual({})
    expect(parseHistoryQuery({ limit: 0 })).toEqual({})
    expect(parseHistoryQuery({ limit: Number.NaN, beforeTs: Number.NaN })).toEqual({})
    expect(parseHistoryQuery({ beforeId: 5, beforeTs: "1" })).toEqual({})
  })

  it("不是对象：当没给", () => {
    expect(parseHistoryQuery(undefined)).toEqual({})
    expect(parseHistoryQuery(null)).toEqual({})
    expect(parseHistoryQuery("x")).toEqual({})
  })
})

describe("isBeyondLoadedWindow：实时事件落在没加载的区域", () => {
  const cursor = { id: "u31", ts: 31000 }
  const loaded = [user(31), user(32)]

  it("比窗口起点更早、列表里又没有：不并入（否则它成了第一条，和窗口之间的记录被跳过）", () => {
    expect(isBeyondLoadedWindow({ id: "q5", ts: 5000 }, cursor, loaded)).toBe(true)
  })

  it("窗口里已有的记录更新（流式快照、状态变更）：照常并入", () => {
    expect(isBeyondLoadedWindow({ id: "u31", ts: 31000 }, cursor, loaded)).toBe(false)
  })

  it("新记录（比窗口起点新）：并入", () => {
    expect(isBeyondLoadedWindow({ id: "u40", ts: 40000 }, cursor, loaded)).toBe(false)
  })

  it("比游标早、但列表里已经有它（游标落后于列表）：是已加载记录的更新，照常并入，不能丢", () => {
    expect(isBeyondLoadedWindow({ id: "u10", ts: 10000 }, cursor, [user(10), user(31), user(32)])).toBe(false)
  })

  it("翻出来的更早记录之后又收到它的更新：游标已经移到更早处，照常并入", () => {
    expect(isBeyondLoadedWindow({ id: "u10", ts: 10000 }, { id: "u1", ts: 1000 }, [user(1), user(10)])).toBe(false)
  })

  it("还没有游标（历史没回来、或没分页）：都并入", () => {
    expect(isBeyondLoadedWindow({ id: "q5", ts: 5000 }, undefined, [])).toBe(false)
  })
})

describe("replaceHistoryTail：重连后补漏只换最近那一段", () => {
  it("补漏拉回的最近一页替换列表里对应的那段，往前翻出来的更早记录保留", () => {
    const prev = [user(1), user(2), user(3), user(4), user(5)] // 1、2 是翻出来的，3-5 是最近一页
    const tail = [user(3), { ...user(4), text: "改过" } as AppChatItem, user(5), user(6)] // 断线期间多了 6，4 被改过
    const next = replaceHistoryTail(prev, tail)
    expect(ids(next)).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"])
    expect((next[3] as { text: string }).text).toBe("改过")
  })

  it("断线期间窗口里的一条被移除了：补漏之后它不再出现", () => {
    const next = replaceHistoryTail([user(1), user(2), user(3)], [user(1), user(3)])
    expect(ids(next)).toEqual(["u1", "u3"])
  })

  it("没翻过更早的：整个换成新的一页", () => {
    expect(ids(replaceHistoryTail([user(3), user(4)], [user(3), user(4), user(5)]))).toEqual(["u3", "u4", "u5"])
  })

  it("拉回来是空的（会话被清空了）：列表也清空，不留旧记录", () => {
    expect(replaceHistoryTail([user(1), user(2)], [])).toEqual([])
  })
})

describe("keepsLoadedHistory：补漏的一页能不能接在翻出来的记录后面", () => {
  const cursorAt = (n: number) => historyCursorOf([user(n)])

  it("翻过更早的、并且和列表末尾有重叠：只换尾巴，保住翻出来的记录", () => {
    // 窗口从 u1 开始（翻过），列表到 u5；补漏这一页是 u3-u6，和列表重叠
    expect(keepsLoadedHistory(cursorAt(1), range(1, 5), range(3, 6))).toBe(true)
  })

  it("断线期间新消息太多，这一页起点已经晚于列表末尾：接不上，不能只换尾巴（中间会缺一段）", () => {
    expect(keepsLoadedHistory(cursorAt(1), range(1, 5), range(20, 30))).toBe(false)
  })

  it("没翻过更早的（窗口起点就是这一页起点）：没有要保留的，整个换", () => {
    expect(keepsLoadedHistory(cursorAt(3), range(3, 5), range(3, 6))).toBe(false)
  })

  it("还没有游标、列表为空、拉回来为空：都不保留", () => {
    expect(keepsLoadedHistory(undefined, range(1, 5), range(3, 6))).toBe(false)
    expect(keepsLoadedHistory(cursorAt(1), [], range(3, 6))).toBe(false)
    expect(keepsLoadedHistory(cursorAt(1), range(1, 5), [])).toBe(false)
  })
})
