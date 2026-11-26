import { describe, expect, it } from "vitest"
import { QuestionRounds, mayAnswerQuestion } from "../src/shared/question-round"

const SESSION = "ch_a|oc_1::D:\\ws\\a"

describe("QuestionRounds", () => {
  it("同一轮里发的题拿到同一个编号；这一轮没结束之前题目都算没结束", () => {
    const rounds = new QuestionRounds()
    const first = rounds.current(SESSION)
    expect(rounds.current(SESSION)).toBe(first)
    expect(rounds.isEnded(SESSION, first)).toBe(false)
  })

  it("一轮结束后，这一轮的题算已结束；之后再发的题是新的一轮，两轮互不影响", () => {
    const rounds = new QuestionRounds()
    const first = rounds.current(SESSION)
    rounds.end(SESSION)
    expect(rounds.isEnded(SESSION, first)).toBe(true)

    const second = rounds.current(SESSION)
    expect(second).not.toBe(first)
    expect(rounds.isEnded(SESSION, second)).toBe(false)
    expect(rounds.isEnded(SESSION, first)).toBe(true)
  })

  it("没记轮次的题（旧版本存下的）、编号对不上的题（重启后）都算已结束", () => {
    const rounds = new QuestionRounds()
    expect(rounds.isEnded(SESSION, undefined)).toBe(true)
    rounds.current(SESSION)
    expect(rounds.isEnded(SESSION, undefined)).toBe(true)
    expect(rounds.isEnded(SESSION, "上次运行留下的编号")).toBe(true)
  })

  it("会话互不影响", () => {
    const rounds = new QuestionRounds()
    const a = rounds.current(SESSION)
    const b = rounds.current("ch_a|oc_2::D:\\ws\\b")
    rounds.end(SESSION)
    expect(rounds.isEnded(SESSION, a)).toBe(true)
    expect(rounds.isEnded("ch_a|oc_2::D:\\ws\\b", b)).toBe(false)
  })

  it("盘符路径里重复的反斜杠不会让同一个会话分成两份", () => {
    const rounds = new QuestionRounds()
    const id = rounds.current("ch_a|oc_1::D:\\\\ws\\\\a")
    expect(rounds.isEnded(SESSION, id)).toBe(false)
    rounds.end(SESSION)
    expect(rounds.isEnded("ch_a|oc_1::D:\\\\ws\\\\a", id)).toBe(true)
  })

  it("没有进行中的一轮时结束一轮：什么也不发生", () => {
    const rounds = new QuestionRounds()
    expect(() => rounds.end(SESSION)).not.toThrow()
  })
})

describe("QuestionRounds 题号", () => {
  it("同一轮里从 1 起依次编号", () => {
    const rounds = new QuestionRounds()
    expect([rounds.nextQuestionNo(SESSION), rounds.nextQuestionNo(SESSION), rounds.nextQuestionNo(SESSION)]).toEqual([1, 2, 3])
  })

  it("一轮结束后重新从 1 起；会话互不影响", () => {
    const rounds = new QuestionRounds()
    rounds.nextQuestionNo(SESSION)
    rounds.nextQuestionNo(SESSION)
    expect(rounds.nextQuestionNo("ch_a|oc_2::D:\\ws\\b")).toBe(1)
    rounds.end(SESSION)
    expect(rounds.nextQuestionNo(SESSION)).toBe(1)
  })

  it("取题号会开这一轮：之后发的题拿到的轮次编号和它一致", () => {
    const rounds = new QuestionRounds()
    rounds.nextQuestionNo(SESSION)
    expect(rounds.isEnded(SESSION, rounds.current(SESSION))).toBe(false)
  })

  it("盘符路径里重复的反斜杠不会让同一个会话的题号分成两份", () => {
    const rounds = new QuestionRounds()
    rounds.nextQuestionNo("ch_a|oc_1::D:\\\\ws\\\\a")
    expect(rounds.nextQuestionNo(SESSION)).toBe(2)
  })
})

describe("QuestionRounds 这一轮问的题归谁", () => {
  it("领到一批消息记下发言人，发题时取出来；换了一批就换人", () => {
    const rounds = new QuestionRounds()
    expect(rounds.owner(SESSION)).toBeUndefined()
    rounds.setOwner(SESSION, "ou_a")
    expect(rounds.owner(SESSION)).toBe("ou_a")
    rounds.setOwner(SESSION, "ou_b")
    expect(rounds.owner(SESSION)).toBe("ou_b")
  })

  it("整批都没有发言人（系统消息、定时任务）：清掉上一批的发言人，不会沿用", () => {
    const rounds = new QuestionRounds()
    rounds.setOwner(SESSION, "ou_a")
    rounds.setOwner(SESSION, undefined)
    expect(rounds.owner(SESSION)).toBeUndefined()
  })

  it("会话互不影响；盘符路径里重复的反斜杠不会让同一个会话分成两份", () => {
    const rounds = new QuestionRounds()
    rounds.setOwner("ch_a|oc_1::D:\\\\ws\\\\a", "ou_a")
    expect(rounds.owner(SESSION)).toBe("ou_a")
    expect(rounds.owner("ch_a|oc_2::D:\\ws\\b")).toBeUndefined()
  })

  it("一轮结束不清发言人：下一批领到消息时才换", () => {
    const rounds = new QuestionRounds()
    rounds.setOwner(SESSION, "ou_a")
    rounds.end(SESSION)
    expect(rounds.owner(SESSION)).toBe("ou_a")
  })
})

describe("mayAnswerQuestion", () => {
  it("归属人本人能答，别人不能", () => {
    expect(mayAnswerQuestion("ou_a", "ou_a", false)).toBe(true)
    expect(mayAnswerQuestion("ou_a", "ou_b", false)).toBe(false)
  })

  it("管理员能替任何人的题作答", () => {
    expect(mayAnswerQuestion("ou_a", "ou_admin", true)).toBe(true)
  })

  it("没有归属人的题谁都能答", () => {
    expect(mayAnswerQuestion(undefined, "ou_b", false)).toBe(true)
  })

  it("认不出是谁（回调没带点击人）不拦", () => {
    expect(mayAnswerQuestion("ou_a", undefined, false)).toBe(true)
  })
})
