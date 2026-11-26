import { describe, expect, it } from "vitest"
import { SEARCH_MAX_HITS, highlightParts, searchChatItems, searchTokens } from "../src/shared/app-chat-search"
import type { AppChatItem } from "../src/shared/app-chat-types"

const user = (n: number, text: string, extra: Partial<AppChatItem> = {}): AppChatItem =>
  ({ kind: "user", id: `u${n}`, ts: n * 1000, text, ...extra }) as AppChatItem
const card = (n: number, segments: Array<{ type: "thinking" | "reply"; text: string } | { type: "tools"; tools: [] }>): AppChatItem =>
  ({ kind: "assistant", id: `a${n}`, ts: n * 1000, finished: true, segments }) as AppChatItem
const ids = (items: AppChatItem[], query: string) => searchChatItems(items, query).hits.map((h) => h.id)

describe("searchTokens：搜索词按空白拆开，不分大小写", () => {
  it("多个空白（含全角空格）都算分隔，空串没有词", () => {
    expect(searchTokens("  Foo \t bar　Baz ")).toEqual(["foo", "bar", "baz"])
    expect(searchTokens("   ")).toEqual([])
    expect(searchTokens("")).toEqual([])
  })
})

describe("searchChatItems：搜哪些记录", () => {
  it("用户消息、独立文本都能搜，命中带 id、时间和类型", () => {
    const items = [user(1, "部署到测试环境"), { kind: "text", id: "t2", ts: 2000, text: "测试环境已经好了" } as AppChatItem]
    const { hits, capped } = searchChatItems(items, "测试环境")
    expect(hits.map((h) => [h.id, h.ts, h.kind])).toEqual([["t2", 2000, "text"], ["u1", 1000, "user"]])
    expect(capped).toBe(false)
  })

  it("AI 回复只搜回复正文：思考和工具记录默认折叠，不搜", () => {
    const items = [
      card(1, [{ type: "thinking", text: "先看看 redis 配置" }, { type: "tools", tools: [] }, { type: "reply", text: "已经改好了" }]),
    ]
    expect(ids(items, "已经改好")).toEqual(["a1"])
    expect(ids(items, "redis")).toEqual([])
  })

  it("一张回复卡里有多段回复：整张卡算一条命中", () => {
    const items = [card(1, [{ type: "reply", text: "第一段" }, { type: "tools", tools: [] }, { type: "reply", text: "第二段" }])]
    expect(ids(items, "第二段")).toEqual(["a1"])
    expect(ids(items, "第一段 第二段")).toEqual(["a1"])
  })

  it("问题卡：题干、选项、选中的答案都能搜", () => {
    const q = { kind: "question", id: "q1", ts: 1000, messageId: "q1", text: "用哪个库？", options: ["lodash", "ramda"], answered: "ramda" } as AppChatItem
    expect(ids([q], "哪个库")).toEqual(["q1"])
    expect(ids([q], "LODASH")).toEqual(["q1"])
    expect(ids([q], "ramda")).toEqual(["q1"])
  })

  it("被回合卡引用的问题照样能搜：命中的是问题自己的 id，界面据此定位到卡里的那一块", () => {
    const q = { kind: "question", id: "q1", ts: 1500, messageId: "q1", text: "用哪个库？", options: ["lodash"] } as AppChatItem
    const turn = { kind: "assistant", id: "a1", ts: 1000, finished: true, segments: [{ type: "reply", text: "先问你" }, { type: "item", itemId: "q1" }] } as AppChatItem
    expect(ids([turn, q], "哪个库")).toEqual(["q1"])
  })

  it("图片、文件不搜", () => {
    const items = [
      { kind: "image", id: "i1", ts: 1000, path: "/tmp/关键词.png" },
      { kind: "file", id: "f1", ts: 2000, path: "/tmp/关键词.txt", name: "关键词.txt" },
    ] as AppChatItem[]
    expect(ids(items, "关键词")).toEqual([])
  })

  it("提示条：标题和折叠着的全文都能搜，命中带 notice 类型", () => {
    const notice = { kind: "notice", id: "n1", ts: 3000, text: "⏰ 定时任务「巡检」汇报", detail: "⏰ 定时任务「巡检」汇报\n\n磁盘占用 91%，需要清理" } as AppChatItem
    expect(ids([notice], "巡检")).toEqual(["n1"])
    expect(ids([notice], "磁盘占用")).toEqual(["n1"])
    expect(searchChatItems([notice], "磁盘占用").hits[0]).toMatchObject({ id: "n1", kind: "notice" })
    expect(ids([notice], "不存在")).toEqual([])
  })

  it("没有全文的提示条：只搜标题", () => {
    const notice = { kind: "notice", id: "n1", ts: 1000, text: "✅ 已切换主会话" } as AppChatItem
    expect(ids([notice], "切换")).toEqual(["n1"])
  })

  it("还在暂存区排队的用户消息不在聊天流里，不搜", () => {
    const items = [user(1, "排队的关键词", { queued: true } as Partial<AppChatItem>), user(2, "已投递的关键词")]
    expect(ids(items, "关键词")).toEqual(["u2"])
  })
})

