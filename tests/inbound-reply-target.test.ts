/**
 * 飞书流式卡片（Agent 的主回复）以回复的方式发出。
 *
 * 之前同一个群里：发文件、发图片、问题卡都引用用户那条消息，唯独正文（流式卡片）是直发，
 * 因为建卡时只有会话 key、没有 message_id。现在记下每个会话这一轮在回应哪条用户消息，建卡时拿来回复。
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"
import {
  createReplyTargetTracker,
  isUserMessageId,
  replyTargetUpdateFor,
  sendReplyWithBackoff,
} from "../src/shared/inbound-reply-target.js"

const msgs = (...ids: Array<string | undefined>) => ids.map((messageId) => ({ messageId }))

describe("isUserMessageId", () => {
  it("飞书的 message_id 算用户消息，internal_ 开头和空值不算", () => {
    expect(isUserMessageId("om_abc123")).toBe(true)
    expect(isUserMessageId("internal_card_1794793584188")).toBe(false)
    expect(isUserMessageId("internal_task_1_1")).toBe(false)
    expect(isUserMessageId("")).toBe(false)
    expect(isUserMessageId(undefined)).toBe(false)
  })
})

describe("replyTargetUpdateFor：一批投递对回复对象的影响", () => {
  it("有用户消息：以最后一条为准", () => {
    expect(replyTargetUpdateFor(msgs("om_1"))).toEqual({ kind: "set", messageId: "om_1" })
    expect(replyTargetUpdateFor(msgs("om_1", "om_2", "om_3"))).toEqual({ kind: "set", messageId: "om_3" })
  })

  it("用户消息夹着内部消息：取最后一条用户消息，不被后面的内部消息顶掉", () => {
    expect(replyTargetUpdateFor(msgs("om_1", "internal_task_9_1"))).toEqual({ kind: "set", messageId: "om_1" })
    expect(replyTargetUpdateFor(msgs("internal_card_1", "om_2"))).toEqual({ kind: "set", messageId: "om_2" })
  })

  it("只有卡片点击：保持原来的回复对象", () => {
    expect(replyTargetUpdateFor(msgs("internal_card_1794793584188"))).toEqual({ kind: "keep" })
    expect(replyTargetUpdateFor(msgs("internal_card_1", "internal_card_2"))).toEqual({ kind: "keep" })
  })

  it("只有定时任务、排程等系统消息：清掉，没人在等这条回复，不去引用旧消息", () => {
    expect(replyTargetUpdateFor(msgs("internal_task_9_1794793584188"))).toEqual({ kind: "clear" })
    expect(replyTargetUpdateFor(msgs("internal_enqueue_1"))).toEqual({ kind: "clear" })
    expect(replyTargetUpdateFor(msgs("internal_taskresult_x_1"))).toEqual({ kind: "clear" })
    // 卡片点击和定时任务一起来：不是单纯的点击，清掉
    expect(replyTargetUpdateFor(msgs("internal_card_1", "internal_task_9_1"))).toEqual({ kind: "clear" })
  })

  it("没有任何 messageId：不是用户可见的投递，不动", () => {
    expect(replyTargetUpdateFor([])).toEqual({ kind: "keep" })
    expect(replyTargetUpdateFor(msgs(undefined, ""))).toEqual({ kind: "keep" })
  })
})

describe("createReplyTargetTracker", () => {
  it("记下最近投递的用户消息，后来的覆盖先前的", () => {
    const t = createReplyTargetTracker()
    expect(t.get("ch|oc_a::D:\\ws")).toBeUndefined()
    t.observeDelivery("ch|oc_a::D:\\ws", msgs("om_1"))
    expect(t.get("ch|oc_a::D:\\ws")).toBe("om_1")
    t.observeDelivery("ch|oc_a::D:\\ws", msgs("om_2"))
    expect(t.get("ch|oc_a::D:\\ws")).toBe("om_2")
  })

  it("会话之间互不影响", () => {
    const t = createReplyTargetTracker()
    t.observeDelivery("s1", msgs("om_1"))
    t.observeDelivery("s2", msgs("om_2"))
    expect(t.get("s1")).toBe("om_1")
    expect(t.get("s2")).toBe("om_2")
    t.observeDelivery("s2", msgs("internal_task_1_1"))
    expect(t.get("s1")).toBe("om_1")
    expect(t.get("s2")).toBeUndefined()
  })

  it("卡片点击不改变回复对象；定时任务投递会清掉；之后用户再发消息又有了", () => {
    const t = createReplyTargetTracker()
    t.observeDelivery("s", msgs("om_1"))
    t.observeDelivery("s", msgs("internal_card_5"))
    expect(t.get("s")).toBe("om_1")
    t.observeDelivery("s", msgs("internal_task_7_1"))
    expect(t.get("s")).toBeUndefined()
    t.observeDelivery("s", msgs("om_9"))
    expect(t.get("s")).toBe("om_9")
  })

  it("空批次、没有 messageId 的批次不动", () => {
    const t = createReplyTargetTracker()
    t.observeDelivery("s", msgs("om_1"))
    t.observeDelivery("s", [])
    t.observeDelivery("s", msgs(undefined))
    expect(t.get("s")).toBe("om_1")
  })

  it("空的会话 key 被忽略", () => {
    const t = createReplyTargetTracker()
    t.observeDelivery("", msgs("om_1"))
    expect(t.size).toBe(0)
  })

  it("forget 之后没有回复对象", () => {
    const t = createReplyTargetTracker()
    t.observeDelivery("s", msgs("om_1"))
    t.forget("s")
    expect(t.get("s")).toBeUndefined()
  })

  it("超出上限时丢最久没更新的会话，最近更新过的保留", () => {
    const t = createReplyTargetTracker(3)
    t.observeDelivery("a", msgs("om_a"))
    t.observeDelivery("b", msgs("om_b"))
    t.observeDelivery("c", msgs("om_c"))
    t.observeDelivery("a", msgs("om_a2")) // a 刷新，b 变成最久没动的
    t.observeDelivery("d", msgs("om_d"))
    expect(t.size).toBe(3)
    expect(t.get("b")).toBeUndefined()
    expect(t.get("a")).toBe("om_a2")
    expect(t.get("c")).toBe("om_c")
    expect(t.get("d")).toBe("om_d")
  })
})

describe("sendReplyWithBackoff", () => {
  it("没有回复对象：直发一次", async () => {
    const send = vi.fn(async (_rid: string | undefined) => "om_direct")
    expect(await sendReplyWithBackoff(send, undefined)).toBe("om_direct")
    expect(send.mock.calls).toEqual([[undefined]])
  })

  it("回复成功：只发一次，用的是回复对象", async () => {
    const send = vi.fn(async (_rid: string | undefined) => "om_reply")
    const onBackoff = vi.fn()
    expect(await sendReplyWithBackoff(send, "om_user", onBackoff)).toBe("om_reply")
    expect(send.mock.calls).toEqual([["om_user"]])
    expect(onBackoff).not.toHaveBeenCalled()
  })

  it("回复成功但没拿到 message_id（null）也算成功，不会再发一张", async () => {
    const send = vi.fn(async (_rid: string | undefined) => null)
    expect(await sendReplyWithBackoff(send, "om_user")).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("回复失败：退回直发，并通知一次", async () => {
    const send = vi.fn(async (rid: string | undefined) => (rid ? undefined : "om_direct"))
    const onBackoff = vi.fn()
    expect(await sendReplyWithBackoff(send, "om_user", onBackoff)).toBe("om_direct")
    expect(send.mock.calls).toEqual([["om_user"], [undefined]])
    expect(onBackoff).toHaveBeenCalledExactlyOnceWith("om_user")
  })

  it("回复和直发都失败：返回 undefined，只试两次", async () => {
    const send = vi.fn(async (_rid: string | undefined) => undefined)
    expect(await sendReplyWithBackoff(send, "om_user")).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

/** 和真实的 LarkSender.sendCardEntity 配合：reply 接口报错/抛错时，卡片要改成直发出去，而不是整张丢掉 */
describe("流式卡片 + LarkSender.sendCardEntity", () => {
  type Handler = (req: any) => any
  function makeSender(h: { reply?: Handler; create?: Handler } = {}) {
    const calls: Array<{ kind: "reply" | "create"; req: any }> = []
    const client = {
      im: {
        message: {
          reply: vi.fn(async (req: any) => {
            calls.push({ kind: "reply", req })
            return h.reply ? h.reply(req) : { code: 0, data: { message_id: "om_reply" } }
          }),
          create: vi.fn(async (req: any) => {
            calls.push({ kind: "create", req })
            return h.create ? h.create(req) : { code: 0, data: { message_id: "om_direct" } }
          }),
        },
      },
    }
    const sender = new LarkSender({ client: client as any, chatId: "oc_main", messagePrefix: "", log: () => {} })
    const sendCard = (replyTo: string | undefined, onBackoff?: (rid: string) => void) =>
      sendReplyWithBackoff((rid) => sender.sendCardEntity("card_1", rid, "oc_group"), replyTo, onBackoff)
    return { calls, sendCard }
  }

  it("有回复对象：以回复的方式发，目标是那条用户消息，没有额外直发", async () => {
    const { calls, sendCard } = makeSender()
    expect(await sendCard("om_user")).toBe("om_reply")
    expect(calls.map((c) => c.kind)).toEqual(["reply"])
    expect(calls[0].req.path.message_id).toBe("om_user")
    expect(JSON.parse(calls[0].req.data.content)).toEqual({ type: "card", data: { card_id: "card_1" } })
    expect(calls[0].req.data.msg_type).toBe("interactive")
  })

  it("没有回复对象：直发到群里", async () => {
    const { calls, sendCard } = makeSender()
    expect(await sendCard(undefined)).toBe("om_direct")
    expect(calls.map((c) => c.kind)).toEqual(["create"])
    expect(calls[0].req.data.receive_id).toBe("oc_group")
  })

  it("那条用户消息被撤回，回复接口返回错误码：改成直发，卡片不丢", async () => {
    const { calls, sendCard } = makeSender({ reply: () => ({ code: 230011, msg: "The message was withdrawn." }) })
    const onBackoff = vi.fn()
    expect(await sendCard("om_gone", onBackoff)).toBe("om_direct")
    expect(calls.map((c) => c.kind)).toEqual(["reply", "create"])
    expect(calls[1].req.data.receive_id).toBe("oc_group")
    expect(onBackoff).toHaveBeenCalledWith("om_gone")
  })

  it("回复接口抛异常（网络错误等）：同样改成直发", async () => {
    const { calls, sendCard } = makeSender({
      reply: () => {
        throw new Error("socket hang up")
      },
    })
    expect(await sendCard("om_user")).toBe("om_direct")
    expect(calls.map((c) => c.kind)).toEqual(["reply", "create"])
  })
})

