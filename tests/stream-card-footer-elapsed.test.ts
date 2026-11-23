/**
 * 流式卡页脚的「本轮耗时」：建卡 → 收口。
 *
 * 带未决问题的卡收口后还会活着，等用户点选；点选、消息送达关题时都会再整卡刷新一次。
 * 过去页脚耗时每次刷新都按「现在 - 建卡时刻」重算，用户点得越晚数字越大
 * （回合 22 秒，点选后页脚变成 49s，隔几小时点就是几 h），把等用户的时间也算进去了。
 *
 * 直接驱动 daemon 里真实的 finishAgentStreamCard / updateAgentStreamCard / handleCardAction，
 * 通道里挂假的飞书发送器抓每次整卡刷新，用假的系统时间控制「过了多久」。
 *
 * 页脚格式（与应用内聊天共用 buildTurnFooter）：收口后是「模型 · 耗时 X · HH:mm」，末尾的时间是收口时刻（本机时区）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agentStreamCards, cardQuestionMap, channels, finishAgentStreamCard, handleCardAction, updateAgentStreamCard } from "../src/daemon.js"

type El = Record<string, any>
const CHANNEL = "ch_elapsed_test"
const CHAT = `${CHANNEL}|oc_elapsed_test`
const SESSION = `${CHAT}::D:\\ws\\elapsed-test`
const CARD = "card_elapsed_test"
const MODEL = "model-x"
// 点选去重按消息号记，每条测试用自己的消息号，免得被上一条测试的点击顶掉
let MESSAGE = ""
let seq = 0

const updates: El[] = []
const sender = {
  updateStreamingCard: vi.fn(async (_cardId: string, card: El) => { updates.push(card); return true }),
  closeStreamingCard: vi.fn(async () => true),
}
const rt: any = {
  cfg: { id: CHANNEL, name: "elapsed-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}
const ch: any = { type: "feishu", rt, chatId: "oc_elapsed_test" }

const reply = (text: string) => ({ segments: [{ type: "reply" as const, text }] })

/** 一张刚建好的卡，带一道还没答的单选题 */
function seedCard(opts: { withQuestion?: boolean } = {}) {
  MESSAGE = `om_elapsed_test_${++seq}`
  agentStreamCards.set(SESSION, {
    cardId: CARD, messageId: MESSAGE, sequence: 0, channelId: CHANNEL, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(),
    questionBlocks: opts.withQuestion === false
      ? []
      : [{ blockId: "q1", insertAt: 0, text: "用哪个？", options: ["开发", "测试"] }],
  } as any)
}

/** 整卡最后一个元素就是页脚（固定 element_id，孤儿卡收口时靠它单独改写） */
const footerOf = (card: El): string => {
  const last = card.body.elements.at(-1)
  expect(last.tag).toBe("markdown")
  expect(last.text_size).toBe("notation")
  expect(last.element_id).toBe("turn_footer")
  return last.content
}
/** 页脚末尾的完成时间：HH:mm，本机时区（测试机时区不固定，所以按本地时间算期望值） */
const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
const BASE_MS = Date.parse("2026-11-17T07:31:28Z")
/** 建卡后 22 秒收口的页脚 */
const FOOTER_22S = `${MODEL} · 耗时 22s · ${clock(BASE_MS + 22_000)}`
const lastFooter = () => footerOf(updates.at(-1)!)

const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)
const click = (opt = "测试") =>
  handleCardAction(rt, { messageId: MESSAGE, chatId: "oc_elapsed_test", value: { kind: "question", opt, sk: SESSION, blockId: "q1" } } as any) as Promise<El>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(BASE_MS)
  updates.length = 0
  sender.updateStreamingCard.mockClear()
  sender.closeStreamingCard.mockClear()
  channels.set(CHANNEL, rt)
})
afterEach(() => {
  vi.useRealTimers()
  agentStreamCards.delete(SESSION)
  cardQuestionMap.clear()
  channels.delete(CHANNEL)
})

describe("页脚耗时在收口时定下来", () => {
  it("没有未决问题：收口时的耗时就是页脚（对照，修复前后都一样）", async () => {
    seedCard({ withQuestion: false })
    advance(22)
    await finishAgentStreamCard(SESSION, reply("好的"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(FOOTER_22S)
  })

  it("带未决问题收口：页脚是收口时的耗时", async () => {
    seedCard()
    advance(22)
    await finishAgentStreamCard(SESSION, reply("请选"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(FOOTER_22S)
  })
})

describe("收口之后再刷新这张卡，耗时不再增长", () => {
  it("用户点选答案：整卡刷新和回调里回给飞书的卡，页脚都还是收口时的耗时", async () => {
    seedCard()
    advance(22)
    await finishAgentStreamCard(SESSION, reply("请选"), ch, CARD, MODEL)
    advance(27) // 用户 27 秒后才点

    const r = await click()
    expect(r.toast).toMatchObject({ type: "success" })
    expect(JSON.stringify(updates.at(-1))).toContain("已选择: **测试**")
    expect(lastFooter()).toBe(FOOTER_22S)
    expect(footerOf(r.card.data)).toBe(FOOTER_22S)
  })

  it("几个小时后才点选，页脚也不变", async () => {
    seedCard()
    advance(22)
    await finishAgentStreamCard(SESSION, reply("请选"), ch, CARD, MODEL)
    advance(3 * 3600)

    await click()
    expect(lastFooter()).toBe(FOOTER_22S)
  })

  it("已收口的卡再收口一次（新消息送达关题就是这条路）：页脚不变", async () => {
    seedCard()
    advance(22)
    await finishAgentStreamCard(SESSION, reply("请选"), ch, CARD, MODEL)
    advance(600)

    await finishAgentStreamCard(SESSION, reply("请选"), ch, CARD, MODEL)
    expect(updates).toHaveLength(2)
    expect(lastFooter()).toBe(FOOTER_22S)
  })
})

describe("卡被续写后再收口：以最后一次收口为准", () => {
  it("收口 → 续写（又有新内容，不带页脚）→ 再收口，页脚是第二次收口时的耗时", async () => {
    seedCard()
    advance(22)
    await finishAgentStreamCard(SESSION, reply("请选"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(FOOTER_22S)

    advance(38)
    const r = await updateAgentStreamCard(SESSION, reply("接着说"), ch, CARD)
    expect(r.ok).toBe(true)
    // 续写中的卡又回到流式状态：页脚带「运行中…」，没有完成时间
    expect(lastFooter()).toBe(`${MODEL} · <font color='turquoise'>运行中…</font> · 耗时 1m`)

    advance(0)
    await finishAgentStreamCard(SESSION, reply("接着说"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(`${MODEL} · 耗时 1m · ${clock(BASE_MS + 60_000)}`)
  })
})
