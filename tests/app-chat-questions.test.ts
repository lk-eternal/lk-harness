import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import type { AppChatEvent, AppChatQuestionItem } from "../src/shared/app-chat-types"

const SESSION = "app_ch|app::D:\\ws\\a"
const OTHER_SESSION = "app_ch|app::D:\\ws\\b"

let dir: string
let events: AppChatEvent[]
let chat: AppChat

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-questions-"))
  events = []
  chat = new AppChat(dir, (e) => events.push(e))
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ask = (text: string, options = ["是", "否"], session = SESSION) => chat.addQuestion(session, text, options)
const question = (id: string, session = SESSION) => chat.list(session).find((i) => i.id === id) as AppChatQuestionItem

describe("只有一个问题", () => {
  it("选完立刻交出带题干的问题和回答，问题锁定", () => {
    const q1 = ask("要不要继续？")
    expect(chat.answerQuestion(SESSION, q1, "是")).toEqual({ ok: true, deliver: "问题 1：要不要继续？\n回答：是" })
    expect(question(q1)).toMatchObject({ answered: "是" })
    expect(question(q1).held).toBeUndefined()
  })

  it("交出之后不能再选", () => {
    const q1 = ask("要不要继续？")
    chat.answerQuestion(SESSION, q1, "是")
    expect(chat.answerQuestion(SESSION, q1, "否")).toEqual({ ok: false })
    expect(question(q1).answered).toBe("是")
  })

  it("不存在的问题、不是问题的记录都不能选", () => {
    chat.addUser(SESSION, "u1", "hi")
    expect(chat.answerQuestion(SESSION, "nope", "是")).toEqual({ ok: false })
    expect(chat.answerQuestion(SESSION, "u1", "是")).toEqual({ ok: false })
  })
})

describe("同一轮有多个问题：全选完才交出", () => {
  it("没选完不交出，只记下选择；最后一个选完一次交出带题干的问题和回答", () => {
    const q1 = ask("用哪个库？", ["A", "B"])
    const q2 = ask("要不要加测试？", ["要", "不要"])
    const q3 = ask("什么时候发？", ["今天", "明天"])

    expect(chat.answerQuestion(SESSION, q1, "B")).toEqual({ ok: true })
    expect(question(q1)).toMatchObject({ answered: "B", held: true })
    expect(chat.answerQuestion(SESSION, q2, "要")).toEqual({ ok: true })
    expect(question(q3).answered).toBeUndefined()

    const last = chat.answerQuestion(SESSION, q3, "明天")
    expect(last).toEqual({
      ok: true,
      deliver: "问题 1：用哪个库？\n回答：B\n\n问题 2：要不要加测试？\n回答：要\n\n问题 3：什么时候发？\n回答：明天",
    })
    // 交出后全部锁定，不再带「等待」标记
    for (const id of [q1, q2, q3]) expect(question(id).held).toBeUndefined()
    expect(chat.answerQuestion(SESSION, q1, "A")).toEqual({ ok: false })
  })

  it("汇总按聊天流里的顺序，和点击顺序无关", () => {
    const q1 = ask("第一题")
    const q2 = ask("第二题")
    const q3 = ask("第三题")
    chat.answerQuestion(SESSION, q3, "是")
    chat.answerQuestion(SESSION, q1, "否")
    const last = chat.answerQuestion(SESSION, q2, "是")
    expect(last).toEqual({ ok: true, deliver: "问题 1：第一题\n回答：否\n\n问题 2：第二题\n回答：是\n\n问题 3：第三题\n回答：是" })
  })

  it("选完之前可以改选，汇总用最终的选择", () => {
    const q1 = ask("第一题", ["A", "B"])
    const q2 = ask("第二题")
    chat.answerQuestion(SESSION, q1, "A")
    chat.answerQuestion(SESSION, q1, "B")
    expect(question(q1)).toMatchObject({ answered: "B", held: true })
    const last = chat.answerQuestion(SESSION, q2, "是")
    expect(last).toEqual({ ok: true, deliver: "问题 1：第一题\n回答：B\n\n问题 2：第二题\n回答：是" })
  })

  it("选择变化会推给界面（带 held 标记），否则界面看不到「已选、等其余」", () => {
    const q1 = ask("第一题")
    ask("第二题")
    events.length = 0
    chat.answerQuestion(SESSION, q1, "是")
    const ev = events.filter((e) => e.type === "item").at(-1)
    expect(ev?.type === "item" && ev.item.kind === "question" && ev.item.held).toBe(true)
    expect(ev?.type === "item" && ev.item.kind === "question" && ev.item.answered).toBe("是")
  })

  it("已被关闭的问题不拦着其余的，也不进汇总", () => {
    const q1 = ask("旧问题")
    chat.closeEndedQuestions(SESSION, "问题已关闭")
    const q2 = ask("新问题一")
    const q3 = ask("新问题二")
    expect(chat.answerQuestion(SESSION, q1, "是")).toEqual({ ok: false })
    expect(chat.answerQuestion(SESSION, q2, "是")).toEqual({ ok: true })
    expect(chat.answerQuestion(SESSION, q3, "否")).toEqual({ ok: true, deliver: "问题 1：新问题一\n回答：是\n\n问题 2：新问题二\n回答：否" })
  })

  it("交出过的问题不会混进下一组", () => {
    const q1 = ask("第一轮")
    expect(chat.answerQuestion(SESSION, q1, "是")).toMatchObject({ deliver: "问题 1：第一轮\n回答：是" })
    const q2 = ask("第二轮 A")
    const q3 = ask("第二轮 B")
    chat.answerQuestion(SESSION, q2, "是")
    expect(chat.answerQuestion(SESSION, q3, "否")).toEqual({ ok: true, deliver: "问题 1：第二轮 A\n回答：是\n\n问题 2：第二轮 B\n回答：否" })
  })

  it("不同会话的问题互不影响", () => {
    const a1 = ask("A 会话的问题", ["是", "否"], SESSION)
    ask("A 会话的另一个问题", ["是", "否"], SESSION)
    const b1 = ask("B 会话的问题", ["是", "否"], OTHER_SESSION)
    expect(chat.answerQuestion(OTHER_SESSION, b1, "是")).toEqual({ ok: true, deliver: "问题 1：B 会话的问题\n回答：是" })
    expect(chat.answerQuestion(SESSION, a1, "是")).toEqual({ ok: true })
  })
})

