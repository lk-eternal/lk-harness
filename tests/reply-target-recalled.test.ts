/**
 * 撤回消息后 Agent 还在回复。
 *
 * 撤回要靠飞书的 im.message.recalled_v1 事件通知我们，而这个事件要在开发者后台单独订阅（设置页标的是「可选」）。
 * 没订阅时 daemon 一条撤回事件都收不到，处理中的消息撤了也没人知道，Agent 一路跑下去。
 *
 * 兜底：Agent 的第一张流式卡是「回复」那条用户消息发出的，目标消息已撤回时飞书返回 HTTP 400 + 业务码 230011。
 * 这条也当作撤回信号，走和事件同一套处理（移出队列、撤回当前流式卡、通知 electron 停 Agent）。
 *
 * 另外：回复失败的日志过去只有「Request failed with status code 400」，看不出是撤回还是别的原因，现在带上飞书的业务码。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // daemon 在导入时就读 APP_DATA_DIR，必须先于 import 设好
  const dir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    (require("node:path") as typeof import("node:path")).join((require("node:os") as typeof import("node:os")).tmpdir(), "claw-recall-"),
  )
  process.env.APP_DATA_DIR = dir
  return { dir }
})

import {
  agentStreamCards, channels, handleMessageRecalled, sseClients, wireReplyTargetRecalled,
} from "../src/daemon.js"
import { claimSessionMessages, clearAllQueueMessages, getQueueLength, initFileQueue, pushToFileQueue } from "../src/file-queue.js"
import { describeLarkError, larkBizCode, LarkSender } from "../src/shared/lark-core.js"
import { sendReplyWithBackoff } from "../src/shared/inbound-reply-target.js"

/** 飞书对 HTTP 非 2xx 抛的是 axios 错误：message 只有状态码，业务码在 response.data.code */
const axiosErr = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { code: "ERR_BAD_REQUEST", response: { status, data } })

const RECALLED = { code: 230011, msg: "The message is recalled." }

describe("飞书业务码的读取和日志", () => {
  it("larkBizCode：axios 错误取 response.data.code；响应体直接带 code 也认", () => {
    expect(larkBizCode(axiosErr(400, RECALLED))).toBe(230011)
    expect(larkBizCode({ code: 230011, msg: "x" })).toBe(230011)
  })

  it("larkBizCode：axios 自己的字符串 code、网络错误、空值都不算业务码", () => {
    expect(larkBizCode({ code: "ERR_BAD_REQUEST" })).toBeUndefined()
    expect(larkBizCode(new Error("socket hang up"))).toBeUndefined()
    expect(larkBizCode(axiosErr(502, "<html>bad gateway</html>"))).toBeUndefined()
    expect(larkBizCode(null)).toBeUndefined()
    expect(larkBizCode(undefined)).toBeUndefined()
  })

  it("describeLarkError：在 axios 的状态码后面补上飞书的业务码和说明", () => {
    const text = describeLarkError(axiosErr(400, RECALLED))
    expect(text).toContain("status code 400")
    expect(text).toContain("230011")
    expect(text).toContain("The message is recalled.")
  })

  it("describeLarkError：没有业务码时就是原来的错误信息；非 Error 也不抛", () => {
    expect(describeLarkError(new Error("socket hang up"))).toBe("socket hang up")
    expect(describeLarkError("boom")).toBe("boom")
    expect(describeLarkError(undefined)).toBe("undefined")
  })
})

