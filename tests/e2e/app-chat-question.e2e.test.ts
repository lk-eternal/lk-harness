/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：应用内的点选提问。
 *
 * 线上的问题：Agent 一次发了多个问题，用户点了其中一个，回答就直接发给了 Agent，
 * 其余问题还没选。正确的行为是：点选只记下答案，问这些题的那一轮结束（Agent 进入等待）、
 * 且这一轮的题都选完，才一次发给 Agent（和飞书的流式卡一致）。
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type ChatItem, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => {
  d = await startIsolatedDaemon()
  // 真实流程：用户先发第一条消息、Agent 领取，之后才会提问（send-question 要求会话已在系统里登记）
  expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "开始" })).ok).toBe(true)
  expect(((await d.poll()).messages ?? []).map((m) => m.text)).toEqual(["开始"])
  // Agent 开始输出（回合卡出现）并确认已处理：不确认的话，领取过的消息会被重投
  expect((await d.card("ensure")).ok).toBe(true)
  await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
})
afterEach(async () => { await d?.stop() })

/** Agent 调 send_question：返回问题的 message_id 和题号 */
async function askWithNo(text: string, options: string[], multiSelect?: boolean): Promise<{ id: string; no: number | undefined }> {
  const r = await d.post("/api/send-question", { text, options, ...(multiSelect === undefined ? {} : { multi_select: multiSelect }), session_key: d.sessionKey })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  expect(r.message_id).toBeTruthy()
  return { id: r.message_id as string, no: r.no as number | undefined }
}

/** Agent 调 send_question：返回问题的 message_id */
const ask = async (text: string, options: string[], multiSelect?: boolean): Promise<string> =>
  (await askWithNo(text, options, multiSelect)).id

/** 用户点选一个选项 */
const pick = (questionId: string, option: string) =>
  d.post("/api/app-chat/send", { sessionKey: d.sessionKey, questionId, option })

const questions = async (): Promise<ChatItem[]> => (await d.history()).filter((i) => i.kind === "question")
const questionOf = async (id: string) => (await questions()).find((q) => q.id === id)!

/**
 * Agent 说完这一轮、进入等待，领取到的消息文本（领取后确认已处理，否则下一次领取会把它重投）。
 * 进入等待 = 这一轮结束：选完的答案此时才交给 Agent。
 */
const polled = async () => {
  const texts = ((await d.waitPoll()).messages ?? []).map((m) => m.text)
  await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
  return texts
}

/** Agent 还在这一轮里干活，顺手看一眼队列（非阻塞领取，不算这一轮结束） */
const peeked = async () => ((await d.poll()).messages ?? []).map((m) => m.text)

describe("多个问题：全选完才发给 Agent", () => {
  it("选前两个时 Agent 什么也收不到；选完最后一个才收到一条带题干的汇总", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    const q2 = await ask("要不要加测试？", ["要", "不要"])
    const q3 = await ask("什么时候发？", ["今天", "明天"])

    expect((await pick(q1, "B")).ok).toBe(true)
    expect(await polled()).toEqual([])
    expect(await questionOf(q1)).toMatchObject({ answered: "B", held: true })

    expect((await pick(q2, "要")).ok).toBe(true)
    expect(await polled()).toEqual([])

    expect((await pick(q3, "明天")).ok).toBe(true)
    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n回答：要\n\n问题 3：什么时候发？\n回答：明天"])

    // 交出之后全部锁定、没有「等待」标记，再点会被拒绝
    for (const q of await questions()) expect(q.held).toBeUndefined()
    expect((await pick(q1, "A")).ok).toBe(false)
    // 只发了一次
    expect(await polled()).toEqual([])
  })

  it("选完之前可以改选，发给 Agent 的是最终选择", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    const q2 = await ask("要不要加测试？", ["要", "不要"])
    await pick(q1, "A")
    await pick(q1, "B")
    expect(await questionOf(q1)).toMatchObject({ answered: "B", held: true })
    await pick(q2, "不要")
    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n回答：不要"])
  })

  it("只有一个问题时选完就发（等这一轮结束），内容也是带题干的问题和回答", async () => {
    const q1 = await ask("要不要继续？", ["是", "否"])
    expect((await pick(q1, "是")).ok).toBe(true)
    expect(await polled()).toEqual(["问题 1：要不要继续？\n回答：是"])
    expect(await questionOf(q1)).toMatchObject({ answered: "是" })
    expect((await questionOf(q1)).held).toBeUndefined()
  })

  it("交出过的问题不会拖累下一轮：下一轮的问题照样按组发", async () => {
    const q1 = await ask("第一轮", ["是", "否"])
    await pick(q1, "是")
    expect(await polled()).toEqual(["问题 1：第一轮\n回答：是"])

    const q2 = await ask("第二轮 A", ["是", "否"])
    const q3 = await ask("第二轮 B", ["是", "否"])
    await pick(q2, "是")
    expect(await polled()).toEqual([])
    await pick(q3, "否")
    expect(await polled()).toEqual(["问题 1：第二轮 A\n回答：是\n\n问题 2：第二轮 B\n回答：否"])
  })
})

