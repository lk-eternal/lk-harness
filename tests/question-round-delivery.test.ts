/**
 * 飞书流式卡里的点选：答案什么时候交给 Agent、什么时候关题。
 *
 * 规则：
 *   · 点选只记下答案。一张卡上的题都选完、且问这些题的那一轮已经结束（Agent 进入等待），才一次交给 Agent；
 *     这一轮还在跑就留着，Agent 进入等待时再交——否则 Agent 会拿着第一题的答案先跑，跑完了才等到第二题。
 *   · 用户打字：只处理那一轮已经结束的题（已选的答案和没选的题汇总先交给 Agent，没选的关掉）；那一轮还在跑的题不动。
 *   · 新消息送达只收口旧卡，不关卡上的题。
 *   · 题归问它的那一轮的发言人：只有他和管理员能点、他打字才算代替；群里别人的点击和打字不碰它。
 *
 * 直接驱动 daemon 里真实的 handleCardAction / pushMessage / deliverReadyQuestionAnswers，
 * 通道里挂假的飞书发送器，队列是真实的文件队列（临时目录）。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  // daemon 在导入时就读 APP_DATA_DIR，必须先于 import 设好
  const dir = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    (require("node:path") as typeof import("node:path")).join((require("node:os") as typeof import("node:os")).tmpdir(), "claw-q-round-"),
  )
  process.env.APP_DATA_DIR = dir
  return { dir }
})

import {
  activeSessionMap, agentStreamCards, cardQuestionMap, channels, collectFreshAndTrack, deliverReadyQuestionAnswers, handleCardAction,
  pushMessage, questionRounds, rememberStreamCardQuestion, sealActiveStreamCardOnDelivery,
} from "../src/daemon.js"
import { clearAllQueueMessages, getQueueMessages, initFileQueue } from "../src/file-queue.js"

type El = Record<string, any>
const CH = "ch_round_test"
const CHAT = `${CH}|oc_round_test`
const SESSION = `${CHAT}::D:\\ws\\round-test`
const OTHER_SESSION = `${CHAT}::D:\\ws\\round-other`

const sender = {
  replaceCardElement: vi.fn(async (..._a: unknown[]) => true),
  updateStreamingCard: vi.fn(async (..._a: unknown[]) => true),
  closeStreamingCard: vi.fn(async (..._a: unknown[]) => true),
  patchCard: vi.fn(async (..._a: unknown[]) => true),
  patchRawCard: vi.fn(async (..._a: unknown[]) => true),
}
const rt: any = {
  cfg: { id: CH, name: "round-test", type: "feishu", mainUserEnabled: false, mainUserChatId: "", workspaceDir: "" },
  sender,
  lastP2pChatId: null,
  bindArmed: false,
}

const FIRST = { blockId: "q_first", text: "用哪个库？", options: ["A", "B"] }
const SECOND = { blockId: "q_second", text: "要不要加测试？", options: ["要", "不要"] }

let seq = 0
const queued = () => getQueueMessages().map((m) => m.preview)

/** 问这道题时 Agent 所在的那一轮 */
const inRound = (session: string, ...blocks: El[]): El[] => blocks.map((b) => ({ ...b, round: questionRounds.current(session) }))

/** 活卡（在内存里）+ 登记，和 /api/send-question 发出一道题后的状态一致 */
function seedLiveCard(blocks: El[], session = SESSION): string {
  const messageId = `om_round_live_${++seq}`
  const state: any = {
    cardId: `card_round_live_${seq}`, messageId, sequence: 0, channelId: CH, showThinking: false,
    lastHash: "", lastSegments: [], mcpReplies: [], createdAt: Date.now(), inflight: Promise.resolve(),
    panelSeq: 0, knownPanelIds: new Set(), expandedPanelIds: new Set(),
    questionBlocks: blocks.map((b, i) => ({ insertAt: i, ...b })),
  }
  agentStreamCards.set(session, state)
  rememberStreamCardQuestion(state, {
    text: blocks[blocks.length - 1].text, options: blocks[blocks.length - 1].options, sessionKey: session, chatKey: CHAT,
    createdAt: Date.now(),
  })
  return messageId
}

/** 旧卡（内存里没有，只有登记里的卡号和题目快照）：用户打字之后新一轮的卡、或重启之后常见 */
function seedOldCard(blocks: El[], session = SESSION): { messageId: string; cardId: string } {
  const messageId = `om_round_old_${++seq}`
  const cardId = `card_round_old_${seq}`
  cardQuestionMap.set(messageId, {
    text: "最后一道题", options: ["A", "B"], sessionKey: session, chatKey: CHAT,
    createdAt: Date.now(), isStreamCard: true, cardId, blocks: blocks.map((b) => ({ ...b })),
  } as any)
  return { messageId, cardId }
}