describe("流式卡片回复失败：LarkSender.sendCardEntity", () => {
  type Handler = (req: any) => any
  function makeSender(h2: { reply?: Handler; create?: Handler } = {}) {
    const calls: Array<"reply" | "create"> = []
    const logs: string[] = []
    const client = {
      im: {
        message: {
          reply: vi.fn(async (req: any) => {
            calls.push("reply")
            return h2.reply ? h2.reply(req) : { code: 0, data: { message_id: "om_reply" } }
          }),
          create: vi.fn(async (req: any) => {
            calls.push("create")
            return h2.create ? h2.create(req) : { code: 0, data: { message_id: "om_direct" } }
          }),
        },
      },
    }
    const sender = new LarkSender({ client: client as any, chatId: "oc_main", messagePrefix: "", log: (_l: string, ...a: unknown[]) => { logs.push(a.join(" ")) } })
    const onRecalled = vi.fn()
    ;(sender as any).onReplyTargetRecalled = onRecalled
    return { sender, calls, logs, onRecalled }
  }

  it("回复的那条用户消息已撤回（HTTP 400 + 230011，SDK 抛 axios 错误）：通知撤回，返回失败", async () => {
    const { sender, onRecalled, logs } = makeSender({ reply: () => { throw axiosErr(400, RECALLED) } })
    expect(await sender.sendCardEntity("card_1", "om_gone", "oc_group")).toBeUndefined()
    expect(onRecalled).toHaveBeenCalledExactlyOnceWith("om_gone", "oc_group")
    expect(logs.join("\n")).toContain("230011")
  })

  it("接口以响应体返回 230011（没抛错）：同样通知撤回", async () => {
    const { sender, onRecalled } = makeSender({ reply: () => ({ ...RECALLED }) })
    expect(await sender.sendCardEntity("card_1", "om_gone", "oc_group")).toBeUndefined()
    expect(onRecalled).toHaveBeenCalledExactlyOnceWith("om_gone", "oc_group")
  })

  it("别的 400（比如机器人不在群里 230002）：不当成撤回，但日志里要看得到业务码", async () => {
    const { sender, onRecalled, logs } = makeSender({ reply: () => { throw axiosErr(400, { code: 230002, msg: "The bot can not be outside the group." }) } })
    expect(await sender.sendCardEntity("card_1", "om_user", "oc_group")).toBeUndefined()
    expect(onRecalled).not.toHaveBeenCalled()
    expect(logs.join("\n")).toContain("230002")
  })

  it("网络错误：不当成撤回", async () => {
    const { sender, onRecalled } = makeSender({ reply: () => { throw new Error("socket hang up") } })
    expect(await sender.sendCardEntity("card_1", "om_user", "oc_group")).toBeUndefined()
    expect(onRecalled).not.toHaveBeenCalled()
  })

  it("回复成功：不通知", async () => {
    const { sender, onRecalled } = makeSender()
    expect(await sender.sendCardEntity("card_1", "om_user", "oc_group")).toBe("om_reply")
    expect(onRecalled).not.toHaveBeenCalled()
  })

  it("直发（没有回复对象）失败不算撤回", async () => {
    const { sender, onRecalled } = makeSender({ create: () => { throw axiosErr(400, RECALLED) } })
    expect(await sender.sendCardEntity("card_1", undefined, "oc_group")).toBeUndefined()
    expect(onRecalled).not.toHaveBeenCalled()
  })

  it("回调自己抛错：不影响返回，不抛出来", async () => {
    const { sender, onRecalled } = makeSender({ reply: () => { throw axiosErr(400, RECALLED) } })
    onRecalled.mockImplementation(() => { throw new Error("handler boom") })
    await expect(sender.sendCardEntity("card_1", "om_gone", "oc_group")).resolves.toBeUndefined()
  })

  it("没挂回调：和以前一样退回失败", async () => {
    const { sender } = makeSender({ reply: () => { throw axiosErr(400, RECALLED) } })
    ;(sender as any).onReplyTargetRecalled = undefined
    await expect(sender.sendCardEntity("card_1", "om_gone", "oc_group")).resolves.toBeUndefined()
  })

  it("配合退避：通知撤回之后，卡片仍然直发出去（卡不丢，由撤回处理随后收掉）", async () => {
    const { sender, calls, onRecalled } = makeSender({ reply: () => { throw axiosErr(400, RECALLED) } })
    const sent = await sendReplyWithBackoff((rid) => sender.sendCardEntity("card_1", rid, "oc_group"), "om_gone")
    expect(sent).toBe("om_direct")
    expect(calls).toEqual(["reply", "create"])
    expect(onRecalled).toHaveBeenCalledTimes(1)
  })
})

const CH = "ch_recall_test"
const CHAT_ID = "oc_recall_test"
const CHAT = `${CH}|${CHAT_ID}`
const SESSION = `${CHAT}::D:\\ws\\recall-test`