/**
 * daemon 的状态是模块级的、没法在单测里直接跑，这里把两处关键接线钉住：
 * 投递给 Agent 时记下回复对象；建流式卡片时按 shouldReplyToMessage 决定回复，不再写死直发。
 */
describe("daemon 接线", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "daemon.ts"), "utf8").replace(/\r\n/g, "\n")
  const bodyOf = (signature: string): string => {
    const start = src.indexOf(signature)
    expect(start, `daemon.ts 里找不到 ${signature}`).toBeGreaterThan(-1)
    const next = src.indexOf("\nfunction ", start + signature.length)
    const nextAsync = src.indexOf("\nasync function ", start + signature.length)
    const ends = [next, nextAsync].filter((i) => i > -1)
    return src.slice(start, ends.length ? Math.min(...ends) : undefined)
  }

  it("每次把消息投递给 Agent（collectFreshAndTrack）都更新回复对象，key 和流式卡用的一致（先规范化）", () => {
    const body = bodyOf("function collectFreshAndTrack(")
    expect(body).toMatch(/replyTargets\.observeDelivery\(normalizeSessionKey\(sessionKey\) \|\| sessionKey, messages\)/)
  })

  it("建流式卡片时按 shouldReplyToMessage 决定是否回复，并带退避；不再写死直发", () => {
    const body = bodyOf("async function ensureAgentStreamCard(")
    expect(body).toMatch(/replyTargets\.get\(normalizeSessionKey\(sessionKey\) \|\| sessionKey\)/)
    expect(body).toMatch(/shouldReplyToMessage\(ch, inboundId\) \? inboundId : undefined/)
    expect(body).toContain("sendReplyWithBackoff(")
    expect(body).not.toMatch(/sendCardEntity\(cardId, undefined,/)
  })
})