/** 这道题归谁：问它的那一轮的发言人 */
const owned = (owner: string, blocks: El[]): El[] => blocks.map((b) => ({ ...b, owner }))

const act = (messageId: string, value: El, operator = "ou_round_user") =>
  handleCardAction(rt, { messageId, chatId: "oc_round_test", value, operatorOpenId: operator } as any) as Promise<El>
const pick = (messageId: string, blockId: string, opt: string, session = SESSION, operator?: string) =>
  act(messageId, { kind: "question", opt, sk: session, blockId }, operator)

/** Agent 进入阻塞 poll：这一轮结束，选完的答案此时交出 */
function endRound(session = SESSION) {
  questionRounds.end(session)
  deliverReadyQuestionAnswers(session)
}

/** 用户在飞书里打字（群聊 + 当前会话指针，消息会路由到 SESSION） */
function typeText(text: string, sender = "ou_round_user") {
  activeSessionMap.set(CHAT, SESSION)
  pushMessage(text, `om_round_typed_${++seq}`, CHAT, "group", sender)
}

const replacedIds = () => (sender.replaceCardElement.mock.calls as unknown as [string, string][]).map((c) => c[1])

beforeAll(() => { initFileQueue() })
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }) })
beforeEach(() => {
  clearAllQueueMessages()
  for (const f of Object.values(sender)) f.mockClear()
  channels.set(CH, rt)
  questionRounds.end(SESSION)
  questionRounds.end(OTHER_SESSION)
  questionRounds.setOwner(SESSION, undefined)
})
afterEach(() => {
  rt.cfg.mainUserEnabled = false
  delete rt.cfg.mainUserOpenId
  agentStreamCards.delete(SESSION)
  agentStreamCards.delete(OTHER_SESSION)
  cardQuestionMap.clear()
  activeSessionMap.delete(CHAT)
  channels.delete(CH)
})

describe("这一轮还在跑：点选只记下答案", () => {
  it("唯一一题：不交给 Agent，提示等 AI 说完；Agent 进入等待后交出带题干的问题和回答，登记摘掉", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST))
    const r = await pick(messageId, "q_first", "B")

    expect(r.toast).toMatchObject({ type: "success", content: "已选择: B，AI 说完后一起提交" })
    expect(queued()).toEqual([])
    expect(cardQuestionMap.get(messageId)?.blocks?.[0]).toMatchObject({ answered: "B" })

    endRound()
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：B"])
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("两题都选完也不交；这一轮结束后一次交出两题的汇总", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST, SECOND))
    await pick(messageId, "q_first", "B")
    const last = await pick(messageId, "q_second", "要")

    expect(last.toast.content).toBe("已选择: 要，AI 说完后一起提交")
    expect(queued()).toEqual([])

    endRound()
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n回答：要"])
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("交出之后再结束一轮：不会再交第二遍", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST))
    await pick(messageId, "q_first", "B")
    endRound()
    endRound()
    expect(queued()).toHaveLength(1)
  })

  it("旧卡（内存里没有这张卡）上点选：同样等这一轮结束再交", async () => {
    const { messageId } = seedOldCard(inRound(SESSION, FIRST))
    const r = await pick(messageId, "q_first", "A")

    expect(r.toast).toMatchObject({ type: "success", content: "已选择: A，AI 说完后一起提交" })
    expect(queued()).toEqual([])
    endRound()
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：A"])
  })
})

describe("这一轮已经结束", () => {
  it("第一题选了、第二题没选就结束了：不能拿着第一题的结论先跑，要等第二题也选完才交", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST, SECOND))
    await pick(messageId, "q_first", "B")
    endRound()
    expect(queued()).toEqual([])

    const last = await pick(messageId, "q_second", "不要")
    expect(last.toast.content).toBe("已全部选择，正在通知 Agent")
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n回答：不要"])
    expect(cardQuestionMap.has(messageId)).toBe(false)
  })

  it("一轮结束后才点选的单题：立刻交出", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST))
    endRound()
    const r = await pick(messageId, "q_first", "A")
    expect(r.toast.content).toBe("已全部选择，正在通知 Agent")
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：A"])
  })

  it("别的会话的一轮结束：不影响这个会话还在跑的题", async () => {
    const mine = seedLiveCard(inRound(SESSION, FIRST))
    await pick(mine, "q_first", "B")
    seedLiveCard(inRound(OTHER_SESSION, SECOND), OTHER_SESSION)

    endRound(OTHER_SESSION)
    expect(queued()).toEqual([])
    expect(cardQuestionMap.has(mine)).toBe(true)
  })

  it("同时有几张卡等着：这一轮结束时每张各交一条", async () => {
    const a = seedOldCard(inRound(SESSION, FIRST))
    const b = seedOldCard(inRound(SESSION, SECOND))
    await pick(a.messageId, "q_first", "A")
    await pick(b.messageId, "q_second", "要")

    endRound()
    expect(queued()).toHaveLength(2)
    expect(queued()).toEqual(expect.arrayContaining(["问题 1：用哪个库？\n回答：A", "问题 1：要不要加测试？\n回答：要"]))
  })
})