const sender = { deleteMessage: vi.fn(async (..._a: unknown[]) => true) as any, onReplyTargetRecalled: undefined as any }
const rt: any = {
  cfg: { id: CH, name: "recall-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}
const sse = { write: vi.fn((..._a: unknown[]) => true) }
const sseEvents = () => sse.write.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('"type":"message-recalled"'))

/** 这个会话正在跑：有一条已被 Agent 领取的消息，和一张发出去的流式卡 */
function seedProcessing(messageId: string, cardMessageId: string) {
  pushToFileQueue("给陈硕提bug", messageId, "test", SESSION)
  claimSessionMessages(SESSION)
  agentStreamCards.set(SESSION, {
    cardId: "card_recall", messageId: cardMessageId, sequence: 0, channelId: CH, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(), questionBlocks: [],
  } as any)
}
const settle = () => new Promise((r) => setTimeout(r, 40))

/** 撤回有两个来源，处理必须一致：飞书的撤回事件，和回复目标消息时返回的 230011 */
const triggers: Record<string, (messageId: string) => void> = {
  "撤回事件": (id) => handleMessageRecalled(rt, id, CHAT_ID, "message_owner"),
  "回复失败 230011": (id) => {
    wireReplyTargetRecalled(rt)
    sender.onReplyTargetRecalled(id, CHAT_ID)
  },
}

beforeAll(() => { initFileQueue() })
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }) })
beforeEach(() => {
  clearAllQueueMessages()
  sender.deleteMessage.mockClear()
  sender.onReplyTargetRecalled = undefined
  sse.write.mockClear()
  sseClients.add(sse as any)
  channels.set(CH, rt)
})
afterEach(() => {
  agentStreamCards.delete(SESSION)
  sseClients.delete(sse as any)
  channels.delete(CH)
})

for (const [name, trigger] of Object.entries(triggers)) {
  describe(`daemon 撤回处理 · ${name}`, () => {
    it("处理中的消息被撤回：移出队列、撤回当前流式卡、通知 electron 停掉这个会话的 Agent", async () => {
      seedProcessing("om_user_A", "om_card_A")
      trigger("om_user_A")
      await vi.waitFor(() => expect(sseEvents()).toHaveLength(1))
      expect(getQueueLength(SESSION)).toBe(0)
      expect(sender.deleteMessage).toHaveBeenCalledExactlyOnceWith("om_card_A")
      expect(agentStreamCards.has(SESSION)).toBe(false)
      expect(JSON.parse(sseEvents()[0].replace(/^data: /, "")).sessionKey).toBe(SESSION)
    })

    it("消息还在排队、没被领取：只移出队列，不撤卡、不停 Agent", async () => {
      pushToFileQueue("排队中", "om_user_B", "test", SESSION)
      trigger("om_user_B")
      await settle()
      expect(getQueueLength(SESSION)).toBe(0)
      expect(sender.deleteMessage).not.toHaveBeenCalled()
      expect(sseEvents()).toHaveLength(0)
    })

    it("队列里没有这条消息（早就处理完了，或者是别的会话的）：什么都不动", async () => {
      seedProcessing("om_user_C", "om_card_C")
      trigger("om_someone_else")
      await settle()
      expect(getQueueLength(SESSION)).toBe(1)
      expect(sender.deleteMessage).not.toHaveBeenCalled()
      expect(agentStreamCards.has(SESSION)).toBe(true)
      expect(sseEvents()).toHaveLength(0)
    })

    it("同一条消息撤回通知两次（订阅了事件、回复又失败）：第二次什么都不做", async () => {
      seedProcessing("om_user_D", "om_card_D")
      trigger("om_user_D")
      await vi.waitFor(() => expect(sseEvents()).toHaveLength(1))
      trigger("om_user_D")
      await settle()
      expect(sender.deleteMessage).toHaveBeenCalledTimes(1)
      expect(sseEvents()).toHaveLength(1)
    })
  })
}

describe("daemon 接线", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "daemon.ts"), "utf8").replace(/\r\n/g, "\n")

  it("wireReplyTargetRecalled 把 sender 的回调接到撤回处理，换通道也各用各的 rt", () => {
    const other: any = { cfg: { ...rt.cfg, name: "other" }, sender: { onReplyTargetRecalled: undefined } }
    wireReplyTargetRecalled(rt)
    wireReplyTargetRecalled(other)
    expect(typeof sender.onReplyTargetRecalled).toBe("function")
    expect(typeof other.sender.onReplyTargetRecalled).toBe("function")
    expect(other.sender.onReplyTargetRecalled).not.toBe(sender.onReplyTargetRecalled)
  })

  it("startFeishuChannel 建好 sender 之后调用了 wireReplyTargetRecalled", () => {
    const start = src.indexOf("export async function startFeishuChannel(")
    expect(start, "daemon.ts 里找不到 startFeishuChannel").toBeGreaterThan(-1)
    const end = src.indexOf("\n// ── 指令系统", start)
    const body = src.slice(start, end > -1 ? end : undefined)
    const created = body.indexOf("rt.sender = new LarkSender(")
    const wired = body.indexOf("wireReplyTargetRecalled(rt)")
    expect(created).toBeGreaterThan(-1)
    expect(wired).toBeGreaterThan(created)
  })
})
