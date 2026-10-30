import { describe, expect, it } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

/**
 * 飞书卡片页脚：分隔线 + 小字，和流式卡收口页脚（模型 · 耗时）同款。
 * 独立定时任务的卡片靠它显示「用的哪个模型」。sendMessage 用假的飞书客户端，抓真正发出去的内容。
 */

type Sent = { via: "create" | "reply"; msgType: string; content: string; messageId?: string; receiveId?: string }

function fakeSender(): { sender: LarkSender; sent: Sent[] } {
  const sent: Sent[] = []
  const client = {
    im: {
      message: {
        create: async (req: { data: { receive_id: string; content: string; msg_type: string } }) => {
          sent.push({ via: "create", msgType: req.data.msg_type, content: req.data.content, receiveId: req.data.receive_id })
          return { code: 0, data: { message_id: "om_created" } }
        },
        reply: async (req: { path: { message_id: string }; data: { content: string; msg_type: string } }) => {
          sent.push({ via: "reply", msgType: req.data.msg_type, content: req.data.content, messageId: req.path.message_id })
          return { code: 0, data: { message_id: "om_replied" } }
        },
      },
    },
  }
  const sender = new LarkSender({ client: client as never, chatId: "oc_main", messagePrefix: "", log: () => {} })
  return { sender, sent }
}

type El = { tag: string; content?: string; text_size?: string }
const elementsOf = (s: Sent): El[] => (JSON.parse(s.content) as { body: { elements: El[] } }).body.elements
const NOTATION_FOOTER = (content: string): El[] => [{ tag: "hr" }, { tag: "markdown", content, text_size: "notation" }]

describe("LarkSender.withNotationFooter", () => {
  it("在卡片末尾加分隔线和小字页脚", () => {
    const card = LarkSender.buildCard("正文") as { body: { elements: El[] } }
    const before = card.body.elements.length
    const out = LarkSender.withNotationFooter(card, "composer-2.5-fast") as typeof card
    expect(out).toBe(card)
    expect(out.body.elements).toHaveLength(before + 2)
    expect(out.body.elements.slice(-2)).toEqual(NOTATION_FOOTER("composer-2.5-fast"))
  })

  it("页脚去掉首尾空白", () => {
    const card = LarkSender.buildCard("正文") as { body: { elements: El[] } }
    LarkSender.withNotationFooter(card, "  m1 \n")
    expect(card.body.elements.at(-1)).toEqual({ tag: "markdown", content: "m1", text_size: "notation" })
  })

  it("没有页脚（缺省、空串、只有空白）时原样返回，不加任何元素", () => {
    for (const footer of [undefined, "", "   \n"]) {
      const card = LarkSender.buildCard("正文") as { body: { elements: El[] } }
      const snapshot = JSON.stringify(card)
      expect(LarkSender.withNotationFooter(card, footer)).toBe(card)
      expect(JSON.stringify(card)).toBe(snapshot)
    }
  })
})

describe("LarkSender.sendMessage 带页脚", () => {
  it("直发：正文在前，页脚（分隔线 + 小字）在最后；顶部的会话色条还在", async () => {
    const { sender, sent } = fakeSender()
    await sender.sendMessage("定时任务测试成功", undefined, "oc_main", { title: "📂 lk-harness", subtitle: "🌿 main" }, "green", false, "composer-2.5-fast")
    expect(sent).toHaveLength(1)
    expect(sent[0].via).toBe("create")
    expect(sent[0].msgType).toBe("interactive")
    const els = elementsOf(sent[0])
    expect(els.at(-2)).toEqual({ tag: "hr" })
    expect(els.at(-1)).toEqual({ tag: "markdown", content: "composer-2.5-fast", text_size: "notation" })
    // 正文紧挨着页脚之前，没被页脚挤到别处
    expect(els.some((e) => e.tag === "markdown" && e.content === "定时任务测试成功")).toBe(true)
    expect(els.findIndex((e) => e.content === "定时任务测试成功")).toBeLessThan(els.length - 2)
    // 色条（column_set）仍是第一个元素
    expect(els[0].tag).toBe("column_set")
  })

  it("回复：页脚同样带上", async () => {
    const { sender, sent } = fakeSender()
    await sender.sendMessage("结果", "om_user_msg", undefined, undefined, undefined, false, "gpt-x")
    expect(sent).toHaveLength(1)
    expect(sent[0].via).toBe("reply")
    expect(sent[0].messageId).toBe("om_user_msg")
    expect(elementsOf(sent[0]).slice(-2)).toEqual(NOTATION_FOOTER("gpt-x"))
  })

  it("不带页脚时发出去的卡片和以前完全一样", async () => {
    const { sender, sent } = fakeSender()
    await sender.sendMessage("结果", undefined, "oc_main", { title: "T" }, "blue")
    expect(JSON.parse(sent[0].content)).toEqual(LarkSender.buildCard("结果", { title: "T" }, undefined, undefined, "blue"))
    const { sender: s2, sent: sent2 } = fakeSender()
    await s2.sendMessage("结果", undefined, "oc_main", { title: "T" }, "blue", false, "   ")
    expect(sent2[0].content).toBe(sent[0].content)
  })

  it("含 @ 的消息走纯文本，没有卡片所以没有页脚，正文也不被改动", async () => {
    const { sender, sent } = fakeSender()
    await sender.sendMessage('请看 <at user_id="ou_1">张三</at>', undefined, "oc_main", undefined, undefined, false, "composer-2.5-fast")
    expect(sent[0].msgType).toBe("text")
    expect(JSON.parse(sent[0].content)).toEqual({ text: '请看 <at user_id="ou_1">张三</at>' })
  })
})
