/**
 * 进程重启后，飞书流式卡里还没答的题。
 *
 * 流式卡的状态（有哪些题、各题答没答）只在 daemon 内存里，重启就没了；登记（cardQuestionMap）倒是存盘并恢复的。
 * 过去的行为：
 *   1. 用户打字关题时，登记里的流式卡题目只被摘掉登记，飞书上那张卡的选项一直开着；
 *   2. 点这张旧卡上的选项，走的是「整卡换成一行已选择」的老路——卡上的思考、工具、正文全没了，
 *      还往队列塞一条答案，Agent 收到后把新卡上还没答的题顺手关了。
 * 现在：登记里带卡号和各题快照，重启后关题、点选都只就地改这几道题的组件，卡上别的内容不动；
 * 认不出的（旧版本存下的登记、已经关了的）点了只提示已过期。
 *
 * 直接驱动 daemon 里真实的 expireOpenCardQuestionsForSession / handleCardAction，
 * 通道里挂假的飞书发送器抓每一次对卡片的写操作，队列是真实的文件队列（临时目录）。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // daemon 在导入时就读 APP_DATA_DIR，必须先于 import 设好
  const dir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    (require("node:path") as typeof import("node:path")).join((require("node:os") as typeof import("node:os")).tmpdir(), "claw-q-restart-"),
  )
  process.env.APP_DATA_DIR = dir
  return { dir }
})

import {
  agentStreamCards, buildCardSegmentsFromPayload, cardQuestionMap, channels, expireOpenCardQuestionsForSession,
  handleCardAction, rememberStreamCardQuestion,
} from "../src/daemon.js"
import { clearAllQueueMessages, getQueueMessages, initFileQueue } from "../src/file-queue.js"
import { checkerFieldName } from "../src/shared/question-multi.js"

type El = Record<string, any>
const CH = "ch_restart_test"
const CHAT = `${CH}|oc_restart_test`
const SESSION = `${CHAT}::D:\\ws\\restart-test`
const NOTE = "问题已关闭"

const SINGLE = { blockId: "q_single", text: "状态怎么样？", options: ["正常", "异常"] }
const MULTI = { blockId: "q_multi", text: "给哪些人开？", options: ["开发", "测试", "运维"], multi: true }

const sender = {
  replaceCardElement: vi.fn(async (..._a: unknown[]) => true),
  updateStreamingCard: vi.fn(async (..._a: unknown[]) => true),
  closeStreamingCard: vi.fn(async (..._a: unknown[]) => true),
  patchCard: vi.fn(async (..._a: unknown[]) => true),
  patchRawCard: vi.fn(async (..._a: unknown[]) => true),
}
const rt: any = {
  cfg: { id: CH, name: "restart-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}

let seq = 0
const queued = () => getQueueMessages().map((m) => m.preview)

/** 题目在卡上的组件 ID：取自真实渲染，和关题 / 作答时替换的是同一个 */
function elementIdOf(blockId: string): string {
  const [seg] = buildCardSegmentsFromPayload(
    { segments: [{ type: "question", blockId, text: "x", options: ["a", "b"] }] },
    { finish: false, showThinking: false },
    undefined,
    SESSION,
  )
  if (seg.type !== "question" || !seg.elementId) throw new Error("没渲染出题目组件")
  return seg.elementId
}

/** 重启后登记里的样子：有卡号、各题快照；内存里没有这张卡 */
function seedRestored(blocks: El[], over: El = {}) {
  const messageId = `om_restart_${++seq}`
  const cardId = `card_restart_${seq}`
  cardQuestionMap.set(messageId, {
    text: "最后一道题", options: ["正常", "异常"], sessionKey: SESSION, chatKey: CHAT,
    createdAt: Date.now(), isStreamCard: true, cardId, blocks: blocks.map((b) => ({ ...b })), ...over,
  } as any)
  return { messageId, cardId }
}

