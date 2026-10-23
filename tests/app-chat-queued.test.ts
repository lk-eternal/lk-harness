import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import {
  chatItemInsertIndex,
  chatStreamItems,
  isQueuedUserItem,
  upsertChatItems,
  type AppChatEvent,
  type AppChatItem,
} from "../src/shared/app-chat-types"

const SESSION = "app_ch|app::D:\\ws\\a"

let dir: string
let events: AppChatEvent[]
let chat: AppChat

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-queued-"))
  events = []
  chat = new AppChat(dir, (e) => events.push(e))
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

const queuedIds = () => chat.list(SESSION).filter(isQueuedUserItem).map((i) => i.id)

describe("Agent 是否正在干活", () => {
  it("没有回合卡时不算在干活，有未收口的回合卡才算", () => {
    expect(chat.hasLiveTurn(SESSION)).toBe(false)
    chat.streamCard(SESSION, "ensure", [], {})
    expect(chat.hasLiveTurn(SESSION)).toBe(true)
    chat.streamCard(SESSION, "finish", [], {})
    expect(chat.hasLiveTurn(SESSION)).toBe(false)
  })
})

describe("排队消息", () => {
  it("queued=true 的消息带排队标记，普通消息没有", () => {
    chat.addUser(SESSION, "u1", "普通", undefined, false)
    chat.addUser(SESSION, "u2", "排队", ["D:\\a.png"], true)
    const [first, second] = chat.list(SESSION)
    expect(first.kind === "user" && first.queued).toBeFalsy()
    expect(second.kind === "user" && second.queued).toBe(true)
    expect(second.kind === "user" && second.images).toEqual(["D:\\a.png"])
  })

  it("投递后清掉排队标记，消息留在原来的位置（本回合的卡片之后）", () => {
    chat.addUser(SESSION, "u1", "第一问")
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "答复中" }], {})
    chat.addUser(SESSION, "u2", "插话", undefined, true)
    events.length = 0

    chat.markDelivered(SESSION, ["u2"])

    const items = chat.list(SESSION)
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "user"])
    expect(queuedIds()).toEqual([])
    const delivered = events.find((e) => e.type === "item")
    expect(delivered?.type === "item" && delivered.item.kind === "user" && delivered.item.queued).toBeUndefined()
  })

  it("投递时只动被投递的那几条，其它仍在排队", () => {
    chat.addUser(SESSION, "u1", "一", undefined, true)
    chat.addUser(SESSION, "u2", "二", undefined, true)
    chat.markDelivered(SESSION, ["u1"])
    expect(queuedIds()).toEqual(["u2"])
  })

  it("暂存区里改正文：只改排队中的，已投递的改不了", () => {
    chat.addUser(SESSION, "u1", "旧", undefined, true)
    chat.addUser(SESSION, "u2", "已送达")
    expect(chat.editQueuedText(SESSION, "u1", "新")).toBe(true)
    expect(chat.editQueuedText(SESSION, "u2", "想改")).toBe(false)
    const items = chat.list(SESSION)
    expect(items[0].kind === "user" && items[0].text).toBe("新")
    expect(items[1].kind === "user" && items[1].text).toBe("已送达")
  })

  it("queuedItem 只认排队中的消息", () => {
    chat.addUser(SESSION, "u1", "排队", undefined, true)
    chat.addUser(SESSION, "u2", "普通")
    expect(chat.queuedItem(SESSION, "u1")?.id).toBe("u1")
    expect(chat.queuedItem(SESSION, "u2")).toBeUndefined()
    expect(chat.queuedItem(SESSION, "nope")).toBeUndefined()
  })
})

