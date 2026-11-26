import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import { QuestionRounds } from "../src/shared/question-round"
import { WITHDRAW_NOTE, formatWithdrawReport, withdrawOutcome } from "../src/shared/question-withdraw"
import type { AppChatQuestionItem } from "../src/shared/app-chat-types"

describe("withdrawOutcome：这道题此刻能不能撤", () => {
  it("没找到：不是本轮发出的题号", () => {
    expect(withdrawOutcome(undefined)).toBe("unknown")
  })

  it("还没作答、没关闭：可撤", () => {
    expect(withdrawOutcome({})).toBe("withdrawn")
  })

  it("用户已经选了：保留，不撤", () => {
    expect(withdrawOutcome({ answered: "A" })).toBe("answered")
  })

  it("已经关闭：不用再撤；关闭优先于作答", () => {
    expect(withdrawOutcome({ closedNote: "问题已关闭" })).toBe("closed")
    expect(withdrawOutcome({ closedNote: "问题已关闭", answered: "A" })).toBe("closed")
  })
})

describe("formatWithdrawReport：写给 Agent 看的结果", () => {
  it("全部撤回", () => {
    expect(formatWithdrawReport([{ no: 1, outcome: "withdrawn" }, { no: 3, outcome: "withdrawn" }])).toBe("已撤回题号 1、3。")
  })

  it("没撤的逐类说明原因", () => {
    const text = formatWithdrawReport([
      { no: 1, outcome: "withdrawn" },
      { no: 2, outcome: "answered" },
      { no: 4, outcome: "closed" },
      { no: 5, outcome: "unknown" },
    ])
    expect(text).toContain("已撤回题号 1。")
    expect(text).toContain("题号 2 用户已经作答，没有撤回")
    expect(text).toContain("题号 4 早已关闭")
    expect(text).toContain("没找到题号 5")
  })
})

const SESSION = "app_ch|app::D:\\ws\\a"

describe("AppChat.withdrawQuestions", () => {
  let dir: string
  let rounds: QuestionRounds
  let chat: AppChat

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-withdraw-"))
    rounds = new QuestionRounds()
    chat = new AppChat(dir, () => {}, (sessionKey, round) => rounds.isEnded(sessionKey, round))
  })

  afterEach(() => {
    chat.flush()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** 在 Agent 当前这一轮里发一道题，题号由轮次记录发 */
  const ask = (text: string, options = ["A", "B"]) =>
    chat.addQuestion(SESSION, text, options, false, rounds.current(SESSION), rounds.nextQuestionNo(SESSION))
  const question = (id: string) => chat.list(SESSION).find((i) => i.id === id) as AppChatQuestionItem
  const withdraw = (...nos: number[]) => chat.withdrawQuestions(SESSION, rounds.current(SESSION), nos, WITHDRAW_NOTE)

  it("按题号撤：关掉并标上说明，其余的题不动", () => {
    const q1 = ask("第一题")
    const q2 = ask("第二题")
    expect(withdraw(2)).toEqual([{ no: 2, outcome: "withdrawn" }])
    expect(question(q2).closedNote).toBe(WITHDRAW_NOTE)
    expect(question(q1).closedNote).toBeUndefined()
  })

  it("撤掉没选的那道，不再卡住同一轮其余已选的答案：这一轮结束就交出，汇总里没有被撤的题", () => {
    const q1 = ask("用哪个库？")
    const q2 = ask("给哪些人开？")
    chat.answerQuestion(SESSION, q1, "B")
    withdraw(2)
    expect(question(q2).closedNote).toBe(WITHDRAW_NOTE)

    rounds.end(SESSION)
    expect(chat.takeReadyAnswers(SESSION)).toEqual([{ text: "问题 1：用哪个库？\n回答：B", anchorId: q1 }])
  })

  it("用户已经选了的不撤：答案保留，仍照常交出", () => {
    const q1 = ask("用哪个库？")
    chat.answerQuestion(SESSION, q1, "A")
    expect(withdraw(1)).toEqual([{ no: 1, outcome: "answered" }])
    expect(question(q1).closedNote).toBeUndefined()
    rounds.end(SESSION)
    expect(chat.takeReadyAnswers(SESSION)).toEqual([{ text: "问题 1：用哪个库？\n回答：A", anchorId: q1 }])
  })

  it("撤过的题再撤：说已经关闭，不重复改", () => {
    ask("第一题")
    withdraw(1)
    expect(withdraw(1)).toEqual([{ no: 1, outcome: "closed" }])
  })

  it("题号不是本轮的：找不到；上一轮的题不撤", () => {
    const old = ask("上一轮的题")
    rounds.end(SESSION)
    ask("这一轮的题")
    // 这一轮也有 1 号，但撤的是这一轮的那道，上一轮的不受影响
    expect(withdraw(1, 9)).toEqual([{ no: 1, outcome: "withdrawn" }, { no: 9, outcome: "unknown" }])
    expect(question(old).closedNote).toBeUndefined()
  })

  it("撤回通过记录事件推给界面", () => {
    const events: unknown[] = []
    const watched = new AppChat(dir, (e) => events.push(e), (sessionKey, round) => rounds.isEnded(sessionKey, round))
    const id = watched.addQuestion(SESSION, "题", ["A"], false, rounds.current(SESSION), rounds.nextQuestionNo(SESSION))
    events.length = 0
    watched.withdrawQuestions(SESSION, rounds.current(SESSION), [1], WITHDRAW_NOTE)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "item", item: { id, closedNote: WITHDRAW_NOTE } })
    watched.flush()
  })
})
