/**
 * 流式卡整卡更新失败后 daemon 的应对：直接驱动真实的 updateAgentStreamCard / finishAgentStreamCard，
 * 通道里挂一个假的飞书发送器，按剧本让它失败。
 *
 * 过去失败后什么都不做：Agent 每有一点新内容（约每秒一次）daemon 就再发一遍同样会失败的整卡，
 * 每次一条 WARN，失败多久刷多久；体积超限（200860）时更是每一帧都撞墙，卡片停在旧内容上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agentStreamCards, channels, finishAgentStreamCard, updateAgentStreamCard } from "../src/daemon.js"
import { LarkSender } from "../src/shared/lark-core.js"
import { tightenByteBudget } from "../src/shared/stream-card-failure.js"

type El = Record<string, any>
const CHANNEL = "ch_failure_test"
const CHAT = `${CHANNEL}|oc_failure_test`
const SESSION = `${CHAT}::D:\\ws\\failure-test`
const CARD = "card_failure_test"

/** 剧本：每次 PUT 依次取一项；true 成功，{ code } 失败；剧本用完后一律成功 */
let plan: Array<true | { code?: number }> = []
const calls: Array<{ card: El; seq: number }> = []
const sender = {
  updateStreamingCard: vi.fn(async (_id: string, card: El, seq: number, onFailure?: (f: { code?: number }) => void) => {
    calls.push({ card, seq })
    const step = plan.shift() ?? true
    if (step === true) return true
    onFailure?.(step)
    return false
  }),
  closeStreamingCard: vi.fn(async () => true),
}
const rt: any = {
  cfg: { id: CHANNEL, name: "failure-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "", showThinking: true, showThinkingMain: true, showThinkingOthers: true },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}
const ch: any = { type: "feishu", rt, chatId: "oc_failure_test" }

const cjk = (n: number) => "思".repeat(n)
/** 一帧时间线：n 个各 1500 字的思考（约 5 KB 一个），最后一个带标记。标记放在末尾：卡片里的思考只留尾部 */
const frame = (n: number, marker = "M") => ({
  segments: [
    ...Array.from({ length: n - 1 }, (_, i) => ({ type: "thinking" as const, text: `${cjk(1500)}-T${i}` })),
    { type: "thinking" as const, text: `${cjk(1500)}-${marker}` },
  ],
})
const bytes = (c: El) => LarkSender.cardBytes(c)
const stateOf = () => agentStreamCards.get(SESSION)!

function seedCard() {
  agentStreamCards.set(SESSION, {
    cardId: CARD, messageId: "om_failure_test", sequence: 0, channelId: CHANNEL, showThinking: true,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(), questionBlocks: [],
  } as any)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-16T09:00:00Z"))
  plan = []
  calls.length = 0
  sender.updateStreamingCard.mockClear()
  sender.closeStreamingCard.mockClear()
  channels.set(CHANNEL, rt)
  seedCard()
})
afterEach(() => {
  vi.useRealTimers()
  agentStreamCards.delete(SESSION)
  channels.delete(CHANNEL)
})

describe("体积超限（200860）：按飞书的报错收紧预算，立刻重试一次", () => {
  it("第一次超限、第二次成功：只多发一次，第二次更小，卡的预算被记住", async () => {
    plan = [{ code: 200860 }, true]
    const r = await updateAgentStreamCard(SESSION, frame(4), ch)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(bytes(calls[1].card)).toBeLessThan(bytes(calls[0].card))
    expect(bytes(calls[1].card)).toBeLessThanOrEqual(tightenByteBudget(LarkSender.STREAM_CARD_BYTE_BUDGET))
    expect(stateOf().byteBudget).toBe(tightenByteBudget(LarkSender.STREAM_CARD_BYTE_BUDGET))
    // 两次都带递增的 sequence（飞书要求严格递增，否则 300317）
    expect(calls[1].seq).toBeGreaterThan(calls[0].seq)
    // 成功了：不退避、不记失败
    expect(stateOf().updateFailures).toBe(0)
    expect(stateOf().retryNotBefore).toBeUndefined()
  })

  it("之后每一帧都按收紧后的预算出，不再一帧帧撞墙", async () => {
    plan = [{ code: 200860 }, true]
    await updateAgentStreamCard(SESSION, frame(4, "A"), ch)
    calls.length = 0
    await updateAgentStreamCard(SESSION, frame(4, "B"), ch)
    expect(calls).toHaveLength(1)
    expect(bytes(calls[0].card)).toBeLessThanOrEqual(stateOf().byteBudget!)
  })

  it("重试还是失败：只重试这一次（不死循环），进入退避，预算已收紧", async () => {
    plan = [{ code: 200860 }, { code: 200860 }]
    const r = await updateAgentStreamCard(SESSION, frame(4), ch)
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(2)
    expect(stateOf().updateFailures).toBe(1)
    expect(stateOf().retryNotBefore).toBe(Date.now() + 1000)
  })

  it("退避过后下一帧继续收紧，直到下限，不会越收越小", async () => {
    let expected = LarkSender.STREAM_CARD_BYTE_BUDGET
    for (let i = 0; i < 8; i++) {
      plan = [{ code: 200860 }, { code: 200860 }]
      await updateAgentStreamCard(SESSION, frame(4, `F${i}`), ch)
      expected = tightenByteBudget(expected)
      expect(stateOf().byteBudget).toBe(expected)
      vi.setSystemTime(Date.now() + 60_000)
    }
    expect(stateOf().byteBudget).toBeGreaterThanOrEqual(8 * 1024)
  })

  it("别的错误码（比如飞书服务端 300308）不收紧预算、不重试同一帧", async () => {
    plan = [{ code: 300308 }]
    const r = await updateAgentStreamCard(SESSION, frame(4), ch)
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(1)
    expect(stateOf().byteBudget).toBeUndefined()
  })
})

describe("更新失败后退避：失败期间不再每帧都发整卡", () => {
  it("失败后立刻来的新内容不发，直接跳过（返回 skipped，不是错误），内容记着", async () => {
    plan = [{ code: 300308 }]
    await updateAgentStreamCard(SESSION, frame(2, "FIRST"), ch)
    expect(calls).toHaveLength(1)

    vi.setSystemTime(Date.now() + 300)
    const r = await updateAgentStreamCard(SESSION, frame(3, "SECOND"), ch)
    expect(r).toMatchObject({ ok: true, skipped: true })
    expect(calls).toHaveLength(1)
    // 跳过的这一帧内容没丢：留在卡的时间线里，等放行时一并带上
    expect(JSON.stringify(stateOf().lastSegments)).toContain("SECOND")
  })

  it("退避期过了放行：发的是最新内容（包含跳过期间攒下的），成功后恢复正常", async () => {
    plan = [{ code: 300308 }]
    await updateAgentStreamCard(SESSION, frame(2, "FIRST"), ch)
    vi.setSystemTime(Date.now() + 300)
    await updateAgentStreamCard(SESSION, frame(3, "SECOND"), ch)

    vi.setSystemTime(Date.now() + 800) // 距失败共 1.1s > 1s
    const r = await updateAgentStreamCard(SESSION, frame(3, "THIRD"), ch)
    expect(r.ok).toBe(true)
    expect(r.skipped).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[1].card)).toContain("THIRD")
    expect(stateOf().updateFailures).toBe(0)
    expect(stateOf().retryNotBefore).toBeUndefined()
  })

  it("连续失败：1s → 2s → 4s → 8s → 8s", async () => {
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      plan = [{ code: 300308 }]
      await updateAgentStreamCard(SESSION, frame(2, `F${i}`), ch)
      waits.push(stateOf().retryNotBefore! - Date.now())
      vi.setSystemTime(stateOf().retryNotBefore! + 1)
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })

  it("1 分钟持续失败：只发出十来次，而不是每秒一次共几十次", async () => {
    const start = Date.now()
    let attempts = 0
    // 每 400ms 来一帧新内容（Agent 正常的刷新节奏），持续 60s，飞书一直失败
    for (let t = 0; t < 60_000; t += 400) {
      vi.setSystemTime(start + t)
      plan = [{ code: 300308 }]
      const before = calls.length
      await updateAgentStreamCard(SESSION, frame(2, `F${t}`), ch)
      attempts += calls.length - before
    }
    expect(attempts).toBeLessThanOrEqual(12)
    expect(attempts).toBeGreaterThanOrEqual(6) // 仍在重试，没有放弃
  })

  it("没失败过的卡不受影响：每一帧新内容都照常发", async () => {
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(Date.now() + 400)
      await updateAgentStreamCard(SESSION, frame(2, `F${i}`), ch)
    }
    expect(calls).toHaveLength(5)
    expect(stateOf().updateFailures ?? 0).toBe(0)
    expect(stateOf().retryNotBefore).toBeUndefined()
  })

  it("内容没变的帧仍按原来的去重，不发也不算失败", async () => {
    await updateAgentStreamCard(SESSION, frame(2, "SAME"), ch)
    await updateAgentStreamCard(SESSION, frame(2, "SAME"), ch)
    expect(calls).toHaveLength(1)
  })
})

describe("收口不受退避影响", () => {
  it("正在退避时来了收口：照常发整卡并关闭流式，不会被跳过", async () => {
    plan = [{ code: 300308 }]
    await updateAgentStreamCard(SESSION, frame(2, "FIRST"), ch)
    expect(stateOf().retryNotBefore).toBeGreaterThan(Date.now())
    calls.length = 0

    const r = await finishAgentStreamCard(SESSION, { segments: [{ type: "reply", text: "最终回复" }] }, ch, CARD)
    expect(r.ok).toBe(true)
    expect(sender.closeStreamingCard).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0].card)).toContain("最终回复")
  })

  it("收口时回复很长：截到预算内发出去（过去整卡更新失败，卡片停在旧内容上）", async () => {
    const r = await finishAgentStreamCard(SESSION, { segments: [{ type: "reply", text: "开头。" + cjk(20000) }] }, ch, CARD)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(bytes(calls[0].card)).toBeLessThanOrEqual(LarkSender.STREAM_CARD_BYTE_BUDGET)
    expect(JSON.stringify(calls[0].card)).toContain("开头。")
    expect(JSON.stringify(calls[0].card)).toContain("内容过长")
  })
})