describe("回合卡的位置", () => {
  const order = () => chat.list(SESSION).map((i) => i.id)
  const cardId = () => chat.list(SESSION).find((i) => i.kind === "assistant")!.id

  it("回合卡晚于排队消息才创建时，落在这些消息之前（它们属于下一回合）", async () => {
    chat.addUser(SESSION, "p", "第一问")
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u1", "1", undefined, true)
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u2", "2", undefined, true)
    await new Promise((r) => setTimeout(r, 5))

    // Agent 第一段输出才建卡：此时暂存区里已经有 u1、u2
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "收到" }], {})

    expect(order()).toEqual(["p", cardId(), "u1", "u2"])
  })

  it("卡建好之后排的消息仍在卡后面；流式更新、收口不挪位置", async () => {
    chat.addUser(SESSION, "p", "第一问")
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u1", "1", undefined, true)
    await new Promise((r) => setTimeout(r, 5))
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "a" }], {})
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u2", "2", undefined, true)

    chat.streamCard(SESSION, "update", [{ type: "reply", text: "ab" }], {})
    chat.streamCard(SESSION, "finish", [{ type: "reply", text: "abc" }], { interrupted: true })

    expect(order()).toEqual(["p", cardId(), "u1", "u2"])
  })

  it("立即发送后：被打断的卡留在排队消息之前，新回合的卡在它们之后", async () => {
    chat.addUser(SESSION, "p", "第一问")
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u1", "1", undefined, true)
    await new Promise((r) => setTimeout(r, 5))
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "旧回合" }], {})
    const first = cardId()
    chat.addUser(SESSION, "u2", "2", undefined, true)
    await new Promise((r) => setTimeout(r, 5))

    chat.streamCard(SESSION, "finish", [], { interrupted: true })
    chat.markDelivered(SESSION, ["u1", "u2"])
    await new Promise((r) => setTimeout(r, 5))
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "新回合" }], {})

    const ids = order()
    expect(ids.slice(0, 4)).toEqual(["p", first, "u1", "u2"])
    expect(ids).toHaveLength(5)
    expect(chat.list(SESSION)[4].kind).toBe("assistant")
  })

  it("排队消息已投递（不再排队）时，新卡照常追加在末尾", async () => {
    chat.addUser(SESSION, "u1", "1", undefined, true)
    chat.markDelivered(SESSION, ["u1"])
    await new Promise((r) => setTimeout(r, 5))
    chat.streamCard(SESSION, "ensure", [], {})
    expect(order()).toEqual(["u1", cardId()])
  })

  it("只看末尾连续的排队消息：更早的、已经被回合隔开的残留标记不会把新卡顶上去", async () => {
    chat.addUser(SESSION, "stale", "残留的排队标记", undefined, true)
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "p", "已投递的新问题")
    await new Promise((r) => setTimeout(r, 5))
    chat.streamCard(SESSION, "ensure", [], {})
    expect(order()).toEqual(["stale", "p", cardId()])
  })

  it("落盘后重启读回来，顺序不变", async () => {
    chat.addUser(SESSION, "p", "第一问")
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u1", "1", undefined, true)
    await new Promise((r) => setTimeout(r, 5))
    chat.streamCard(SESSION, "ensure", [], {})
    const expected = order()
    chat.flush()
    const reloaded = new AppChat(dir, () => {})
    expect(reloaded.list(SESSION).map((i) => i.id)).toEqual(expected)
  })

  it("发给界面的卡带的是靠前的 ts，界面按同一规则就位后顺序与服务端一致", async () => {
    chat.addUser(SESSION, "p", "第一问")
    await new Promise((r) => setTimeout(r, 5))
    chat.addUser(SESSION, "u1", "1", undefined, true)
    await new Promise((r) => setTimeout(r, 5))
    events.length = 0
    chat.streamCard(SESSION, "ensure", [], {})

    const sentCard = events.find((e) => e.type === "item")
    expect(sentCard?.type === "item" && sentCard.item.kind).toBe("assistant")
    const uiList = upsertChatItems(chat.list(SESSION).filter((i) => i.kind !== "assistant"), [(sentCard as { item: AppChatItem }).item])
    expect(uiList.map((i) => i.id)).toEqual(order())
  })
})

