import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import {
  inlinedItemIds,
  overlayInlineBlocks,
  type AppChatAssistantItem,
  type AppChatEvent,
  type AppChatSegment,
} from "../src/shared/app-chat-types"

const SESSION = "app_ch|app::D:\\ws\\a"
const ROUND = "r1"

let dir: string
let events: AppChatEvent[]
let chat: AppChat

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-inline-"))
  events = []
  chat = new AppChat(dir, (e) => events.push(e))
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

const reply = (text: string): AppChatSegment => ({ type: "reply", text })
const tools = (name: string): AppChatSegment => ({ type: "tools", tools: [{ name, status: "done" }] })
const ref = (itemId: string): AppChatSegment => ({ type: "item", itemId })

const cards = (): AppChatAssistantItem[] => chat.list(SESSION).filter((i): i is AppChatAssistantItem => i.kind === "assistant")
const card = (): AppChatAssistantItem => {
  const hit = cards().at(-1)
  if (!hit) throw new Error("no assistant card")
  return hit
}
const itemOfKind = (kind: string) => chat.list(SESSION).find((i) => i.kind === kind)

describe("overlayInlineBlocks：内联块按挂进来时的位置叠到流式输出上", () => {
  it("插在它挂进来时的段数处，不改原数组", () => {
    const streamed = [tools("a"), reply("x")]
    const out = overlayInlineBlocks(streamed, [{ insertAt: 1, segment: ref("q1") }])
    expect(out).toEqual([tools("a"), ref("q1"), reply("x")])
    expect(streamed).toHaveLength(2)
  })

  it("同一位置的多块保持到达顺序；位置超出段数时排到末尾", () => {
    const out = overlayInlineBlocks([reply("x")], [
      { insertAt: 1, segment: ref("q1") },
      { insertAt: 1, segment: ref("q2") },
      { insertAt: 9, segment: ref("q3") },
    ])
    expect(out).toEqual([reply("x"), ref("q1"), ref("q2"), ref("q3")])
  })

  it("没有内联块就是原样", () => {
    expect(overlayInlineBlocks([reply("x")], [])).toEqual([reply("x")])
  })
})

describe("inlinedItemIds：哪些记录已经被回合卡引用", () => {
  it("只看回合卡里的引用段", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    chat.addQuestion(SESSION, "选哪个？", ["A"], false, ROUND, 1)
    chat.addQuestion(SESSION, "没轮次的题", ["A"])
    const ids = inlinedItemIds(chat.list(SESSION))
    expect(ids.size).toBe(1)
    expect(ids.has((itemOfKind("question") as { id: string }).id)).toBe(true)
  })
})

describe("回合中发的问题、图片、文件：并进回合卡它发的那个位置", () => {
  it("问题：卡里多一个引用段，记录本身仍在", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    const id = chat.addQuestion(SESSION, "选哪个？", ["A", "B"], false, ROUND, 1)

    expect(card().segments).toEqual([tools("a"), ref(id)])
    expect(chat.list(SESSION).some((i) => i.id === id && i.kind === "question")).toBe(true)
  })

  it("图片、文件：inline=true 才并进卡；默认仍是独立记录", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    chat.addImage(SESSION, path.join(dir, "不存在.png"), true)
    chat.addFile(SESSION, path.join(dir, "说明.txt"), true)
    chat.addImage(SESSION, path.join(dir, "另一张.png"))

    const image = chat.list(SESSION).filter((i) => i.kind === "image")
    const file = itemOfKind("file")!
    expect(card().segments).toEqual([tools("a"), ref(image[0].id), ref(file.id)])
    expect(inlinedItemIds(chat.list(SESSION)).has(image[1].id)).toBe(false)
  })

  it("后续流式更新整体替换分段后，内联块还在原来的位置", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    const id = chat.addQuestion(SESSION, "选哪个？", ["A"], false, ROUND, 1)

    chat.streamCard(SESSION, "update", [tools("a"), reply("接着说")], {})
    expect(card().segments).toEqual([tools("a"), ref(id), reply("接着说")])

    // 空更新沿用上一份流式输出，内联块照样叠着
    chat.streamCard(SESSION, "update", [], {})
    expect(card().segments).toEqual([tools("a"), ref(id), reply("接着说")])

    chat.streamCard(SESSION, "finish", [tools("a"), reply("接着说"), reply("完")], {})
    expect(card().segments).toEqual([tools("a"), ref(id), reply("接着说"), reply("完")])
    expect(card().finished).toBe(true)
  })

  it("一个回合里发多个：各在各的位置", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    const q1 = chat.addQuestion(SESSION, "第一题", ["A"], false, ROUND, 1)
    chat.streamCard(SESSION, "update", [tools("a"), reply("中间的话")], {})
    const q2 = chat.addQuestion(SESSION, "第二题", ["A"], false, ROUND, 2)

    expect(card().segments).toEqual([tools("a"), ref(q1), reply("中间的话"), ref(q2)])
  })

  it("先让卡引用它、再落记录：界面先收到卡，这条记录不会先单独出现在末尾", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    events.length = 0
    const id = chat.addQuestion(SESSION, "选哪个？", ["A"], false, ROUND, 1)

    const order = events.flatMap((e) => (e.type === "item" ? [e.item.kind === "assistant" ? "card" : e.item.id] : []))
    expect(order).toEqual(["card", id])
  })

  it("收口后的下一回合是新卡：不继承上一回合的内联块", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    const id = chat.addQuestion(SESSION, "选哪个？", ["A"], false, ROUND, 1)
    chat.streamCard(SESSION, "finish", [tools("a")], {})

    chat.streamCard(SESSION, "ensure", [reply("新一轮")], {})
    expect(cards()).toHaveLength(2)
    expect(card().segments).toEqual([reply("新一轮")])
    expect(cards()[0].segments).toEqual([tools("a"), ref(id)])
  })
})

describe("没有回合卡、或不是回合中发的：落成独立记录，和以前一样", () => {
  it("没有活卡（Agent 不在回合中）", () => {
    const id = chat.addQuestion(SESSION, "选哪个？", ["A"], false, ROUND, 1)
    chat.addImage(SESSION, path.join(dir, "不存在.png"), true)

    expect(cards()).toHaveLength(0)
    expect(chat.list(SESSION).map((i) => i.kind)).toEqual(["question", "image"])
    expect(inlinedItemIds(chat.list(SESSION)).has(id)).toBe(false)
  })

  it("收口之后再发：卡不再改动", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    chat.streamCard(SESSION, "finish", [tools("a")], {})
    chat.addQuestion(SESSION, "选哪个？", ["A"], false, ROUND, 1)

    expect(card().segments).toEqual([tools("a")])
  })

  it("问题不带轮次（独立定时任务）：有活卡也不并进去", () => {
    chat.streamCard(SESSION, "ensure", [tools("a")], {})
    chat.addQuestion(SESSION, "任务里的题", ["A"])

    expect(card().segments).toEqual([tools("a")])
  })
})
