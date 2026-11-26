/**
 * 飞书流式卡里的内联图片：图片组件的渲染，以及 daemon 把 send_image 并进卡里的流程。
 *
 * 直接驱动 daemon 里真实的 embedImageInStreamCard / updateAgentStreamCard / finishAgentStreamCard，
 * 通道里挂假的飞书发送器（上传、整卡更新都是假的）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agentStreamCards, channels, embedImageInStreamCard, finishAgentStreamCard, updateAgentStreamCard } from "../src/daemon.js"
import { LarkSender } from "../src/shared/lark-core.js"

type El = Record<string, any>
const CHANNEL = "ch_image_test"
const CHAT = `${CHANNEL}|oc_image_test`
const SESSION = `${CHAT}::D:\\ws\\image-test`
const CARD = "card_image_test"

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
  uploadImage: vi.fn(async (_path: string): Promise<string | undefined> => "img_key_1"),
}
const rt: any = {
  cfg: { id: CHANNEL, name: "image-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "", showThinking: true, showThinkingMain: true, showThinkingOthers: true },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}
const ch: any = { type: "feishu", rt, chatId: "oc_image_test" }

const reply = (text: string) => ({ type: "reply" as const, text })
const tools = (name: string) => ({ type: "tools" as const, tools: [{ name, status: "done", summary: `${name}.ts` }] })

/** 一张卡的元素按顺序的简写：正文是文字、图片是 img:key、折叠面板是 panel，其余（页脚等）原样 tag */
function layout(card: El): string[] {
  return (card.body.elements as El[]).map((e) => {
    if (e.tag === "markdown") return String(e.content)
    if (e.tag === "img") return `img:${e.img_key}`
    if (e.tag === "collapsible_panel") return "panel"
    return e.tag
  })
}
const lastCard = (): El => calls[calls.length - 1].card

function seedCard(over: Record<string, unknown> = {}) {
  agentStreamCards.set(SESSION, {
    cardId: CARD, messageId: "om_image_test", sequence: 0, channelId: CHANNEL, showThinking: true,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(), questionBlocks: [],
    ...over,
  } as any)
}
const stateOf = () => agentStreamCards.get(SESSION)!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-26T09:00:00Z"))
  plan = []
  calls.length = 0
  sender.updateStreamingCard.mockClear()
  sender.uploadImage.mockClear()
  sender.uploadImage.mockImplementation(async () => "img_key_1")
  channels.set(CHANNEL, rt)
})
afterEach(() => {
  vi.useRealTimers()
  agentStreamCards.delete(SESSION)
  channels.delete(CHANNEL)
})

describe("图片组件", () => {
  it("按时间线位置输出 img 组件：在前后两段正文之间，紧凑宽度", () => {
    const card = LarkSender.buildStreamingCardJson({
      status: "streaming",
      segments: [reply("前面"), { type: "image", imageKey: "img_key_x" }, reply("后面")],
    })
    expect(layout(card as El).slice(0, 3)).toEqual(["前面", "img:img_key_x", "后面"])
    const img = (card.body as El).elements.find((e: El) => e.tag === "img")
    expect(img).toMatchObject({ img_key: "img_key_x", scale_type: "fit_horizontal", compact_width: true })
  })

  it("裁剪旧过程段时图片不会被丢", () => {
    const card = LarkSender.buildStreamingCardJson({
      status: "streaming",
      keepPerKind: 1,
      segments: [
        { type: "image", imageKey: "img_key_x" },
        { ...tools("a"), steps: [{ title: "a", status: "success" }] },
        reply("一"),
        { ...tools("b"), steps: [{ title: "b", status: "success" }] },
        reply("二"),
        { ...tools("c"), steps: [{ title: "c", status: "success" }] },
      ] as any,
    })
    expect(layout(card as El)).toContain("img:img_key_x")
  })
})