describe("移除排队消息", () => {
  it("removeItem 移除记录并通知界面", () => {
    chat.addUser(SESSION, "u1", "排队", undefined, true)
    events.length = 0
    expect(chat.removeItem(SESSION, "u1")).toBe(true)
    expect(chat.list(SESSION)).toEqual([])
    expect(events).toEqual([{ type: "remove", sessionKey: SESSION, itemId: "u1" }])
    expect(chat.removeItem(SESSION, "u1")).toBe(false)
  })

  it("dropQueued 指定 id 时只丢这些，不动已投递的消息", () => {
    chat.addUser(SESSION, "u1", "已送达")
    chat.addUser(SESSION, "u2", "排队一", undefined, true)
    chat.addUser(SESSION, "u3", "排队二", undefined, true)
    expect(chat.dropQueued(SESSION, ["u2", "u1"])).toBe(1)
    expect(chat.list(SESSION).map((i) => i.id)).toEqual(["u1", "u3"])
  })

  it("dropQueued 不指定 id 时丢掉全部排队消息，聊天流里的保留", () => {
    chat.addUser(SESSION, "u1", "已送达")
    chat.addUser(SESSION, "u2", "排队一", undefined, true)
    chat.addUser(SESSION, "u3", "排队二", undefined, true)
    expect(chat.dropQueued(SESSION)).toBe(2)
    expect(chat.list(SESSION).map((i) => i.id)).toEqual(["u1"])
  })

  it("移除后落盘，重启读回来也没有它", () => {
    chat.addUser(SESSION, "u1", "留下")
    chat.addUser(SESSION, "u2", "排队", undefined, true)
    chat.removeItem(SESSION, "u2")
    chat.flush()
    const reloaded = new AppChat(dir, () => {})
    expect(reloaded.list(SESSION).map((i) => i.id)).toEqual(["u1"])
  })
})

describe("与真实队列对账", () => {
  it("标着排队、队列里已没有的，当作已投递；还在队列里的保持排队", () => {
    chat.addUser(SESSION, "u1", "还在排队", undefined, true)
    chat.addUser(SESSION, "u2", "其实早送达了", undefined, true)
    chat.reconcileQueued(SESSION, new Set(["u1"]))
    expect(queuedIds()).toEqual(["u1"])
  })

  it("hasQueued 反映当前是否有排队消息", () => {
    expect(chat.hasQueued(SESSION)).toBe(false)
    chat.addUser(SESSION, "u1", "排队", undefined, true)
    expect(chat.hasQueued(SESSION)).toBe(true)
    chat.markDelivered(SESSION, ["u1"])
    expect(chat.hasQueued(SESSION)).toBe(false)
  })
})

describe("记录并入列表（界面与服务端共用）", () => {
  const item = (id: string, ts: number, extra: Partial<AppChatItem> = {}): AppChatItem =>
    ({ id, kind: "text", ts, text: id, ...extra }) as AppChatItem

  it("新记录按 ts 就位：通常是末尾，ts 更早的插到比它晚的记录之前", () => {
    const list = [item("a", 1), item("b", 5), item("c", 9)]
    expect(chatItemInsertIndex(list, 10)).toBe(3)
    expect(chatItemInsertIndex(list, 9)).toBe(3)
    expect(chatItemInsertIndex(list, 4)).toBe(1)
    expect(chatItemInsertIndex(list, 0)).toBe(0)
    expect(chatItemInsertIndex([], 3)).toBe(0)
  })

  it("同 id 原位替换，不改变位置；不修改传入的数组", () => {
    const prev = [item("a", 1), item("b", 5), item("c", 9)]
    const next = upsertChatItems(prev, [item("b", 5, { text: "新" } as Partial<AppChatItem>)])
    expect(next.map((i) => i.id)).toEqual(["a", "b", "c"])
    expect((next[1] as { text: string }).text).toBe("新")
    expect(prev).toHaveLength(3)
    expect((prev[1] as { text: string }).text).toBe("b")
  })

  it("没有新记录时原样返回同一个数组", () => {
    const prev = [item("a", 1)]
    expect(upsertChatItems(prev, [])).toBe(prev)
  })

  it("一批里既有新的又有更新的，各归各位", () => {
    const prev = [item("a", 1), item("c", 9)]
    const next = upsertChatItems(prev, [item("b", 5), item("d", 12), item("a", 1, { text: "改" } as Partial<AppChatItem>)])
    expect(next.map((i) => i.id)).toEqual(["a", "b", "c", "d"])
  })
})

describe("聊天流过滤", () => {
  const user = (id: string, queued?: boolean): AppChatItem => ({ id, kind: "user", ts: 1, text: id, ...(queued ? { queued } : {}) })

  it("排队中的消息不进聊天流，其它照常", () => {
    const items = [user("u1"), user("u2", true), user("u3")]
    expect(chatStreamItems(items).map((i) => i.id)).toEqual(["u1", "u3"])
  })

  it("没有排队消息时原样返回同一个数组，避免无谓重渲染", () => {
    const items = [user("u1")]
    expect(chatStreamItems(items)).toBe(items)
  })
})