describe("用户打字", () => {
  it("这一轮还在跑：不关题、不动已选的答案，只有他的文字入队", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST, SECOND))
    await pick(messageId, "q_first", "B")
    sender.updateStreamingCard.mockClear()

    typeText("先别管这个")
    await new Promise((r) => setTimeout(r, 20))

    expect(queued()).toEqual(["先别管这个"])
    expect(cardQuestionMap.has(messageId)).toBe(true)
    expect(cardQuestionMap.get(messageId)?.blocks?.map((b) => [b.answered, b.closedNote])).toEqual([["B", undefined], [undefined, undefined]])
    expect(agentStreamCards.get(SESSION)?.questionBlocks.map((b) => b.closedNote)).toEqual([undefined, undefined])
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
  })

  it("这一轮已结束：已选的答案和没选的题汇成一条先交给 Agent，没选的关掉，然后才是他的文字", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST, SECOND))
    await pick(messageId, "q_first", "B")
    questionRounds.end(SESSION)

    typeText("用 B，别的你定")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))

    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n[用户未作答, 系统已自动关闭]", "用 B，别的你定"])
    expect(agentStreamCards.get(SESSION)?.questionBlocks.map((b) => [b.answered, b.closedNote])).toEqual([["B", undefined], [undefined, "问题已关闭"]])
  })

  it("旧卡上一个都没选：关题，并先告诉 Agent 这张卡已关闭", async () => {
    const { messageId, cardId } = seedOldCard(inRound(SESSION, FIRST))
    questionRounds.end(SESSION)

    typeText("我自己说吧")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))

    expect(queued()).toEqual(["问题 1：用哪个库？\n[用户未作答, 系统已自动关闭]", "我自己说吧"])
    expect(replacedIds()).toHaveLength(1)
    expect((sender.replaceCardElement.mock.calls[0] as unknown[])[0]).toBe(cardId)
  })

  it("旧卡上已选的答案和没选的题先汇总交出、没选的关掉，之后不会再交一遍", async () => {
    const { messageId } = seedOldCard(inRound(SESSION, FIRST, SECOND))
    await pick(messageId, "q_first", "A")
    questionRounds.end(SESSION)

    typeText("好了")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))
    endRound()

    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：A\n\n问题 2：要不要加测试？\n[用户未作答, 系统已自动关闭]", "好了"])
  })

  it("独立的单题卡（不在流式卡里）没答就被打字关掉：同样先告诉 Agent，且只告诉一次", async () => {
    const messageId = `om_round_single_${++seq}`
    cardQuestionMap.set(messageId, { text: "**要不要发版？**\n\n正文……", options: ["发", "不发"], sessionKey: SESSION, chatKey: CHAT, createdAt: Date.now() } as any)

    typeText("先别发")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))
    typeText("再说一次")
    await new Promise((r) => setTimeout(r, 20))

    expect(queued()).toEqual(["问题 1：要不要发版？\n[用户未作答, 系统已自动关闭]", "先别发", "再说一次"])
  })

  it("同时有上一轮和这一轮的卡：只处理上一轮的，这一轮的不碰", async () => {
    const old = seedOldCard(inRound(SESSION, FIRST))
    questionRounds.end(SESSION)
    const fresh = seedOldCard(inRound(SESSION, SECOND))

    typeText("补充一句")
    await vi.waitFor(() => expect(cardQuestionMap.has(old.messageId)).toBe(false))

    expect(cardQuestionMap.has(fresh.messageId)).toBe(true)
    expect(cardQuestionMap.get(fresh.messageId)?.blocks?.[0].closedNote).toBeUndefined()
  })
})