describe("send_image 并进流式卡", () => {
  it("图片显示在发出时的位置；之后 SDK 继续更新，图片仍在原位置", async () => {
    seedCard()
    await updateAgentStreamCard(SESSION, { segments: [reply("前面的话")] }, ch)

    expect(await embedImageInStreamCard(SESSION, ch, "/tmp/chart.png")).toBe(true)
    expect(sender.uploadImage).toHaveBeenCalledWith("/tmp/chart.png")
    expect(layout(lastCard()).slice(0, 2)).toEqual(["前面的话", "img:img_key_1"])

    await updateAgentStreamCard(SESSION, { segments: [reply("前面的话"), tools("read")] }, ch)
    expect(layout(lastCard()).slice(0, 3)).toEqual(["前面的话", "img:img_key_1", "panel"])
  })

  it("一个回合里发多张：各在各的位置", async () => {
    seedCard()
    await updateAgentStreamCard(SESSION, { segments: [reply("一")] }, ch)
    sender.uploadImage.mockImplementation(async () => "img_key_1")
    await embedImageInStreamCard(SESSION, ch, "/tmp/a.png")
    await updateAgentStreamCard(SESSION, { segments: [reply("一"), tools("read")] }, ch)
    sender.uploadImage.mockImplementation(async () => "img_key_2")
    await embedImageInStreamCard(SESSION, ch, "/tmp/b.png")

    expect(layout(lastCard()).slice(0, 4)).toEqual(["一", "img:img_key_1", "panel", "img:img_key_2"])
  })

  it("刷卡失败：图片块退回去返回 false（调用方改发独立图片），卡不留飞书不认的内容", async () => {
    seedCard()
    await updateAgentStreamCard(SESSION, { segments: [reply("前面的话")] }, ch)
    plan = [{ code: 11310 }]

    expect(await embedImageInStreamCard(SESSION, ch, "/tmp/chart.png")).toBe(false)
    expect(stateOf().imageBlocks).toEqual([])

    // 刷卡失败后有退避期，过了才会再发流式刷新
    vi.setSystemTime(new Date("2026-11-26T09:00:10Z"))
    plan = []
    await updateAgentStreamCard(SESSION, { segments: [reply("前面的话"), tools("read")] }, ch)
    expect(layout(lastCard()).some((l) => l.startsWith("img:"))).toBe(false)
    expect(layout(lastCard()).slice(0, 2)).toEqual(["前面的话", "panel"])
  })

  it("上传失败：返回 false，不动卡", async () => {
    seedCard()
    sender.uploadImage.mockImplementation(async () => undefined)

    expect(await embedImageInStreamCard(SESSION, ch, "/tmp/chart.png")).toBe(false)
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("没有进行中的卡（没有，或已收口）：返回 false，也不上传", async () => {
    expect(await embedImageInStreamCard(SESSION, ch, "/tmp/chart.png")).toBe(false)

    seedCard({ finished: true })
    expect(await embedImageInStreamCard(SESSION, ch, "/tmp/chart.png")).toBe(false)
    expect(sender.uploadImage).not.toHaveBeenCalled()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })
})

describe("收口", () => {
  const placeholder = (card: El) => layout(card).some((l) => l.includes("仅包含思考"))

  it("只有思考和一张图：收口后图片留着，不再补「仅包含思考」", async () => {
    // 对照：没有图片时，只有思考的回合收口后会补占位
    seedCard()
    await finishAgentStreamCard(SESSION, { segments: [{ type: "thinking", text: "想想" }] }, ch, CARD)
    expect(placeholder(lastCard())).toBe(true)

    calls.length = 0
    seedCard()
    await updateAgentStreamCard(SESSION, { segments: [{ type: "thinking", text: "想想" }] }, ch)
    await embedImageInStreamCard(SESSION, ch, "/tmp/chart.png")
    await finishAgentStreamCard(SESSION, { segments: [{ type: "thinking", text: "想想" }] }, ch, CARD)

    expect(layout(lastCard())).toContain("img:img_key_1")
    expect(placeholder(lastCard())).toBe(false)
  })
})
