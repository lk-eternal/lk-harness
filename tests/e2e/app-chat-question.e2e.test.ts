/**
 * 端到端（真实 daemon 进程 + 真实 HTTP 接口）：应用内的点选提问。
 *
 * 线上的问题：Agent 一次发了多个问题，用户点了其中一个，回答就直接发给了 Agent，
 * 其余问题还没选。正确的行为是全部选完才一次发给 Agent（和飞书的流式卡一致）。
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

/** Agent 调 send_question：返回问题的 message_id */
async function ask(text: string, options: string[], multiSelect?: boolean): Promise<string> {
  const r = await d.post("/api/send-question", { text, options, ...(multiSelect === undefined ? {} : { multi_select: multiSelect }), session_key: d.sessionKey })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  expect(r.message_id).toBeTruthy()
  return r.message_id as string
}

/** 用户点选一个选项 */
const pick = (questionId: string, option: string) =>
  d.post("/api/app-chat/send", { sessionKey: d.sessionKey, questionId, option })

const questions = async (): Promise<ChatItem[]> => (await d.history()).filter((i) => i.kind === "question")
const questionOf = async (id: string) => (await questions()).find((q) => q.id === id)!

/** Agent 领取到的消息文本（领取后确认已处理，否则下一次领取会把它重投） */
const polled = async () => {
  const texts = ((await d.poll()).messages ?? []).map((m) => m.text)
  await d.post("/api/confirm-claimed", { session_key: d.sessionKey })
  return texts
}

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
    expect(await polled()).toEqual(["【点选汇总】\n1. 用哪个库？ → B\n2. 要不要加测试？ → 要\n3. 什么时候发？ → 明天"])

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
    expect(await polled()).toEqual(["【点选汇总】\n1. 用哪个库？ → B\n2. 要不要加测试？ → 不要"])
  })

  it("只有一个问题时点了就发，内容就是选项本身（和之前一致）", async () => {
    const q1 = await ask("要不要继续？", ["是", "否"])
    expect((await pick(q1, "是")).ok).toBe(true)
    expect(await polled()).toEqual(["是"])
    expect(await questionOf(q1)).toMatchObject({ answered: "是" })
    expect((await questionOf(q1)).held).toBeUndefined()
  })

  it("交出过的问题不会拖累下一轮：下一轮的问题照样按组发", async () => {
    const q1 = await ask("第一轮", ["是", "否"])
    await pick(q1, "是")
    expect(await polled()).toEqual(["是"])

    const q2 = await ask("第二轮 A", ["是", "否"])
    const q3 = await ask("第二轮 B", ["是", "否"])
    await pick(q2, "是")
    expect(await polled()).toEqual([])
    await pick(q3, "否")
    expect(await polled()).toEqual(["【点选汇总】\n1. 第二轮 A → 是\n2. 第二轮 B → 否"])
  })
})

describe("多选题（multi_select）", () => {
  it("问题带 multi 标记；用户勾选多项提交后，Agent 收到按题目顺序用「、」连起来的一条", async () => {
    const q = await ask("给哪些人开？", ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"], true)
    expect(await questionOf(q)).toMatchObject({ multi: true, options: ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"] })

    expect((await pick(q, "SUB_CHILD、SUB_ADULT")).ok).toBe(true)
    expect(await polled()).toEqual(["SUB_CHILD、SUB_ADULT"])
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
    expect(await polled()).toEqual(["【点选汇总】\n1. 给哪些人开？ → SUB_TEEN、SUB_ADULT\n2. 要不要加测试？ → 要"])
  })
})

describe("问题没选完就直接发消息", () => {
  it("已选的答案不会丢：先于用户的消息一起发给 Agent，没选的问题被关闭", async () => {
    const q1 = await ask("用哪个库？", ["A", "B"])
    const q2 = await ask("要不要加测试？", ["要", "不要"])
    const q3 = await ask("什么时候发？", ["今天", "明天"])
    await pick(q1, "A")
    await pick(q3, "今天")
    expect(await polled()).toEqual([])

    expect((await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "第二个问题我想先聊聊" })).ok).toBe(true)

    expect(await polled()).toEqual([
      "【点选汇总】\n1. 用哪个库？ → A\n2. 什么时候发？ → 今天",
      "第二个问题我想先聊聊",
    ])
    expect(await questionOf(q1)).toMatchObject({ answered: "A" })
    expect((await questionOf(q1)).held).toBeUndefined()
    expect(await questionOf(q2)).toMatchObject({ closedNote: "问题已关闭" })
    expect((await questionOf(q2)).answered).toBeUndefined()
  })

  it("什么都没选就发消息：只有用户的消息，没有多余的汇总", async () => {
    await ask("用哪个库？", ["A", "B"])
    await ask("要不要加测试？", ["要", "不要"])
    await d.post("/api/app-chat/send", { sessionKey: d.sessionKey, text: "我自己说吧" })
    expect(await polled()).toEqual(["我自己说吧"])
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
