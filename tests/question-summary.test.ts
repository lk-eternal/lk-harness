import { describe, expect, it } from "vitest"
import { formatQuestionBatchSummary } from "../src/shared/question-summary"

describe("formatQuestionBatchSummary", () => {
  it("按顺序编号，题干和答案放在一起", () => {
    expect(formatQuestionBatchSummary([
      { text: "用哪个库？", answered: "A" },
      { text: "要不要加测试？", answered: "要" },
    ])).toBe("问题 1：用哪个库？\n回答：A\n\n问题 2：要不要加测试？\n回答：要")
  })

  it("没有答案的条目不进汇总，编号保持连续", () => {
    expect(formatQuestionBatchSummary([
      { text: "第一题", answered: "是" },
      { text: "没选的" },
      { text: "第三题", answered: "否" },
    ])).toBe("问题 1：第一题\n回答：是\n\n问题 2：第三题\n回答：否")
  })

  it("题干两端的空白去掉", () => {
    expect(formatQuestionBatchSummary([{ text: "  \n用哪个库？\n ", answered: "A" }])).toBe("问题 1：用哪个库？\n回答：A")
  })

  it("一个答案都没有时返回空串", () => {
    expect(formatQuestionBatchSummary([])).toBe("")
    expect(formatQuestionBatchSummary([{ text: "没选的" }])).toBe("")
  })

  it("关掉的题标成未作答，按条目顺序和答案一起编号", () => {
    expect(formatQuestionBatchSummary([
      { text: "第一题", answered: "保留" },
      { text: "第二题", closed: true },
      { text: "第三题", answered: "可以" },
    ])).toBe("问题 1：第一题\n回答：保留\n\n问题 2：第二题\n[未作答, 问题已关闭]\n\n问题 3：第三题\n回答：可以")
  })

  it("关掉的题只带标题：取第一个非空行，去掉 markdown 标记，超过 30 字截断", () => {
    expect(formatQuestionBatchSummary([{ text: "\n  **P-008 评审**\n\n正文很长……", closed: true }]))
      .toBe("问题 1：P-008 评审\n[未作答, 问题已关闭]")
    expect(formatQuestionBatchSummary([{ text: "## `一二三四五六七八九十` 一二三四五六七八九十一二三四五六七八九十一二", closed: true }]))
      .toBe("问题 1：一二三四五六七八九十 一二三四五六七八九十一二三四五六七八九…\n[未作答, 问题已关闭]")
  })

  it("已有答案的条目不看 closed：照常带整段题干和回答", () => {
    expect(formatQuestionBatchSummary([{ text: "第一行\n第二行", answered: "A", closed: true }])).toBe("问题 1：第一行\n第二行\n回答：A")
  })
})
