/**
 * LarkSender.updateStreamingCard 的失败处理：错误码交给调用方、重复失败的日志合并。
 * 过去每次失败打一条 WARN，流式卡约每秒更新一次，失败多久就刷多久（线上截图里 seq 已经刷到 3965）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

type Reply = { code?: number; msg?: string } | Error
let replies: Reply[] = []
let defaultReply: Reply = { code: 0 }
const requests: Array<{ method: string; url: string; data: any }> = []
let logs: Array<{ level: string; text: string }> = []

function makeSender() {
  const client = {
    request: vi.fn(async (req: any) => {
      requests.push(req)
      const r = replies.shift() ?? defaultReply
      if (r instanceof Error) throw r
      return r
    }),
  }
  return new LarkSender({
    client: client as any,
    chatId: "oc_x",
    messagePrefix: "",
    log: (level, ...args) => logs.push({ level, text: args.join(" ") }),
  })
}

const CARD = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "你好" }] } }
const warns = () => logs.filter((l) => l.level === "WARN")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T09:00:00Z"))
  replies = []
  defaultReply = { code: 0 }
  requests.length = 0
  logs = []
})
afterEach(() => vi.useRealTimers())

describe("updateStreamingCard 返回值与错误码", () => {
  it("成功：返回 true，不打日志，不调 onFailure，请求带 sequence 与整卡 JSON", async () => {
    const onFailure = vi.fn()
    const ok = await makeSender().updateStreamingCard("card_1", CARD, 7, onFailure)
    expect(ok).toBe(true)
    expect(onFailure).not.toHaveBeenCalled()
    expect(logs).toHaveLength(0)
    expect(requests[0].method).toBe("PUT")
    expect(requests[0].url).toContain("/cardkit/v1/cards/card_1")
    expect(requests[0].data.sequence).toBe(7)
    expect(JSON.parse(requests[0].data.card.data)).toEqual(CARD)
  })

  it("飞书返回错误码：返回 false，onFailure 拿到 code 和 msg（调用方据此判断是不是体积超限）", async () => {
    defaultReply = { code: 200860, msg: "ErrMsg: card over max size" }
    const onFailure = vi.fn()
    const ok = await makeSender().updateStreamingCard("card_1", CARD, 1, onFailure)
    expect(ok).toBe(false)
    expect(onFailure).toHaveBeenCalledWith({ code: 200860, msg: "ErrMsg: card over max size" })
  })

  it("请求抛异常：返回 false，onFailure 有 msg 没有 code（不会被误判成体积超限）", async () => {
    replies = [new Error("socket hang up")]
    const onFailure = vi.fn()
    const ok = await makeSender().updateStreamingCard("card_1", CARD, 1, onFailure)
    expect(ok).toBe(false)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0][0].code).toBeUndefined()
    expect(onFailure.mock.calls[0][0].msg).toContain("socket hang up")
  })

  it("不传 onFailure 也行", async () => {
    defaultReply = { code: 300308, msg: "internal" }
    await expect(makeSender().updateStreamingCard("card_1", CARD, 1)).resolves.toBe(false)
  })

  it("失败日志带上整卡体积，方便一眼看出是不是超限", async () => {
    defaultReply = { code: 200860, msg: "over" }
    await makeSender().updateStreamingCard("card_1", CARD, 3965)
    expect(warns()).toHaveLength(1)
    expect(warns()[0].text).toContain("code=200860")
    expect(warns()[0].text).toContain("seq=3965")
    expect(warns()[0].text).toContain(`size=${LarkSender.cardBytes(CARD)}B`)
  })
})

describe("重复失败的日志合并", () => {
  it("同一张卡同一种错误：1 分钟每秒失败一次，只打 2 条，而不是 60 条", async () => {
    defaultReply = { code: 200860, msg: "over" }
    const sender = makeSender()
    for (let i = 0; i < 60; i++) {
      await sender.updateStreamingCard("card_1", CARD, i + 1)
      vi.setSystemTime(Date.now() + 1000)
    }
    expect(requests).toHaveLength(60) // 请求照发（是否发由 daemon 退避决定），这里只管日志
    expect(warns()).toHaveLength(2)
    // 第二条说明期间合并了多少次
    expect(warns()[1].text).toMatch(/此前 29 次相同失败已合并/)
  })

  it("不同的错误码各打各的，不会互相吞掉", async () => {
    const sender = makeSender()
    defaultReply = { code: 200860, msg: "over" }
    await sender.updateStreamingCard("card_1", CARD, 1)
    defaultReply = { code: 300308, msg: "internal" }
    await sender.updateStreamingCard("card_1", CARD, 2)
    expect(warns()).toHaveLength(2)
    expect(warns()[0].text).toContain("200860")
    expect(warns()[1].text).toContain("300308")
  })

  it("不同的卡各打各的", async () => {
    defaultReply = { code: 300308, msg: "internal" }
    const sender = makeSender()
    await sender.updateStreamingCard("card_1", CARD, 1)
    await sender.updateStreamingCard("card_2", CARD, 1)
    expect(warns()).toHaveLength(2)
  })

  it("异常也合并（同一种异常信息）", async () => {
    const sender = makeSender()
    for (let i = 0; i < 10; i++) {
      replies = [new Error("socket hang up")]
      await sender.updateStreamingCard("card_1", CARD, i + 1)
    }
    expect(warns()).toHaveLength(1)
    expect(warns()[0].text).toContain("socket hang up")
  })

  it("成功一次就重置：之后再失败照常立刻打一条（新的一轮故障不被上一轮吞掉）", async () => {
    const sender = makeSender()
    defaultReply = { code: 300308, msg: "internal" }
    await sender.updateStreamingCard("card_1", CARD, 1)
    await sender.updateStreamingCard("card_1", CARD, 2)
    expect(warns()).toHaveLength(1)

    defaultReply = { code: 0 }
    await sender.updateStreamingCard("card_1", CARD, 3)

    defaultReply = { code: 300308, msg: "internal" }
    await sender.updateStreamingCard("card_1", CARD, 4)
    expect(warns()).toHaveLength(2)
    // 重置后是新的一轮，不会带上上一轮的合并计数
    expect(warns()[1].text).not.toContain("已合并")
  })

  it("一张卡成功不影响另一张卡的合并状态", async () => {
    const sender = makeSender()
    defaultReply = { code: 300308, msg: "internal" }
    await sender.updateStreamingCard("card_1", CARD, 1)
    defaultReply = { code: 0 }
    await sender.updateStreamingCard("card_2", CARD, 1)
    defaultReply = { code: 300308, msg: "internal" }
    await sender.updateStreamingCard("card_1", CARD, 2)
    expect(warns()).toHaveLength(1)
  })
})
