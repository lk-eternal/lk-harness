import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AppChat } from "../src/app-channel"
import type { AppChatQuestionItem } from "../src/shared/app-chat-types"
import { joinChoices } from "../src/shared/question-multi"

const SESSION = "app_ch|app::D:\\ws\\multi"
const OPTIONS = ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"]

let dir: string
let chat: AppChat

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-question-multi-"))
  chat = new AppChat(dir, () => {})
})

afterEach(() => {
  chat.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

const question = (id: string) => chat.list(SESSION).find((i) => i.id === id) as AppChatQuestionItem

describe("应用内多选题", () => {
  it("multi=true 发出的问题带 multi 标记；默认（单选）没有这个字段", () => {
    const multi = chat.addQuestion(SESSION, "给哪些人开？", OPTIONS, true)
    const single = chat.addQuestion(SESSION, "要不要继续？", ["是", "否"])
    expect(question(multi).multi).toBe(true)
    expect("multi" in question(single)).toBe(false)
  })

  it("多选的答案是勾选项连成的一条：只有这一个问题时原样交给 Agent", () => {
    const q = chat.addQuestion(SESSION, "给哪些人开？", OPTIONS, true)
    const answer = joinChoices(OPTIONS, ["SUB_ADULT", "SUB_CHILD"])
    expect(answer).toBe("SUB_CHILD、SUB_ADULT")
    expect(chat.answerQuestion(SESSION, q, answer)).toEqual({ ok: true, deliver: "SUB_CHILD、SUB_ADULT" })
    expect(question(q)).toMatchObject({ multi: true, answered: "SUB_CHILD、SUB_ADULT" })
    expect(question(q).held).toBeUndefined()
  })

  it("一项都没勾不算作答：问题仍然开着", () => {
    const q = chat.addQuestion(SESSION, "给哪些人开？", OPTIONS, true)
    expect(chat.answerQuestion(SESSION, q, "")).toEqual({ ok: false })
    expect(chat.answerQuestion(SESSION, q, "  ")).toEqual({ ok: false })
    expect(question(q).answered).toBeUndefined()
  })

  it("和别的问题同一轮：先记下（held）、可以改勾后重新提交，全答完才交出汇总", () => {
    const multi = chat.addQuestion(SESSION, "给哪些人开？", OPTIONS, true)
    const single = chat.addQuestion(SESSION, "要不要加测试？", ["要", "不要"])

    expect(chat.answerQuestion(SESSION, multi, "SUB_CHILD")).toEqual({ ok: true })
    expect(question(multi)).toMatchObject({ answered: "SUB_CHILD", held: true })
    // 改勾后重新提交
    expect(chat.answerQuestion(SESSION, multi, "SUB_CHILD、SUB_ALL")).toEqual({ ok: true })
    expect(question(multi)).toMatchObject({ answered: "SUB_CHILD、SUB_ALL", held: true })

    expect(chat.answerQuestion(SESSION, single, "要")).toEqual({
      ok: true,
      deliver: "【点选汇总】\n1. 给哪些人开？ → SUB_CHILD、SUB_ALL\n2. 要不要加测试？ → 要",
    })
    expect(question(multi).held).toBeUndefined()
  })

  it("交出之后不能再改", () => {
    const q = chat.addQuestion(SESSION, "给哪些人开？", OPTIONS, true)
    chat.answerQuestion(SESSION, q, "SUB_TEEN")
    expect(chat.answerQuestion(SESSION, q, "SUB_ALL")).toEqual({ ok: false })
    expect(question(q).answered).toBe("SUB_TEEN")
  })

  it("multi 标记会随历史落盘、重开后还在", () => {
    const q = chat.addQuestion(SESSION, "给哪些人开？", OPTIONS, true)
    chat.flush()
    const reopened = new AppChat(dir, () => {})
    const hit = reopened.list(SESSION).find((i) => i.id === q) as AppChatQuestionItem
    expect(hit.multi).toBe(true)
  })
})
