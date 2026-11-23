import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat, deliveredNoticeParts } from "../src/app-channel"
import type { AppChatEvent, AppChatItem } from "../src/shared/app-chat-types"

const SESSION = "app_ch|app::D:\\ws\\a"

let dir: string
let events: AppChatEvent[]
let chat: AppChat

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-delivered-"))
  events = []
  chat = new AppChat(dir, (e) => events.push(e))
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

const notices = () => chat.list(SESSION).filter((i): i is Extract<AppChatItem, { kind: "notice" }> => i.kind === "notice")

describe("deliveredNoticeParts：标题和折叠的全文", () => {
  it("只有一行且不长：整句就是标题，没有全文", () => {
    expect(deliveredNoticeParts("帮我检查一下服务器状态")).toEqual({ text: "帮我检查一下服务器状态" })
  })

  it("多行：第一行是标题，整段（含标题行）是全文", () => {
    expect(deliveredNoticeParts("⏰ 定时任务「巡检」汇报\n\n磁盘占用 91%")).toEqual({
      text: "⏰ 定时任务「巡检」汇报",
      detail: "⏰ 定时任务「巡检」汇报\n\n磁盘占用 91%",
    })
  })

  it("单行但很长：标题截断加省略号，全文是完整的一行", () => {
    const long = "长".repeat(200)
    const parts = deliveredNoticeParts(long)
    expect(parts.text).toBe(`${"长".repeat(80)}…`)
    expect(parts.detail).toBe(long)
  })

  it("首尾空白和 CRLF 换行不影响标题", () => {
    expect(deliveredNoticeParts("\n\n  标题行  \r\n正文\r\n")).toEqual({ text: "标题行", detail: "标题行  \r\n正文" })
  })
})

describe("recordDelivered：交给 Agent 的消息聊天里还没有记录就补一条", () => {
  it("补成提示条：id 就是消息 id，带标题和全文，并推给界面", () => {
    chat.recordDelivered(SESSION, [{ messageId: "internal_taskresult_t1_1", text: "⏰ 定时任务「巡检」汇报\n\n一切正常" }])

    expect(notices()).toMatchObject([{ id: "internal_taskresult_t1_1", text: "⏰ 定时任务「巡检」汇报", detail: "⏰ 定时任务「巡检」汇报\n\n一切正常" }])
    expect(events.filter((e) => e.type === "item")).toHaveLength(1)
  })

  it("聊天里已经有这条记录的（用户在界面发的）不动，也不再推事件", () => {
    chat.addUser(SESSION, "app_1", "用户发的话")
    events.length = 0

    chat.recordDelivered(SESSION, [{ messageId: "app_1", text: "用户发的话" }])

    expect(chat.list(SESSION).map((i) => i.kind)).toEqual(["user"])
    expect(events).toEqual([])
  })

  it("同一条重投：只记一次", () => {
    const msg = { messageId: "internal_1", text: "定时任务触发\n\n去检查" }
    chat.recordDelivered(SESSION, [msg])
    chat.recordDelivered(SESSION, [msg])
    expect(notices()).toHaveLength(1)
  })

  it("一批里有的已有记录、有的没有：只补没有的，顺序保持", () => {
    chat.addUser(SESSION, "app_1", "用户发的话")
    chat.recordDelivered(SESSION, [
      { messageId: "internal_a", text: "系统消息 A" },
      { messageId: "app_1", text: "用户发的话" },
      { messageId: "internal_b", text: "系统消息 B" },
    ])
    expect(chat.list(SESSION).map((i) => i.id)).toEqual(["app_1", "internal_a", "internal_b"])
  })

  it("补的记录落在当前回合卡之后：回合卡先建、消息后到", () => {
    chat.addUser(SESSION, "app_1", "第一问")
    chat.streamCard(SESSION, "ensure", [{ type: "reply", text: "答复" }], {})
    chat.streamCard(SESSION, "finish", [], {})
    chat.recordDelivered(SESSION, [{ messageId: "internal_a", text: "任务结果" }])
    expect(chat.list(SESSION).map((i) => i.kind)).toEqual(["user", "assistant", "notice"])
  })

  it("落盘：重新打开后还在，且重投时仍认得它已有记录", () => {
    chat.recordDelivered(SESSION, [{ messageId: "internal_a", text: "标题\n\n全文" }])
    chat.flush()

    const reopened = new AppChat(dir, () => {})
    expect(reopened.list(SESSION)).toMatchObject([{ kind: "notice", id: "internal_a", text: "标题", detail: "标题\n\n全文" }])
    reopened.recordDelivered(SESSION, [{ messageId: "internal_a", text: "标题\n\n全文" }])
    expect(reopened.list(SESSION)).toHaveLength(1)
  })

  it("什么都没有时不动", () => {
    chat.recordDelivered(SESSION, [])
    expect(chat.list(SESSION)).toEqual([])
    expect(events).toEqual([])
  })
})
