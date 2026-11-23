/**
 * 流式卡页脚在「AI 还在跑」时的表现：
 *   1. 运行中页脚：模型 · 运行中… · 耗时（没有完成时间）；模型名运行中还没随 finish 下发，靠会话拉起时登记的兜底。
 *   2. 走表：长工具调用期间没有事件，页脚耗时靠 daemon 每 5 秒补一次整卡刷新往前走（tickStreamCardFooters）。
 *   3. 孤儿卡（daemon 内存里没有这张卡，多半是重启后）收口时，把还停在「运行中…」的页脚单独改写成「已中断」；
 *      正常收口过的卡，迟到的重复 finish 不能把它改成已中断。
 *   4. 回合被中断：页脚是「模型 · 已中断 · 耗时 · 时间」，已中断用橙色。
 *
 * 直接驱动 daemon 里真实的 update/finish/走表，通道里挂假的飞书发送器；只伪造 Date，其余定时器保持真实。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  agentStreamCards,
  channels,
  finishAgentStreamCard,
  sessionModelLabel,
  tickStreamCardFooters,
  updateAgentStreamCard,
} from "../src/daemon.js"

type El = Record<string, any>
const CHANNEL = "ch_footer_live_test"
const CHAT = `${CHANNEL}|oc_footer_live_test`
const SESSION = `${CHAT}::D:\\ws\\footer-live-test`
const CARD = "card_footer_live_test"
const MODEL = "model-x"
const BASE_MS = Date.parse("2026-11-17T07:31:28Z")

const RUNNING = "<font color='turquoise'>运行中…</font>"
const INTERRUPTED = "<font color='orange'>已中断</font>"

const updates: El[] = []
const sender = {
  updateStreamingCard: vi.fn(async (_cardId: string, card: El, _seq?: number) => { updates.push(card); return true }),
  closeStreamingCard: vi.fn(async (_cardId: string, _seq?: number) => true),
  replaceCardElement: vi.fn(async (_cardId: string, _elementId: string, _element: El, _seq: number) => true),
}
const rt: any = {
  cfg: { id: CHANNEL, name: "footer-live-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}
const ch: any = { type: "feishu", rt, chatId: "oc_footer_live_test" }

const reply = (text: string) => ({ segments: [{ type: "reply" as const, text }] })
const advance = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000)
const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** 一张刚建好、正在跑的卡 */
function seedCard(extra: Record<string, unknown> = {}) {
  const state: any = {
    cardId: CARD, messageId: "om_footer_live_test", sequence: 0, channelId: CHANNEL, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(), questionBlocks: [],
    ...extra,
  }
  agentStreamCards.set(SESSION, state)
  return state
}

const footerOf = (card: El): string => {
  const last = card.body.elements.at(-1)
  expect(last.element_id).toBe("turn_footer")
  expect(last.text_size).toBe("notation")
  return last.content
}
const lastFooter = () => footerOf(updates.at(-1)!)

/**
 * 走表的刷新排在 per-session 链上异步跑，等它落到发送器。
 * 不用 vi.waitFor：Date 被伪造时它会顺带把假时钟往前拨，污染耗时断言
 */
const settled = async (n: number) => {
  for (let i = 0; i < 50 && updates.length < n; i++) await new Promise((r) => setTimeout(r, 0))
  expect(updates.length).toBeGreaterThanOrEqual(n)
}
/** 确认「没有再多刷一次」：让链上已排的操作跑完 */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(BASE_MS)
  updates.length = 0
  sender.updateStreamingCard.mockClear()
  sender.closeStreamingCard.mockReset().mockResolvedValue(true)
  sender.replaceCardElement.mockReset().mockResolvedValue(true)
  channels.set(CHANNEL, rt)
  sessionModelLabel.clear()
})
afterEach(() => {
  vi.useRealTimers()
  agentStreamCards.delete(SESSION)
  channels.delete(CHANNEL)
  sessionModelLabel.clear()
})

