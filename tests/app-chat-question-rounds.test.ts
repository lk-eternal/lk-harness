import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import { QuestionRounds } from "../src/shared/question-round"
import type { AppChatQuestionItem } from "../src/shared/app-chat-types"

const SESSION = "app_ch|app::D:\\ws\\a"

let dir: string
let rounds: QuestionRounds
let chat: AppChat

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-question-rounds-"))
  rounds = new QuestionRounds()
  chat = new AppChat(dir, () => {}, (sessionKey, round) => rounds.isEnded(sessionKey, round))
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 在 Agent 当前这一轮里发一道题 */
const ask = (text: string, options = ["是", "否"]) => chat.addQuestion(SESSION, text, options, false, rounds.current(SESSION))
const question = (id: string) => chat.list(SESSION).find((i) => i.id === id) as AppChatQuestionItem

describe("这一轮还在跑：选完也先不交出", () => {
  it("只记下选择（可改选），这一轮结束后取出一次，带题干的问题和回答", () => {
    const q1 = ask("用哪个库？", ["A", "B"])
    expect(chat.answerQuestion(SESSION, q1, "A")).toEqual({ ok: true })
    expect(chat.answerQuestion(SESSION, q1, "B")).toEqual({ ok: true })
    expect(question(q1)).toMatchObject({ answered: "B", held: true })
    expect(chat.takeReadyAnswers(SESSION)).toEqual([])

    rounds.end(SESSION)
    expect(chat.takeReadyAnswers(SESSION)).toEqual([{ text: "问题 1：用哪个库？\n回答：B", anchorId: q1 }])
    expect(question(q1).held).toBeUndefined()
    // 交出就锁定，也不会再被取一次
    expect(chat.answerQuestion(SESSION, q1, "A")).toEqual({ ok: false })
    expect(chat.takeReadyAnswers(SESSION)).toEqual([])
  })

  it("一轮里先选了第一题、第二题是这一轮后面才发的：两题选完并等到这一轮结束，一起交出", () => {
    const q1 = ask("用哪个库？", ["A", "B"])
    chat.answerQuestion(SESSION, q1, "B")
    const q2 = ask("给哪些人开？", ["甲", "乙"])
    expect(chat.takeReadyAnswers(SESSION)).toEqual([])

    rounds.end(SESSION)
    // 第二题还没选：这一轮已结束，也不能拿着第一题的结论先跑
    expect(chat.takeReadyAnswers(SESSION)).toEqual([])

    expect(chat.answerQuestion(SESSION, q2, "乙")).toEqual({
      ok: true,
      deliver: "问题 1：用哪个库？\n回答：B\n\n问题 2：给哪些人开？\n回答：乙",
    })
  })
})

describe("这一轮已结束", () => {
  it("没选完的题，之后选完最后一道立刻交出", () => {
    const q1 = ask("第一题", ["A", "B"])
    const q2 = ask("第二题", ["A", "B"])
    chat.answerQuestion(SESSION, q1, "A")
    rounds.end(SESSION)

    expect(chat.answerQuestion(SESSION, q2, "B")).toEqual({
      ok: true,
      deliver: "问题 1：第一题\n回答：A\n\n问题 2：第二题\n回答：B",
    })
  })

  it("每一轮的题各是一组：已结束那一轮选完就交出，不等新一轮还没选的题", () => {
    const old = ask("上一轮的题")
    rounds.end(SESSION)
    const fresh = ask("新一轮的题")

    expect(chat.answerQuestion(SESSION, old, "是")).toEqual({ ok: true, deliver: "问题 1：上一轮的题\n回答：是" })
    expect(question(fresh).answered).toBeUndefined()
  })

  it("新一轮选完但还在跑：先留着，不受上一轮的题影响；它这一轮结束后才交出", () => {
    ask("上一轮的题（一直没选）")
    rounds.end(SESSION)
    const fresh = ask("新一轮的题")

    expect(chat.answerQuestion(SESSION, fresh, "是")).toEqual({ ok: true })
    rounds.end(SESSION)
    expect(chat.takeReadyAnswers(SESSION)).toEqual([{ text: "问题 1：新一轮的题\n回答：是", anchorId: fresh }])
  })

  it("多组同时等着：每组各取一条，anchorId 是组里第一道题", () => {
    const a1 = ask("甲一")
    const a2 = ask("甲二")
    chat.answerQuestion(SESSION, a1, "是")
    chat.answerQuestion(SESSION, a2, "否")
    rounds.end(SESSION)
    // 第二轮还没结束就被取，不会混进来
    const b1 = ask("乙一")
    chat.answerQuestion(SESSION, b1, "是")

    expect(chat.takeReadyAnswers(SESSION)).toEqual([
      { text: "问题 1：甲一\n回答：是\n\n问题 2：甲二\n回答：否", anchorId: a1 },
    ])
    expect(question(b1)).toMatchObject({ answered: "是", held: true })
  })
})

describe("用户打字", () => {
  it("这一轮已结束：已选的带回答、没选的标已关闭，汇成一条，并关掉没选的", () => {
    const q1 = ask("第一题", ["A", "B"])
    const q2 = ask("第二题", ["A", "B"])
    chat.answerQuestion(SESSION, q1, "B")
    rounds.end(SESSION)

    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBe("问题 1：第一题\n回答：B\n\n问题 2：第二题\n[用户未作答, 系统已自动关闭]")
    expect(question(q1).closedNote).toBeUndefined()
    expect(question(q2).closedNote).toBe("问题已关闭")
  })

  it("这一轮还在跑：已选的不动、没选的不关（用户可能还没看到后面发的题）", () => {
    const q1 = ask("第一题", ["A", "B"])
    const q2 = ask("第二题", ["A", "B"])
    chat.answerQuestion(SESSION, q1, "B")

    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBeUndefined()
    expect(question(q1)).toMatchObject({ answered: "B", held: true })
    expect(question(q2).closedNote).toBeUndefined()
  })

  it("只处理已结束那一轮的题：同时有上一轮和这一轮的题时，这一轮的不碰", () => {
    const old = ask("上一轮的题")
    rounds.end(SESSION)
    const fresh = ask("这一轮的题")

    expect(chat.closeEndedQuestions(SESSION, "问题已关闭")).toBe("问题 1：上一轮的题\n[用户未作答, 系统已自动关闭]")
    expect(question(old).closedNote).toBe("问题已关闭")
    expect(question(fresh).closedNote).toBeUndefined()
  })
})

describe("旧记录 / 重启之后", () => {
  it("没记轮次的题（旧版本存下的）算已结束：选完立刻交出", () => {
    const q1 = chat.addQuestion(SESSION, "旧题", ["是", "否"])
    expect(chat.answerQuestion(SESSION, q1, "是")).toEqual({ ok: true, deliver: "问题 1：旧题\n回答：是" })
  })

  it("记着上次运行的轮次编号的题：这次运行里对不上当前这一轮，算已结束", () => {
    const q1 = chat.addQuestion(SESSION, "上次的题", ["是", "否"], false, "上次运行留下的编号")
    rounds.current(SESSION)
    expect(chat.answerQuestion(SESSION, q1, "是")).toEqual({ ok: true, deliver: "问题 1：上次的题\n回答：是" })
  })
})