describe("searchChatItems：怎么匹配、怎么排", () => {
  it("不分大小写", () => {
    expect(ids([user(1, "Hello World")], "hello")).toEqual(["u1"])
    expect(ids([user(1, "hello world")], "WORLD")).toEqual(["u1"])
  })

  it("多个词都要命中，顺序和是否相邻都不限；缺一个词就不算", () => {
    const items = [user(1, "苹果和香蕉"), user(2, "只有苹果"), user(3, "香蕉先来，苹果后到")]
    expect(ids(items, "苹果 香蕉")).toEqual(["u3", "u1"])
    expect(ids(items, "香蕉 苹果")).toEqual(["u3", "u1"])
  })

  it("空查询、只有空白：没有命中，不是命中全部", () => {
    const items = [user(1, "任何内容")]
    expect(searchChatItems(items, "")).toEqual({ hits: [], capped: false })
    expect(searchChatItems(items, "   ")).toEqual({ hits: [], capped: false })
  })

  it("最新的在前", () => {
    const items = [user(1, "关键词 a"), user(2, "关键词 b"), user(3, "关键词 c")]
    expect(ids(items, "关键词")).toEqual(["u3", "u2", "u1"])
  })

  it("没有命中：空列表", () => {
    expect(searchChatItems([user(1, "你好")], "不存在")).toEqual({ hits: [], capped: false })
  })
})

describe("searchChatItems：片段", () => {
  it("命中在开头：前面没有省略号；短文本整段给，后面也没有", () => {
    expect(searchChatItems([user(1, "你好，世界")], "你好").hits[0].snippet).toBe("你好，世界")
  })

  it("命中在长文本中间：前后都有省略号，片段里包含命中的词", () => {
    const text = `${"前".repeat(200)}目标词${"后".repeat(200)}`
    const snippet = searchChatItems([user(1, text)], "目标词").hits[0].snippet
    expect(snippet.startsWith("…")).toBe(true)
    expect(snippet.endsWith("…")).toBe(true)
    expect(snippet).toContain("前前前目标词后后后") // 命中处前后各带一段上下文
    expect(snippet.length).toBeLessThan(150)
  })

  it("换行和连续空白折成一个空格，片段是单行", () => {
    const snippet = searchChatItems([user(1, "第一行\n\n  第二行\t第三行")], "第二行").hits[0].snippet
    expect(snippet).toBe("第一行 第二行 第三行")
  })

  it("多个词时片段以第一个词为中心", () => {
    const text = `${"甲".repeat(300)}词一${"乙".repeat(300)}词二`
    const snippet = searchChatItems([user(1, text)], "词一 词二").hits[0].snippet
    expect(snippet).toContain("词一")
  })
})

describe("highlightParts：按搜索词切出命中的片段", () => {
  const tokens = (query: string) => searchTokens(query)
  const compact = (text: string, query: string) => highlightParts(text, tokens(query)).map((p) => (p.hit ? `[${p.text}]` : p.text)).join("")

  it("命中的词前后各是一段，拼起来正好是原文", () => {
    expect(highlightParts("今天部署了测试环境", tokens("部署"))).toEqual([
      { text: "今天", hit: false }, { text: "部署", hit: true }, { text: "了测试环境", hit: false },
    ])
  })

  it("同一个词出现多次都标出来；不分大小写，片段保持原文的大小写", () => {
    expect(compact("Redis 和 redis", "REDIS")).toBe("[Redis] 和 [redis]")
  })

  it("多个词各自标出，不要求相邻", () => {
    expect(compact("苹果和香蕉", "香蕉 苹果")).toBe("[苹果]和[香蕉]")
  })

  it("词重叠、首尾相接的并成一段，不重复输出文字", () => {
    expect(compact("abcdef", "abcd cdef")).toBe("[abcdef]")
    expect(compact("abcdef", "abc bcd")).toBe("[abcd]ef")
    expect(compact("abcdef", "abcdef cd")).toBe("[abcdef]")
    expect(compact("abcdef", "abc def")).toBe("[abcdef]")
  })

  it("没有命中、没有词：整段是没命中的一个片段；空文字没有片段", () => {
    expect(highlightParts("你好", tokens("没有"))).toEqual([{ text: "你好", hit: false }])
    expect(highlightParts("你好", [])).toEqual([{ text: "你好", hit: false }])
    expect(highlightParts("", tokens("a"))).toEqual([])
  })

  it("词在开头或结尾：不产生空片段", () => {
    expect(compact("词一中间词二", "词一 词二")).toBe("[词一]中间[词二]")
  })
})

describe("searchChatItems：命中上限", () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => user(i + 1, `关键词 ${i + 1}`))

  it("超过上限：只给最新的那些，并告知被截断", () => {
    const r = searchChatItems(many(SEARCH_MAX_HITS + 5), "关键词")
    expect(r.hits).toHaveLength(SEARCH_MAX_HITS)
    expect(r.hits[0].id).toBe(`u${SEARCH_MAX_HITS + 5}`)
    expect(r.hits.at(-1)?.id).toBe("u6")
    expect(r.capped).toBe(true)
  })

  it("正好等于上限：全给，没有被截断", () => {
    const r = searchChatItems(many(SEARCH_MAX_HITS), "关键词")
    expect(r.hits).toHaveLength(SEARCH_MAX_HITS)
    expect(r.capped).toBe(false)
  })
})