/** 重启后新消息触发 Agent 回复，又发了一张带题的新卡（活卡，在内存里） */
function seedLiveCard(blocks: El[]) {
  const messageId = `om_live_${++seq}`
  agentStreamCards.set(SESSION, {
    cardId: `card_live_${seq}`, messageId, sequence: 0, channelId: CH, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(),
    questionBlocks: blocks.map((b, i) => ({ insertAt: i, ...b })),
  } as any)
  return messageId
}
const liveBlock = (id: string) => agentStreamCards.get(SESSION)!.questionBlocks.find((b) => b.blockId === id)!

const act = (messageId: string, value: El, formValue?: El) =>
  handleCardAction(rt, { messageId, chatId: "oc_restart_test", value, formValue } as any) as Promise<El>
const pick = (messageId: string, blockId: string, opt: string) =>
  act(messageId, { kind: "question", opt, sk: SESSION, blockId })

/** 替换组件的调用：[卡号, 组件 ID, 组件, sequence] */
const replaced = () => sender.replaceCardElement.mock.calls as unknown as [string, string, El, number][]
const textOf = (x: unknown) => JSON.stringify(x)
const hasTag = (x: unknown, tag: string): boolean => {
  if (Array.isArray(x)) return x.some((i) => hasTag(i, tag))
  if (x && typeof x === "object") return (x as El).tag === tag || Object.values(x).some((v) => hasTag(v, tag))
  return false
}

beforeAll(() => { initFileQueue() })
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }) })
beforeEach(() => {
  clearAllQueueMessages()
  for (const f of Object.values(sender)) f.mockClear()
  channels.set(CH, rt)
})
afterEach(() => {
  agentStreamCards.delete(SESSION)
  cardQuestionMap.clear()
  channels.delete(CH)
})

