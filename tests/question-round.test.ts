import { describe, expect, it } from "vitest"
import { QuestionRounds } from "../src/shared/question-round"

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