describe("新消息送达只收口旧卡，不关卡上的题", () => {
  it("收口后题仍开着、登记还在；旧卡上点选照常作答，答案等轮次规则交出", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST))
    const state = agentStreamCards.get(SESSION)!
    const cardId = state.cardId
    questionRounds.end(SESSION)

    await sealActiveStreamCardOnDelivery(SESSION)
    expect(agentStreamCards.has(SESSION)).toBe(false)
    // 收口时最后刷出去的卡里，这道题仍是开着的（没被换成「已关闭」）
    expect(state.questionBlocks[0].closedNote).toBeUndefined()
    expect(cardQuestionMap.get(messageId)?.blocks?.[0].closedNote).toBeUndefined()
    expect(cardQuestionMap.has(messageId)).toBe(true)
    expect(sender.replaceCardElement).not.toHaveBeenCalled()

    // 新一轮的卡上有新题时，点旧卡：按登记就地作答，新卡不受牵连
    const fresh = seedLiveCard(inRound(SESSION, SECOND))
    const r = await pick(messageId, "q_first", "A")
    expect(r.toast).toMatchObject({ type: "success", content: "已全部选择，正在通知 Agent" })
    expect((sender.replaceCardElement.mock.calls[0] as unknown[])[0]).toBe(cardId)
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：A"])
    expect(agentStreamCards.get(SESSION)?.questionBlocks[0].answered).toBeUndefined()
    expect(cardQuestionMap.has(fresh)).toBe(true)
  })
})

const NOT_YOURS = "这道题是问另一位成员的，请让他本人选择"

describe("题归这一轮的发言人：点选", () => {
  it("别人点：只提示，不改卡、不入队、不占掉答题位；归属人随后照常作答", async () => {
    const messageId = seedLiveCard(inRound(SESSION, ...owned("ou_a", [FIRST])))
    const refused = await pick(messageId, "q_first", "B", SESSION, "ou_b")

    expect(refused).toEqual({ toast: { type: "warning", content: NOT_YOURS } })
    expect(agentStreamCards.get(SESSION)?.questionBlocks[0].answered).toBeUndefined()
    expect(cardQuestionMap.get(messageId)?.blocks?.[0].answered).toBeUndefined()
    expect(queued()).toEqual([])

    const ok = await pick(messageId, "q_first", "A", SESSION, "ou_a")
    expect(ok.toast).toMatchObject({ type: "success", content: "已选择: A，AI 说完后一起提交" })
    endRound()
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：A"])
  })

  it("通道主用户（管理员）能替别人点", async () => {
    rt.cfg.mainUserEnabled = true
    rt.cfg.mainUserOpenId = "ou_admin"
    const messageId = seedLiveCard(inRound(SESSION, ...owned("ou_a", [FIRST])))

    const r = await pick(messageId, "q_first", "B", SESSION, "ou_admin")
    expect(r.toast).toMatchObject({ type: "success" })
    endRound()
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：B"])
  })

  it("没有归属人的题（系统消息、定时任务问的、旧版本存下的）谁都能点", async () => {
    const messageId = seedLiveCard(inRound(SESSION, FIRST))
    const r = await pick(messageId, "q_first", "A", SESSION, "ou_stranger")
    expect(r.toast).toMatchObject({ type: "success" })
  })

  it("旧卡（内存里没有这张卡）上同样：别人点被拒，归属人点照常作答", async () => {
    const { messageId } = seedOldCard(inRound(SESSION, ...owned("ou_a", [FIRST])))
    const refused = await pick(messageId, "q_first", "B", SESSION, "ou_b")

    expect(refused).toEqual({ toast: { type: "warning", content: NOT_YOURS } })
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
    expect(cardQuestionMap.get(messageId)?.blocks?.[0].answered).toBeUndefined()

    const ok = await pick(messageId, "q_first", "A", SESSION, "ou_a")
    expect(ok.toast).toMatchObject({ type: "success" })
    expect(sender.replaceCardElement).toHaveBeenCalledTimes(1)
  })

  it("多选题的提交也一样：别人提交被拒，不会去读勾选内容", async () => {
    const multi = { blockId: "q_multi", text: "给哪些人开？", options: ["甲", "乙"], multi: true }
    const messageId = seedLiveCard(inRound(SESSION, ...owned("ou_a", [multi])))

    const r = await act(messageId, { kind: "question_submit", sk: SESSION, blockId: "q_multi" }, "ou_b")
    expect(r).toEqual({ toast: { type: "warning", content: NOT_YOURS } })
  })
})