describe("运行中的页脚：模型 · 运行中… · 耗时", () => {
  it("流式刷新就带页脚：运行中…（青绿）+ 耗时走到现在，没有完成时间", async () => {
    seedCard()
    advance(83)
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(`${MODEL} · ${RUNNING} · 耗时 1m23s`)
  })

  it("页脚是整卡最后一个元素，前面有分隔线", async () => {
    seedCard()
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD, MODEL)
    const els = updates.at(-1)!.body.elements
    expect(els.at(-2).tag).toBe("hr")
    expect(els.at(-1).element_id).toBe("turn_footer")
  })

  it("运行中还没收到 finish 下发的模型名：用会话拉起时登记的兜底", async () => {
    seedCard()
    sessionModelLabel.set(SESSION, "registered-model")
    advance(12)
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD)
    expect(lastFooter()).toBe(`registered-model · ${RUNNING} · 耗时 12s`)
  })

  it("两处都没有模型名：页脚只剩状态和耗时", async () => {
    seedCard()
    advance(5)
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD)
    expect(lastFooter()).toBe(`${RUNNING} · 耗时 5s`)
  })

  it("收口时：运行中… 消失，换成固定耗时和完成时间", async () => {
    seedCard()
    advance(10)
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD, MODEL)
    advance(12)
    await finishAgentStreamCard(SESSION, reply("好了"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(`${MODEL} · 耗时 22s · ${clock(BASE_MS + 22_000)}`)
  })
})

describe("回合被中断的收口页脚", () => {
  it("模型 · 已中断（橙色，没有 Agent 前缀）· 耗时 · 完成时间", async () => {
    seedCard()
    advance(129)
    await finishAgentStreamCard(SESSION, reply("做到一半"), ch, CARD, MODEL, true)
    expect(lastFooter()).toBe(`${MODEL} · ${INTERRUPTED} · 耗时 2m9s · ${clock(BASE_MS + 129_000)}`)
  })
})

describe("走表：没有事件时每 5 秒补刷一次，耗时才会往前走", () => {
  it("5 秒内刚刷新过的卡不补刷（按上次刷新算，不是按建卡算：卡建了很久、刚被事件刷新过也不补）", async () => {
    seedCard()
    advance(300) // 卡已经建了 5 分钟
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD, MODEL)
    expect(updates).toHaveLength(1)

    advance(4)
    tickStreamCardFooters()
    await flush()
    expect(updates).toHaveLength(1)

    advance(2) // 距上次刷新 6 秒，该补了
    tickStreamCardFooters()
    await settled(2)
    expect(lastFooter()).toBe(`${MODEL} · ${RUNNING} · 耗时 5m6s`)
  })

  it("超过 5 秒没刷新：补刷整卡，正文不变、耗时更新（绕过内容指纹去重）", async () => {
    seedCard()
    await updateAgentStreamCard(SESSION, reply("正在处理"), ch, CARD, MODEL)
    expect(lastFooter()).toBe(`${MODEL} · ${RUNNING} · 耗时 1s`)

    advance(30)
    tickStreamCardFooters()
    await settled(2)
    expect(updates).toHaveLength(2)
    expect(lastFooter()).toBe(`${MODEL} · ${RUNNING} · 耗时 30s`)
    expect(JSON.stringify(updates[1])).toContain("正在处理")

    advance(60)
    tickStreamCardFooters()
    await settled(3)
    expect(lastFooter()).toBe(`${MODEL} · ${RUNNING} · 耗时 1m30s`)
  })

  it("建卡后一直没有事件刷新过：从建卡时刻起算 5 秒，到点也补刷", async () => {
    seedCard()
    advance(3)
    tickStreamCardFooters()
    await flush()
    expect(updates).toHaveLength(0)

    advance(3)
    tickStreamCardFooters()
    await settled(1)
    expect(lastFooter()).toBe(`${RUNNING} · 耗时 6s`)
  })

  it("已收口的卡不走表：连队都不排", async () => {
    const state = seedCard({ finished: true, lastRefreshAt: Date.now() })
    advance(60)
    tickStreamCardFooters()
    expect(state.footerTickPending).toBeUndefined()
    await flush()
    expect(updates).toHaveLength(0)
  })

  it("失败退避期内的卡不走表，过了退避期恢复", async () => {
    seedCard({ lastRefreshAt: Date.now(), updateFailures: 3, retryNotBefore: Date.now() + 20_000 })
    advance(10)
    tickStreamCardFooters()
    await flush()
    expect(updates).toHaveLength(0)

    advance(15)
    tickStreamCardFooters()
    await settled(1)
    expect(lastFooter()).toBe(`${RUNNING} · 耗时 25s`)
  })

  it("建卡超过 6 小时还没收口的卡不再走表（防异常退出后无限刷）", async () => {
    seedCard()
    advance(6 * 3600 + 1)
    tickStreamCardFooters()
    await flush()
    expect(updates).toHaveLength(0)
  })

  it("上一次走表还没跑完时不重复排队", async () => {
    const state = seedCard()
    advance(10)
    tickStreamCardFooters()
    tickStreamCardFooters()
    tickStreamCardFooters()
    expect(state.footerTickPending).toBe(true)
    await settled(1)
    await flush()
    expect(updates).toHaveLength(1)
    expect(state.footerTickPending).toBe(false)
  })

  it("排上队之后、真正执行之前卡被收口了：不再刷（刷了会把收口页脚冲回运行中）", async () => {
    const state = seedCard()
    advance(10)
    tickStreamCardFooters()
    state.finished = true // 排队后、链上操作开始前，卡被收口
    await flush()
    expect(updates).toHaveLength(0)
    expect(state.footerTickPending).toBe(false)
  })

  it("排上队之后、真正执行之前卡被换成了新卡：不刷旧卡", async () => {
    const state = seedCard()
    advance(10)
    tickStreamCardFooters()
    agentStreamCards.delete(SESSION)
    await flush()
    expect(updates).toHaveLength(0)
    expect(state.footerTickPending).toBe(false)
  })
})