describe("多选题（multi_select）", () => {
  it("问题带 multi 标记；用户勾选多项提交后，Agent 收到按题目顺序用「、」连起来的一条", async () => {
    const q = await ask("给哪些人开？", ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"], true)
    expect(await questionOf(q)).toMatchObject({ multi: true, options: ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"] })

    expect((await pick(q, "SUB_CHILD、SUB_ADULT")).ok).toBe(true)
    expect(await polled()).toEqual(["问题 1：给哪些人开？\n回答：SUB_CHILD、SUB_ADULT"])
    expect(await questionOf(q)).toMatchObject({ answered: "SUB_CHILD、SUB_ADULT" })
    // 交出之后锁定
    expect((await pick(q, "SUB_ALL")).ok).toBe(false)
  })

  it("不传 multi_select / 传 false 都是单选；只有一个选项时 multi_select 也按单选发", async () => {
    const plain = await ask("单选", ["是", "否"])
    const off = await ask("单选 2", ["是", "否"], false)
    const lone = await ask("只有一个选项", ["好"], true)
    for (const id of [plain, off, lone]) expect((await questionOf(id)).multi).toBeUndefined()
  })

  it("和单选题同一轮：多选题的答案先记下，全答完才一起交出", async () => {
    const multi = await ask("给哪些人开？", ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT"], true)
    const single = await ask("要不要加测试？", ["要", "不要"])
    expect((await pick(multi, "SUB_TEEN、SUB_ADULT")).ok).toBe(true)
    expect(await polled()).toEqual([])
    expect(await questionOf(multi)).toMatchObject({ answered: "SUB_TEEN、SUB_ADULT", held: true })
    expect((await pick(single, "要")).ok).toBe(true)
    expect(await polled()).toEqual(["问题 1：给哪些人开？\n回答：SUB_TEEN、SUB_ADULT\n\n问题 2：要不要加测试？\n回答：要"])
  })
})

describe("问题没选完就直接发消息", () => {
  it("已选的答案不会丢：和没选的题汇成一条，先于用户的消息发给 Agent，没选的问题被关闭", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    const q2 = await ask("要不要加测试？", ["要", "不要"])
    const q3 = await ask("什么时候发？", ["今天", "明天"])
    await pick(q1, "A")
    await pick(q3, "今天")
    expect(await polled()).toEqual([])

    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第二个问题我想先聊聊" })).ok).toBe(true)

    expect(await polled()).toEqual([
      "问题 1：用哪个库？\n回答：A\n\n问题 2：要不要加测试？\n[用户未作答, 系统已自动关闭]\n\n问题 3：什么时候发？\n回答：今天",
      "第二个问题我想先聊聊",
    ])
    expect(await questionOf(q1)).toMatchObject({ answered: "A" })
    expect((await questionOf(q1)).held).toBeUndefined()
    expect(await questionOf(q2)).toMatchObject({ closedNote: "问题已关闭" })
    expect((await questionOf(q2)).answered).toBeUndefined()
  })

  it("这一轮还在跑就发消息：只有用户的消息，题不动", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    await ask("要不要加测试？", ["要", "不要"])
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "我自己说吧" })
    expect(await polled()).toEqual(["我自己说吧"])
    expect((await questionOf(q1)).closedNote).toBeUndefined()
  })

  it("这一轮已结束、一个都没选就发消息：先告诉 Agent 这些卡已关闭（只带标题），再是用户的消息", async () => {
    const q1 = await ask("**P-008 评审**\n\n痛点：……很长的正文……", ["保留", "丢弃"])
    const q2 = await ask("要不要加测试？", ["要", "不要"])
    expect(await polled()).toEqual([])
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "我自己说吧" })
    expect(await polled()).toEqual([
      "问题 1：P-008 评审\n[用户未作答, 系统已自动关闭]\n\n问题 2：要不要加测试？\n[用户未作答, 系统已自动关闭]",
      "我自己说吧",
    ])
    expect(await questionOf(q1)).toMatchObject({ closedNote: "问题已关闭" })
    expect(await questionOf(q2)).toMatchObject({ closedNote: "问题已关闭" })
  })

  it("指令不算「直接发消息」：已选的答案继续等其余问题", async () => {
    const q1 = await ask("第一题", ["是", "否"])
    const q2 = await ask("第二题", ["是", "否"])
    await pick(q1, "是")
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "/s" })
    expect(await questionOf(q1)).toMatchObject({ answered: "是", held: true })
    expect((await questionOf(q2)).closedNote).toBeUndefined()
  })
})

