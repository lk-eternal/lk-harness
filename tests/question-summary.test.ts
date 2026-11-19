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
})
