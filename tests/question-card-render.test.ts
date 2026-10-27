import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { QuestionCard } from "../src/renderer/components/chat/ItemViews"
import type { AppChatQuestionItem } from "../src/shared/app-chat-types"

const base: AppChatQuestionItem = {
  kind: "question", id: "q1", messageId: "q1", ts: 1, text: "用哪个库？", options: ["A", "B", "C"],
}

const render = (item: Partial<AppChatQuestionItem>) =>
  renderToStaticMarkup(createElement(QuestionCard, { item: { ...base, ...item }, onAnswer: vi.fn() }))

/** 渲染出来被禁用的按钮数 */
const disabledCount = (html: string) => (html.match(/<button[^>]*disabled/g) ?? []).length
const buttonCount = (html: string) => (html.match(/<button/g) ?? []).length

describe("QuestionCard 的几种状态", () => {
  it("还没选：选项都能点，没有提示", () => {
    const html = render({})
    expect(buttonCount(html)).toBe(3)
    expect(disabledCount(html)).toBe(0)
    expect(html).not.toContain("一起发给 Agent")
  })

  it("已选、在等其余问题（held）：选项仍能点（可以改选），并提示还没发给 Agent", () => {
    const html = render({ answered: "B", held: true })
    expect(disabledCount(html)).toBe(0)
    expect(html).toContain("一起发给 Agent")
    // 选中的那个有对勾
    expect(html).toContain("lucide-check")
  })

  it("已交给 Agent（answered 且没有 held）：全部锁定，没有等待提示", () => {
    const html = render({ answered: "B" })
    expect(buttonCount(html)).toBe(3)
    expect(disabledCount(html)).toBe(3)
    expect(html).not.toContain("一起发给 Agent")
  })

  it("旧记录没有 held 字段，等同已交给 Agent", () => {
    expect(disabledCount(render({ answered: "A" }))).toBe(3)
  })

  it("已关闭：锁定并显示关闭原因", () => {
    const html = render({ closedNote: "问题已关闭" })
    expect(disabledCount(html)).toBe(3)
    expect(html).toContain("问题已关闭")
  })

  it("选了、等其余问题的期间被关闭：锁定，且不再提示等待", () => {
    const html = render({ answered: "A", held: true, closedNote: "问题已关闭" })
    expect(disabledCount(html)).toBe(3)
    expect(html).not.toContain("一起发给 Agent")
  })
})