describe("孤儿卡收口：把停在「运行中…」的页脚改成「已中断」", () => {
  const ORPHAN = "card_orphan_live_test"

  it("daemon 内存里没有这张卡：关流式模式后，单独把页脚元素改写成橙色「已中断」", async () => {
    await finishAgentStreamCard(SESSION, reply("x"), ch, ORPHAN)

    expect(sender.closeStreamingCard).toHaveBeenCalledTimes(1)
    expect(sender.replaceCardElement).toHaveBeenCalledTimes(1)
    const [cardId, elementId, element] = sender.replaceCardElement.mock.calls[0]
    expect(cardId).toBe(ORPHAN)
    expect(elementId).toBe("turn_footer")
    expect(element).toEqual({ tag: "markdown", element_id: "turn_footer", content: INTERRUPTED, text_size: "notation" })
    expect(updates).toHaveLength(0) // 不全量 update，免得把正文冲掉
  })

  it("关流式模式和改页脚的 sequence 严格递增（飞书拒绝重复/回退的序号）", async () => {
    await finishAgentStreamCard(SESSION, reply("x"), ch, ORPHAN)
    const closeSeq = sender.closeStreamingCard.mock.calls[0][1] as number
    const replaceSeq = sender.replaceCardElement.mock.calls[0][3]
    expect(replaceSeq).toBeGreaterThan(closeSeq)
  })

  it("卡已经正常收口过：迟到的重复 finish 走孤儿路径，只关流式模式，不把页脚改成已中断", async () => {
    seedCard()
    advance(22)
    await finishAgentStreamCard(SESSION, reply("好了"), ch, CARD, MODEL)
    const finalFooter = lastFooter()
    expect(finalFooter).toBe(`${MODEL} · 耗时 22s · ${clock(BASE_MS + 22_000)}`)
    expect(agentStreamCards.has(SESSION)).toBe(false) // 正常收口后状态已摘

    sender.closeStreamingCard.mockClear()
    await finishAgentStreamCard(SESSION, reply("好了"), ch, CARD, MODEL)
    expect(sender.closeStreamingCard).toHaveBeenCalledTimes(1)
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
  })

  it("关流式模式失败（卡多半已被撤回/删除）：不再改页脚，免得多一条失败日志", async () => {
    sender.closeStreamingCard.mockResolvedValue(false)
    const r = await finishAgentStreamCard(SESSION, reply("x"), ch, ORPHAN)
    expect(r.ok).toBe(false)
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
  })

  it("没带 cardId 又没有卡：什么都不做", async () => {
    const r = await finishAgentStreamCard(SESSION, reply("x"), ch)
    expect(r).toEqual({ ok: true })
    expect(sender.closeStreamingCard).not.toHaveBeenCalled()
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
  })
})