describe("点选要等问这些题的那一轮结束", () => {
  it("这一轮还在跑：选完也不交给 Agent；Agent 说完进入等待才收到", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    expect((await pick(q1, "B")).ok).toBe(true)

    expect(await peeked()).toEqual([])
    expect(await questionOf(q1)).toMatchObject({ answered: "B", held: true })

    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：B"])
    expect((await questionOf(q1)).held).toBeUndefined()
  })

  it("第一题选了，Agent 又发了第二题才说完：第二题没选，不能拿着第一题的结论先跑", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    await pick(q1, "B")
    const q2 = await ask("要不要加测试？", ["要", "不要"])

    expect(await polled()).toEqual([])
    expect(await questionOf(q1)).toMatchObject({ answered: "B", held: true })

    expect((await pick(q2, "要")).ok).toBe(true)
    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n回答：要"])
  })

  it("这一轮还在跑时用户打字：题不关、已选的不动；这一轮结束后选完最后一题照常交出", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    const q2 = await ask("要不要加测试？", ["要", "不要"])
    await pick(q1, "A")

    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "先聊点别的" })).ok).toBe(true)
    expect(await questionOf(q1)).toMatchObject({ answered: "A", held: true })
    expect((await questionOf(q2)).closedNote).toBeUndefined()

    expect(await polled()).toEqual(["先聊点别的"])
    expect((await pick(q2, "要")).ok).toBe(true)
    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：A\n\n问题 2：要不要加测试？\n回答：要"])
  })
})

describe("一轮结束但 Agent 没有进入等待（回合结束 worker 就退出）", () => {
  /** 用户发一条消息，Agent 领走：新一轮开始，之后问的题归这一轮 */
  async function startTurn(text: string): Promise<void> {
    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text })).ok).toBe(true)
    expect(await peeked()).toEqual([text])
  }
  const confirmTurnDone = () => d.post("/api/confirm-claimed", { session_key: d.sessionKey })

  it("确认这一批已处理就算一轮结束：选好的答案照常交出，不必等阻塞 poll", async () => {
    await startTurn("再问个问题")
    const q1 = await ask("用哪个库？", ["A", "B"])
    expect((await pick(q1, "B")).ok).toBe(true)
    expect(await questionOf(q1)).toMatchObject({ answered: "B", held: true })

    await confirmTurnDone()

    expect(await peeked()).toEqual(["问题 1：用哪个库？\n回答：B"])
    expect((await questionOf(q1)).held).toBeUndefined()
  })

  it("确认已处理之后才选：选完直接交出", async () => {
    await startTurn("再问个问题")
    const q1 = await ask("用哪个库？", ["A", "B"])
    await confirmTurnDone()

    expect((await pick(q1, "B")).ok).toBe(true)
    expect(await peeked()).toEqual(["问题 1：用哪个库？\n回答：B"])
    expect((await questionOf(q1)).held).toBeUndefined()
  })
})

describe("Agent 撤回自己发的题", () => {
  const withdraw = (...numbers: number[]) =>
    d.post("/api/withdraw-question", { numbers, session_key: d.sessionKey })

  it("发题时拿到题号，本轮内从 1 起依次递增", async () => {
    const a = await askWithNo("第一题", ["是", "否"])
    const b = await askWithNo("第二题", ["是", "否"])
    expect([a.no, b.no]).toEqual([1, 2])
    expect(await questionOf(a.id)).toMatchObject({ no: 1 })
  })

  it("按题号撤：这道题收起并标「AI 已撤回」，不再占着本轮的答案；其余已选的照常交出", async () => {
    const q1 = await askWithNo("用哪个库？", ["A", "B"])
    const q2 = await askWithNo("要不要加测试？", ["要", "不要"])
    await pick(q1.id, "B")

    const r = await withdraw(q2.no!)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.results).toEqual([{ no: 2, outcome: "withdrawn" }])
    expect(await questionOf(q2.id)).toMatchObject({ closedNote: "AI 已撤回" })

    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：B"])
  })

  it("撤回的题用户再点：被拒绝", async () => {
    const q = await askWithNo("要不要加测试？", ["要", "不要"])
    await withdraw(q.no!)
    expect((await pick(q.id, "要")).ok).toBe(false)
  })

  it("用户已经选了的不撤；题号不存在的如实说明", async () => {
    const q = await askWithNo("用哪个库？", ["A", "B"])
    await pick(q.id, "A")
    const r = await withdraw(q.no!, 9)
    expect(r.results).toEqual([{ no: 1, outcome: "answered" }, { no: 9, outcome: "unknown" }])
    expect((await questionOf(q.id)).closedNote).toBeUndefined()
    expect(await polled()).toEqual(["问题 1：用哪个库？\n回答：A"])
  })

  it("没传题号：拒绝", async () => {
    expect((await withdraw()).ok).toBe(false)
  })
})

describe("问题并进回合卡", () => {
  const turnSegments = async () => (await d.history()).find((i) => i.kind === "assistant")?.segments

  it("问题显示在卡里它发的那个位置，之后的流式更新不会把它冲掉", async () => {
    const q = await ask("用哪个库？", ["A", "B"])
    expect(await turnSegments()).toEqual([{ type: "reply", text: "处理中" }, { type: "item", itemId: q }])

    await d.card("update", { segments: [{ type: "reply", text: "处理中" }, { type: "reply", text: "等你选" }] })
    expect(await turnSegments()).toEqual([
      { type: "reply", text: "处理中" },
      { type: "item", itemId: q },
      { type: "reply", text: "等你选" },
    ])
    // 记录本身还在：点选、撤回都认它
    expect(await questionOf(q)).toMatchObject({ id: q })
  })
})
