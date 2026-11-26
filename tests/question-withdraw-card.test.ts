/**
 * 飞书流式卡里 Agent 撤回自己发的题：按题号关掉没作答的，刷卡，登记同步；刷卡失败要退回。
 *
 * 直接驱动 daemon 里真实的 withdrawStreamQuestions / handleCardAction / deliverReadyQuestionAnswers，
 * 通道里挂假的飞书发送器，队列是真实的文件队列（临时目录）。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // daemon 在导入时就读 APP_DATA_DIR，必须先于 import 设好
  const dir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    (require("node:path") as typeof import("node:path")).join((require("node:os") as typeof import("node:os")).tmpdir(), "claw-q-withdraw-"),
  )
  process.env.APP_DATA_DIR = dir
  return { dir }
})

import {
  agentStreamCards, cardQuestionMap, channels, deliverReadyQuestionAnswers, handleCardAction, questionRounds,
  rememberStreamCardQuestion, withdrawStreamQuestions,
} from "../src/daemon.js"
import { clearAllQueueMessages, getQueueMessages, initFileQueue } from "../src/file-queue.js"
import { WITHDRAW_NOTE } from "../src/shared/question-withdraw.js"

type El = Record<string, any>
const CH = "ch_withdraw_test"
const CHAT = `${CH}|oc_withdraw_test`
const SESSION = `${CHAT}::D:\\ws\\withdraw-test`

const sender = {
  replaceCardElement: vi.fn(async (..._a: unknown[]) => true),
  updateStreamingCard: vi.fn(async (..._a: unknown[]) => true),
  closeStreamingCard: vi.fn(async (..._a: unknown[]) => true),
  patchCard: vi.fn(async (..._a: unknown[]) => true),
  patchRawCard: vi.fn(async (..._a: unknown[]) => true),
}
const rt: any = {
  cfg: { id: CH, name: "withdraw-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}
const ch: any = { type: "feishu", rt, chatId: "oc_withdraw_test" }

const FIRST = { blockId: "q_first", text: "用哪个库？", options: ["A", "B"] }
const SECOND = { blockId: "q_second", text: "要不要加测试？", options: ["要", "不要"] }

let seq = 0
const queued = () => getQueueMessages().map((m) => m.preview)

/** 在 Agent 当前这一轮里依次发的题：轮次和题号和 /api/send-question 发出时一致 */
function askedInRound(...blocks: El[]): El[] {
  return blocks.map((b) => ({ ...b, round: questionRounds.current(SESSION), no: questionRounds.nextQuestionNo(SESSION) }))
}

/** 活卡（在内存里）+ 登记，和 /api/send-question 发出题后的状态一致 */
function seedLiveCard(blocks: El[]): string {
  const messageId = `om_withdraw_live_${++seq}`
  const state: any = {
    cardId: `card_withdraw_live_${seq}`, messageId, sequence: 0, channelId: CH, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(),
    questionBlocks: blocks.map((b, i) => ({ insertAt: i, ...b })),
  }
  agentStreamCards.set(SESSION, state)
  rememberStreamCardQuestion(state, {
    text: blocks[blocks.length - 1].text, options: blocks[blocks.length - 1].options, sessionKey: SESSION, chatKey: CHAT,
    createdAt: Date.now(),
  })
  return messageId
}

const blocksOf = (): El[] => (agentStreamCards.get(SESSION) as any).questionBlocks

beforeAll(() => { initFileQueue() })
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }) })
beforeEach(() => {
  clearAllQueueMessages()
  for (const f of Object.values(sender)) f.mockClear()
  sender.updateStreamingCard.mockImplementation(async () => true)
  channels.set(CH, rt)
  questionRounds.end(SESSION)
})
afterEach(() => {
  agentStreamCards.delete(SESSION)
  cardQuestionMap.clear()
  channels.delete(CH)
})