describe("问题没选完就直接发消息", () => {
  it("已选的带回答、没选的标已关闭，按题目顺序汇成一条，并真的关掉没选的", () => {
    const q1 = ask("第一题")
    const q2 = ask("第二题")
    const q3 = ask("第三题")
    chat.answerQuestion(SESSION, q1, "是")
    chat.answerQuestion(SESSION, q3, "否")

    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBe(
      "问题 1：第一题\n回答：是\n\n问题 2：第二题\n[未作答, 问题已关闭]\n\n问题 3：第三题\n回答：否",
    )

    expect(question(q1)).toMatchObject({ answered: "是" })
    expect(question(q1).held).toBeUndefined()
    expect(question(q3).held).toBeUndefined()
    expect(question(q2)).toMatchObject({ closedNote: "问题已关闭" })
    expect(question(q2).answered).toBeUndefined()
    // 只交一次
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBeUndefined()
  })

  it("一个都没选：也告诉 Agent 这张卡已关闭，只带标题（第一行），不贴整段题干", () => {
    const q1 = ask("**P-008 评审：要不要给守护进程加来源校验**\n\n痛点：……很长的正文……", ["保留", "丢弃"])
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBe("问题 1：P-008 评审：要不要给守护进程加来源校验\n[未作答, 问题已关闭]")
    expect(question(q1)).toMatchObject({ closedNote: "问题已关闭" })
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBeUndefined()
  })

  it("只选了一个也带题干（用户消息本身没有问题的上下文）", () => {
    const q1 = ask("用哪个库？", ["A", "B"])
    ask("第二题")
    chat.answerQuestion(SESSION, q1, "A")
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBe("问题 1：用哪个库？\n回答：A\n\n问题 2：第二题\n[未作答, 问题已关闭]")
  })

  it("没有未交出的题时什么也不返回", () => {
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBeUndefined()
    const q1 = ask("单个问题")
    chat.answerQuestion(SESSION, q1, "是")
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBeUndefined()
  })

  it("只取当前会话的，不碰别的会话", () => {
    const a1 = ask("A 的第一题", ["是", "否"], SESSION)
    ask("A 的第二题", ["是", "否"], SESSION)
    const b1 = ask("B 的第一题", ["是", "否"], OTHER_SESSION)
    ask("B 的第二题", ["是", "否"], OTHER_SESSION)
    chat.answerQuestion(SESSION, a1, "是")
    chat.answerQuestion(OTHER_SESSION, b1, "否")
    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBe("问题 1：A 的第一题\n回答：是\n\n问题 2：A 的第二题\n[未作答, 问题已关闭]")
    expect(question(b1, OTHER_SESSION).held).toBe(true)
  })
})

describe("落盘", () => {
  it("已选但还没交出的状态重启后还在，接着选完照样一次交出", () => {
    const q1 = ask("第一题")
    const q2 = ask("第二题")
    chat.answerQuestion(SESSION, q1, "是")
    chat.flush()

    const reloaded = new AppChat(dir, () => {})
    const items = reloaded.list(SESSION)
    expect(items.find((i) => i.id === q1)).toMatchObject({ answered: "是", held: true })
    expect(reloaded.answerQuestion(SESSION, q2, "否")).toEqual({ ok: true, deliver: "问题 1：第一题\n回答：是\n\n问题 2：第二题\n回答：否" })
  })

  it("旧版本留下的已作答记录（没有 held 字段）视为已交出，不会被拉进新的一组", () => {
    const q1 = ask("旧版本的问题")
    chat.answerQuestion(SESSION, q1, "是")
    chat.flush()
    const reloaded = new AppChat(dir, () => {})
    const q2 = reloaded.addQuestion(SESSION, "新问题", ["是", "否"])
    expect(reloaded.answerQuestion(SESSION, q2, "否")).toEqual({ ok: true, deliver: "问题 1：新问题\n回答：否" })
  })
})
