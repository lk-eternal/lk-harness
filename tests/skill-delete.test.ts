import { describe, expect, it } from "vitest"
import { skillDeleteConfirm } from "../src/renderer/components/skill/skill-delete"

describe("skillDeleteConfirm：删除 Skill 前的确认文案", () => {
  it("普通文件夹：说明整个文件夹（含脚本资料）都会删、不能恢复", () => {
    const { title, message } = skillDeleteConfirm("weekly-report", null)
    expect(title).toBe("删除 Skill")
    expect(message).toContain("「weekly-report」")
    expect(message).toContain("整个文件夹")
    expect(message).toContain("不能恢复")
    expect(message).not.toContain("链接")
  })

  it("链接：说明只删链接、原文件夹不动，并写出指向哪里", () => {
    const { message } = skillDeleteConfirm("ask-matt", "C:\\Users\\me\\.agents\\skills\\ask-matt")
    expect(message).toContain("是一个链接")
    expect(message).toContain("C:\\Users\\me\\.agents\\skills\\ask-matt")
    expect(message).toContain("只会删掉这个链接")
    expect(message).toContain("不会动")
    // 不能再说「整个文件夹都会删掉」，那是普通文件夹的说法
    expect(message).not.toContain("不能恢复")
    expect(message).not.toContain("整个文件夹")
  })

  it("悬空链接（指向的位置已经没了）：照样说清楚是链接，不写空路径", () => {
    const { message } = skillDeleteConfirm("old", "")
    expect(message).toContain("是一个链接")
    expect(message).toContain("已经不存在")
    expect(message).not.toContain("指向「」")
    expect(message).toContain("只会删掉这个链接")
  })
})