describe("Agent 撤回流式卡里的题", () => {
  it("按题号撤没作答的：标上「AI 已撤回」，刷卡，登记快照同步，其余的题不动", async () => {
    const messageId = seedLiveCard(askedInRound(FIRST, SECOND))

    const results = await withdrawStreamQuestions(SESSION, ch, [2])

    expect(results).toEqual([{ no: 2, outcome: "withdrawn" }])
    expect(blocksOf()[1].closedNote).toBe(WITHDRAW_NOTE)
    expect(blocksOf()[0].closedNote).toBeUndefined()
    expect(sender.updateStreamingCard).toHaveBeenCalled()
    expect(cardQuestionMap.get(messageId)?.blocks?.map((b) => b.closedNote)).toEqual([undefined, WITHDRAW_NOTE])
  })

  it("撤掉没选的那道，其余已选的答案不再被它卡住：这一轮结束就交出，汇总里没有被撤的题", async () => {
    const messageId = seedLiveCard(askedInRound(FIRST, SECOND))
    await handleCardAction(rt, { messageId, chatId: "oc_withdraw_test", value: { kind: "question", opt: "B", sk: SESSION, blockId: "q_first" }, operatorOpenId: "ou_u" } as any)

    await withdrawStreamQuestions(SESSION, ch, [2])
    expect(queued()).toEqual([])

    questionRounds.end(SESSION)
    deliverReadyQuestionAnswers(SESSION)
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：B"])
  })

  it("用户已经选了的不撤：答案保留", async () => {
    const messageId = seedLiveCard(askedInRound(FIRST))
    await handleCardAction(rt, { messageId, chatId: "oc_withdraw_test", value: { kind: "question", opt: "A", sk: SESSION, blockId: "q_first" }, operatorOpenId: "ou_u" } as any)
    sender.updateStreamingCard.mockClear()

    expect(await withdrawStreamQuestions(SESSION, ch, [1])).toEqual([{ no: 1, outcome: "answered" }])
    expect(blocksOf()[0].closedNote).toBeUndefined()
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("撤过的、不是本轮的题号：不刷卡，如实说明", async () => {
    seedLiveCard(askedInRound(FIRST))
    await withdrawStreamQuestions(SESSION, ch, [1])
    sender.updateStreamingCard.mockClear()

    expect(await withdrawStreamQuestions(SESSION, ch, [1, 7])).toEqual([
      { no: 1, outcome: "closed" },
      { no: 7, outcome: "unknown" },
    ])
    expect(sender.updateStreamingCard).not.toHaveBeenCalled()
  })

  it("上一轮的题不撤：这一轮的题号和它重号也不会撤错", async () => {
    seedLiveCard(askedInRound(FIRST))
    questionRounds.end(SESSION)
    // 新一轮：题号重新从 1 起；卡上有上一轮的 1 号题，也有这一轮新发的 1 号题
    const current = askedInRound(SECOND)
    const state = agentStreamCards.get(SESSION) as any
    state.questionBlocks.push({ insertAt: 1, ...current[0] })

    expect(await withdrawStreamQuestions(SESSION, ch, [1])).toEqual([{ no: 1, outcome: "withdrawn" }])
    expect(blocksOf()[0].closedNote).toBeUndefined()
    expect(blocksOf()[1].closedNote).toBe(WITHDRAW_NOTE)
  })

  it("内存里没有这张卡：所有题号都找不到", async () => {
    expect(await withdrawStreamQuestions(SESSION, ch, [1, 2])).toEqual([
      { no: 1, outcome: "unknown" },
      { no: 2, outcome: "unknown" },
    ])
  })

  it("刷卡连着两次失败：标记退回去并报错，卡上还开着的题和内存里一致", async () => {
    seedLiveCard(askedInRound(FIRST))
    sender.updateStreamingCard.mockImplementation(async () => false)

    await expect(withdrawStreamQuestions(SESSION, ch, [1])).rejects.toThrow("撤回没有生效")
    expect(blocksOf()[0].closedNote).toBeUndefined()
    expect(sender.updateStreamingCard).toHaveBeenCalledTimes(2)
  })
})