describe("用户打字（那一轮已结束，重启后常见）：把卡上还开着的题关掉", () => {
  it("每道开着的题各换成一个「已关闭」的组件（没有按钮、表单、勾选框），别的内容一概不碰，登记摘掉", async () => {
    const { messageId, cardId } = seedRestored([SINGLE, MULTI])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)

    expect(replaced()).toHaveLength(2)
    expect(replaced().map((c) => c[0])).toEqual([cardId, cardId])
    expect(replaced().map((c) => c[1])).toEqual([elementIdOf("q_single"), elementIdOf("q_multi")])
    for (const [, elementId, el] of replaced()) {
      expect(el.tag).toBe("collapsible_panel")
      expect(el.element_id).toBe(elementId)
      expect(el.header.title.content).toBe("⌛ 已关闭")
      expect(textOf(el)).toContain(NOTE)
      expect(hasTag(el, "button")).toBe(false)
      expect(hasTag(el, "form")).toBe(false)
      expect(hasTag(el, "checker")).toBe(false)
    }
    // 题干和选项表都还在，只是不能再点了
    expect(textOf(replaced()[0][2])).toContain("状态怎么样？")
    expect(textOf(replaced()[0][2])).toContain("**B.** 异常")
    expect(textOf(replaced()[1][2])).toContain("**C.** 运维")
    // 整卡不刷、不走消息 patch——后两者会把卡上的思考、工具、正文冲掉
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
    expect(sender.patchCard).not.toHaveBeenCalled()
    expect(sender.patchRawCard).not.toHaveBeenCalled()
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("同一张卡上连着写，sequence 严格递增（飞书会拒掉重复的 sequence）", async () => {
    seedRestored([SINGLE, MULTI])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    const [a, b] = replaced().map((c) => c[3])
    expect(b).toBeGreaterThan(a)
    // 不能小于重启前运行中用的计数器（从 0 起，到不了秒级时间戳这个量级）
    expect(a).toBeGreaterThan(1_000_000_000)
  })

  it("已经答过的题不动，只关还开着的", async () => {
    seedRestored([{ ...SINGLE, answered: "正常" }, MULTI])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(replaced().map((c) => c[1])).toEqual([elementIdOf("q_multi")])
  })

  it("题都已经答完 / 关掉：不发任何请求，登记照样摘掉", async () => {
    const { messageId } = seedRestored([{ ...SINGLE, answered: "正常" }, { ...MULTI, closedNote: "老的" }])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("旧版本存下的登记（没有卡号和快照）：没法改卡，只摘登记，不报错、不乱发请求", async () => {
    const { messageId } = seedRestored([SINGLE], { cardId: undefined, blocks: undefined })
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(sender.patchCard).not.toHaveBeenCalled()
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("改卡失败：登记也摘掉，之后点这张卡只会提示已过期", async () => {
    sender.replaceCardElement.mockResolvedValueOnce(false)
    const { messageId } = seedRestored([SINGLE])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(cardQuestionMap.has(messageId)).toBe(false)
    const r = await pick(messageId, "q_single", "正常")
    expect(r.toast).toMatchObject({ type: "warning" })
    expect(queued()).toEqual([])
  })

  it("用户连发两条消息、两路同时关：每道题只改一次", async () => {
    seedRestored([SINGLE, MULTI])
    await Promise.all([expireOpenCardQuestionsForSession(SESSION, NOTE), expireOpenCardQuestionsForSession(SESSION, NOTE)])
    expect(replaced()).toHaveLength(2)
  })

  it("只关本会话的卡，别的会话的登记不动", async () => {
    const mine = seedRestored([SINGLE])
    const other = seedRestored([MULTI], { sessionKey: `${CHAT}::D:\\ws\\other-session` })
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(cardQuestionMap.has(mine.messageId)).toBe(false)
    expect(cardQuestionMap.has(other.messageId)).toBe(true)
    expect(replaced().map((c) => c[0])).toEqual([mine.cardId])
  })
})

describe("重启后点旧卡上的选项（卡上的题已经被关掉了）", () => {
  it("只提示已过期：不刷卡、不入队，新卡上的题不受牵连", async () => {
    // 过程和线上一样：重启 → 用户发新消息，旧卡的题被关 → Agent 发出带题的新卡 → 用户点了旧卡
    const old = seedRestored([SINGLE])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    seedLiveCard([{ blockId: "q_new", text: "新的问题", options: ["甲", "乙"] }])
    sender.replaceCardElement.mockClear()

    const r = await pick(old.messageId, "q_single", "正常")
    expect(r.toast).toMatchObject({ type: "warning", content: "该问题已过期，请直接发消息告知选择" })
    expect(r.card).toBeUndefined()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(queued()).toEqual([])
    expect(liveBlock("q_new").closedNote).toBeUndefined()
    expect(liveBlock("q_new").answered).toBeUndefined()
  })

  it("旧版本的登记（点的那张卡认不出）：同样只提示已过期，不能把整卡换成一行已选择", async () => {
    const { messageId } = seedRestored([SINGLE], { cardId: undefined, blocks: undefined })
    const r = await pick(messageId, "q_single", "正常")
    expect(r.toast).toMatchObject({ type: "warning" })
    expect(r.card).toBeUndefined()
    expect(queued()).toEqual([])
  })

  it("登记已经没有了：同样只提示已过期", async () => {
    const r = await pick("om_never_registered", "q_single", "正常")
    expect(r.toast).toMatchObject({ type: "warning" })
    expect(r.card).toBeUndefined()
    expect(queued()).toEqual([])
  })

  it("内存里有一张新卡、但新卡上没有这道题：点的是旧卡，别拿新卡当这张卡去更新", async () => {
    const old = seedRestored([SINGLE])
    seedLiveCard([{ blockId: "q_new", text: "新的问题", options: ["甲", "乙"] }])
    sender.replaceCardElement.mockClear()

    const r = await pick(old.messageId, "q_single", "正常")
    // 能认出旧卡上的这道题：就地作答，新卡不动
    expect(r.toast).toMatchObject({ type: "success" })
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
    expect(liveBlock("q_new").answered).toBeUndefined()
    expect(liveBlock("q_new").closedNote).toBeUndefined()
  })
})

describe("重启后、还没发新消息，直接点旧卡上的选项", () => {
  it("单选：只把这道题换成「已选择」，不整卡刷新，回调里也不回整卡", async () => {
    const { messageId, cardId } = seedRestored([SINGLE])
    const r = await pick(messageId, "q_single", "正常")

    expect(r.toast).toMatchObject({ type: "success" })
    expect(r.card).toBeUndefined()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
    expect(replaced()).toHaveLength(1)
    expect(replaced()[0][0]).toBe(cardId)
    expect(replaced()[0][1]).toBe(elementIdOf("q_single"))
    expect(replaced()[0][2].header.title.content).toBe("✅ 已作答")
    expect(textOf(replaced()[0][2])).toContain("已选择: **正常**")
    expect(hasTag(replaced()[0][2], "button")).toBe(false)
  })

  it("只有这一道题：答完就把答案交给 Agent，登记摘掉", async () => {
    const { messageId } = seedRestored([SINGLE])
    const r = await pick(messageId, "q_single", "正常")
    expect(r.toast.content).toContain("已全部选择")
    expect(queued()).toEqual(["问题 1：状态怎么样？\n回答：正常"])
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("卡上有两道题：答完第一道先不通知 Agent，两道都答完才汇总交出", async () => {
    const { messageId } = seedRestored([SINGLE, MULTI])
    const first = await pick(messageId, "q_single", "异常")
    expect(first.toast.content).toContain("已选择")
    expect(queued()).toEqual([])
    expect(cardQuestionMap.has(messageId)).toBe(true)

    const prefix = elementIdOf("q_multi")
    const form = Object.fromEntries(MULTI.options.map((o, i) => [checkerFieldName(prefix, i), String(o !== "运维")]))
    const second = await act(messageId, { kind: "question_submit", sk: SESSION, blockId: "q_multi" }, form)
    expect(second.toast.content).toContain("已全部选择")
    expect(queued()).toEqual(["问题 1：状态怎么样？\n回答：异常\n\n问题 2：给哪些人开？\n回答：开发、测试"])
    expect(cardQuestionMap.has(messageId)).toBe(false)
    expect(replaced().map((c) => c[1])).toEqual([elementIdOf("q_single"), elementIdOf("q_multi")])
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("多选提交没勾东西 / 没带勾选内容：提示后题仍开着，不改卡", async () => {
    const { messageId } = seedRestored([MULTI])
    const prefix = elementIdOf("q_multi")
    const none = Object.fromEntries(MULTI.options.map((_, i) => [checkerFieldName(prefix, i), "false"]))
    const r1 = await act(messageId, { kind: "question_submit", sk: SESSION, blockId: "q_multi" }, none)
    expect(r1.toast).toMatchObject({ type: "warning", content: "请先勾选至少一项" })
    const r2 = await act(messageId, { kind: "question_submit", sk: SESSION, blockId: "q_multi" }, undefined)
    expect(r2.toast.content).toContain("没读到勾选内容")
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(queued()).toEqual([])
  })

  it("改卡失败：提示重试，这道题仍算没答，再点一次能成", async () => {
    sender.replaceCardElement.mockResolvedValueOnce(false)
    const { messageId } = seedRestored([SINGLE])
    const failed = await pick(messageId, "q_single", "正常")
    expect(failed.toast).toMatchObject({ type: "warning", content: "更新失败，请重试" })
    expect(queued()).toEqual([])
    expect(cardQuestionMap.get(messageId)?.blocks?.[0].answered).toBeUndefined()

    const again = await pick(messageId, "q_single", "正常")
    expect(again.toast).toMatchObject({ type: "success" })
    expect(queued()).toEqual(["问题 1：状态怎么样？\n回答：正常"])
  })

  it("已答过的题再点：只提示已过期，不重复改卡、不重复交给 Agent", async () => {
    const { messageId } = seedRestored([SINGLE, MULTI])
    await pick(messageId, "q_single", "正常")
    sender.replaceCardElement.mockClear()
    const again = await pick(messageId, "q_single", "异常")
    expect(again.toast).toMatchObject({ type: "warning" })
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(queued()).toEqual([])
  })
})

describe("登记里的题目快照跟着活卡走", () => {
  it("发题登记：带上卡号和这张卡上全部题目（后发的题覆盖登记时，先发的题不丢）", () => {
    const messageId = seedLiveCard([SINGLE, MULTI])
    const stream = agentStreamCards.get(SESSION)!
    rememberStreamCardQuestion(stream, {
      text: MULTI.text, displayBody: MULTI.text, options: MULTI.options, sessionKey: SESSION, chatKey: CHAT,
      createdAt: Date.now(), questionBlockId: MULTI.blockId,
    })
    const entry = cardQuestionMap.get(messageId)!
    expect(entry).toMatchObject({ isStreamCard: true, cardId: stream.cardId, questionBlockId: "q_multi" })
    expect(entry.blocks).toEqual([
      { blockId: "q_single", text: "状态怎么样？", options: ["正常", "异常"] },
      { blockId: "q_multi", text: "给哪些人开？", options: ["开发", "测试", "运维"], multi: true },
    ])
  })

  it("活卡上答了一道，登记里这道就标成已答；之后重启，只关另一道，已答的显示不被改成已关闭", async () => {
    const messageId = seedLiveCard([SINGLE, MULTI])
    const stream = agentStreamCards.get(SESSION)!
    rememberStreamCardQuestion(stream, {
      text: MULTI.text, options: MULTI.options, sessionKey: SESSION, chatKey: CHAT, createdAt: Date.now(),
    })

    const r = await pick(messageId, "q_single", "正常")
    expect(r.toast).toMatchObject({ type: "success" })
    expect(cardQuestionMap.get(messageId)!.blocks!.map((b) => b.answered)).toEqual(["正常", undefined])

    // 重启：内存里的卡没了，登记还在
    agentStreamCards.delete(SESSION)
    sender.replaceCardElement.mockClear()
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(replaced().map((c) => c[1])).toEqual([elementIdOf("q_multi")])
  })

  it("登记经过存盘再恢复（JSON 往返）后，关题照样认得出", async () => {
    const { messageId, cardId } = seedRestored([SINGLE, MULTI])
    const restored = JSON.parse(JSON.stringify(Object.fromEntries(cardQuestionMap)))
    cardQuestionMap.clear()
    cardQuestionMap.set(messageId, restored[messageId])
    await expireOpenCardQuestionsForSession(SESSION, NOTE)
    expect(replaced().map((c) => c[0])).toEqual([cardId, cardId])
  })
})

describe("独立问题卡（不在流式卡里）：单题也交带题干的问题和回答", () => {
  it("登记里有题干：答案前带上题干", async () => {
    const messageId = `om_solo_${++seq}`
    cardQuestionMap.set(messageId, { text: "状态怎么样？", options: ["正常", "异常"], sessionKey: SESSION, chatKey: CHAT, createdAt: Date.now() })
    const r = await act(messageId, { kind: "question", opt: "异常", sk: SESSION })
    expect(r.toast).toMatchObject({ type: "success" })
    expect(queued()).toEqual(["问题 1：状态怎么样？\n回答：异常"])
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("登记里找不到这张卡：问题位置写明题干未登记，答案照常交出", async () => {
    const r = await act(`om_solo_${++seq}`, { kind: "question", opt: "正常", sk: SESSION })
    expect(r.toast).toMatchObject({ type: "success" })
    expect(queued()).toEqual(["问题 1：（题干未登记）\n回答：正常"])
  })
})