describe("题归这一轮的发言人：打字", () => {
  it("A、B、C 各有一张卡：A 打字只关 A 的，B、C 的还开着，仍能由各自的人点", async () => {
    const a = seedOldCard(inRound(SESSION, ...owned("ou_a", [FIRST])))
    const b = seedOldCard(inRound(SESSION, ...owned("ou_b", [{ ...SECOND, blockId: "q_b" }])))
    const c = seedOldCard(inRound(SESSION, ...owned("ou_c", [{ blockId: "q_c", text: "发不发版？", options: ["发", "不发"] }])))
    questionRounds.end(SESSION)

    typeText("我自己说吧", "ou_a")
    await vi.waitFor(() => expect(cardQuestionMap.has(a.messageId)).toBe(false))

    expect(cardQuestionMap.has(b.messageId)).toBe(true)
    expect(cardQuestionMap.has(c.messageId)).toBe(true)
    expect(cardQuestionMap.get(b.messageId)?.blocks?.[0].closedNote).toBeUndefined()
    expect(queued()).toEqual(["问题 1：用哪个库？\n[用户未作答, 系统已自动关闭]", "我自己说吧"])

    const r = await pick(b.messageId, "q_b", "要", SESSION, "ou_b")
    expect(r.toast).toMatchObject({ type: "success" })
  })

  it("别人打字：不关你的题，也不会把你已选的答案提前交出去", async () => {
    const { messageId } = seedOldCard(inRound(SESSION, ...owned("ou_a", [FIRST, SECOND])))
    await pick(messageId, "q_first", "A", SESSION, "ou_a")
    sender.replaceCardElement.mockClear()
    questionRounds.end(SESSION)

    typeText("我有别的事", "ou_b")
    await new Promise((r) => setTimeout(r, 20))

    expect(queued()).toEqual(["我有别的事"])
    expect(cardQuestionMap.get(messageId)?.blocks?.map((b) => [b.answered, b.closedNote])).toEqual([["A", undefined], [undefined, undefined]])
    expect(sender.replaceCardElement).not.toHaveBeenCalled()
  })

  it("归属人自己打字：已选的和没选的汇总先交出，没选的关掉，然后才是他的文字", async () => {
    const { messageId } = seedOldCard(inRound(SESSION, ...owned("ou_a", [FIRST, SECOND])))
    await pick(messageId, "q_first", "A", SESSION, "ou_a")
    questionRounds.end(SESSION)

    typeText("别的你定", "ou_a")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))
    expect(queued()).toEqual(["问题 1：用哪个库？\n回答：A\n\n问题 2：要不要加测试？\n[用户未作答, 系统已自动关闭]", "别的你定"])
  })

  it("主用户（管理员）打字：别人的题也算被他的文字代替", async () => {
    rt.cfg.mainUserEnabled = true
    rt.cfg.mainUserOpenId = "ou_admin"
    const { messageId } = seedOldCard(inRound(SESSION, ...owned("ou_a", [FIRST])))
    questionRounds.end(SESSION)

    typeText("这个先不用选了", "ou_admin")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))
    expect(queued()).toEqual(["问题 1：用哪个库？\n[用户未作答, 系统已自动关闭]", "这个先不用选了"])
  })

  it("没有归属人的题：谁打字都算代替（和以前一致）", async () => {
    const { messageId } = seedOldCard(inRound(SESSION, FIRST))
    questionRounds.end(SESSION)

    typeText("我来说", "ou_stranger")
    await vi.waitFor(() => expect(cardQuestionMap.has(messageId)).toBe(false))
  })
})

describe("领消息时记下这一批的发言人", () => {
  const delivered = (senderOpenId?: string) => [{
    text: "帮我看下", messageId: `om_batch_${++seq}`, sessionKey: SESSION, timestamp: 1,
    ...(senderOpenId ? { meta: { senderOpenId } } : {}),
  }]

  it("领到哪个人的一批，这一轮问的题就归哪个人；换一批就换人", () => {
    collectFreshAndTrack(delivered("ou_a"), SESSION)
    expect(questionRounds.owner(SESSION)).toBe("ou_a")
    collectFreshAndTrack(delivered("ou_b"), SESSION)
    expect(questionRounds.owner(SESSION)).toBe("ou_b")
  })

  it("整批都没有发言人（系统消息、定时任务）：不沿用上一批的人", () => {
    collectFreshAndTrack(delivered("ou_a"), SESSION)
    collectFreshAndTrack(delivered(), SESSION)
    expect(questionRounds.owner(SESSION)).toBeUndefined()
  })

  it("题的归属人随未决问题登记存盘，重启后还认得", () => {
    const messageId = seedLiveCard(inRound(SESSION, ...owned("ou_a", [FIRST])))
    expect(cardQuestionMap.get(messageId)?.blocks?.[0]).toMatchObject({ owner: "ou_a" })
  })
})
