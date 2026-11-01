import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import type { AppChatAssistantItem, AppChatEvent } from "../src/shared/app-chat-types"

const SESSION = "app_ch|app::D:\\ws\\a"

let dir: string
let events: AppChatEvent[]
let chat: AppChat

beforeEach(() => {
  // 只伪造 Date：落盘定时器照常跑，afterEach 里的 flush 不受影响
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-30T12:23:47.900Z"))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-finish-"))
  events = []
  chat = new AppChat(dir, (e) => events.push(e))
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const card = (): AppChatAssistantItem => {
  const hit = chat.list(SESSION).find((i): i is AppChatAssistantItem => i.kind === "assistant")
  if (!hit) throw new Error("no assistant card")
  return hit
}

const itemEvents = () => events.filter((e) => e.type === "item")

describe("回合卡收口只认第一次", () => {
  it("正常收口：记下收口时间，耗时 = 收口时间 - 建卡时间", () => {
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "哈哈" }], {})
    vi.setSystemTime(new Date("2026-10-30T12:23:48.800Z"))
    chat.streamCard(SESSION, "finish", [{ type: "reply", text: "哈哈" }], { modelLabel: "m1" })

    const c = card()
    expect(c.finished).toBe(true)
    expect(c.finishedAt! - c.ts).toBe(900)
    expect(c.modelLabel).toBe("m1")
  })

  it("重新拉起（Resume）补发的 finish 不会改写收口时间：耗时仍是第一次收口时算的", () => {
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "哈哈" }], {})
    vi.setSystemTime(new Date("2026-10-30T12:23:48.800Z"))
    chat.streamCard(SESSION, "finish", [{ type: "reply", text: "哈哈" }], { modelLabel: "m1" })
    const firstFinishedAt = card().finishedAt

    // 两分钟后下一条消息到来，Agent 重新拉起，按记着的卡 id 补发一次空的 finish
    vi.setSystemTime(new Date("2026-10-30T12:25:33.400Z"))
    const id = card().id
    const r = chat.streamCard(SESSION, "finish", [], { cardId: id })

    expect(r.cardId).toBe(id)
    expect(card().finishedAt).toBe(firstFinishedAt)
    expect(card().finishedAt! - card().ts).toBe(900)
  })

  it("补发的 finish 不会清掉已收口卡的内容和模型名，也不重复通知界面", () => {
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "哈哈" }], {})
    chat.streamCard(SESSION, "finish", [{ type: "reply", text: "哈哈" }], { modelLabel: "m1" })
    const id = card().id
    events.length = 0

    vi.setSystemTime(new Date("2026-10-30T12:25:33.400Z"))
    const r = chat.streamCard(SESSION, "finish", [], { cardId: id })

    expect(r.hasReply).toBe(true)
    expect(card().segments).toEqual([{ type: "reply", text: "哈哈" }])
    expect(card().modelLabel).toBe("m1")
    expect(itemEvents()).toHaveLength(0)
  })

  it("补发的 finish 不会再让别处以为这一回合还没结束", () => {
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "哈哈" }], {})
    chat.streamCard(SESSION, "finish", [], {})
    const id = card().id

    chat.streamCard(SESSION, "finish", [], { cardId: id })

    expect(chat.hasLiveTurn(SESSION)).toBe(false)
  })

  it("新回合已经建了新卡时，finish 仍然收口当前这张未收口的卡（旧行为不变）", () => {
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "旧" }], {})
    chat.streamCard(SESSION, "finish", [], {})
    vi.setSystemTime(new Date("2026-10-30T12:25:44.000Z"))
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "新" }], {})
    expect(chat.hasLiveTurn(SESSION)).toBe(true)

    vi.setSystemTime(new Date("2026-10-30T12:25:51.000Z"))
    chat.streamCard(SESSION, "finish", [{ type: "reply", text: "新" }], {})

    expect(chat.hasLiveTurn(SESSION)).toBe(false)
    const cards = chat.list(SESSION).filter((i): i is AppChatAssistantItem => i.kind === "assistant")
    expect(cards).toHaveLength(2)
    expect(cards.every((c) => c.finished)).toBe(true)
    expect(cards[1].finishedAt! - cards[1].ts).toBe(7000)
  })
})
