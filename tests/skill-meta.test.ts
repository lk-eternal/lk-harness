import { describe, expect, it } from "vitest"
import { parseSkillMeta, skillSummary } from "../src/shared/skill-meta"

describe("parseSkillMeta：frontmatter 里的 name / description / 是否不让模型自动用", () => {
  it("取 name 和 description", () => {
    const m = parseSkillMeta("---\nname: weekly-report\ndescription: 写周报\n---\n# 正文\n")
    expect(m).toEqual({ name: "weekly-report", description: "写周报", hidden: false })
  })

  it("没写 name：不给 name 字段（调用方用文件夹名）", () => {
    const m = parseSkillMeta("---\ndescription: 只有说明\n---\n")
    expect("name" in m).toBe(false)
    expect(m.description).toBe("只有说明")
  })

  it("name 写了但是空：和没写一样", () => {
    expect("name" in parseSkillMeta("---\nname:\ndescription: x\n---\n")).toBe(false)
  })

  it("name 和 description 都支持引号、CRLF、BOM", () => {
    const m = parseSkillMeta('\uFEFF---\r\nname: "带引号"\r\ndescription: \'单引号 : 里有冒号\'\r\n---\r\n正文')
    expect(m.name).toBe("带引号")
    expect(m.description).toBe("单引号 : 里有冒号")
  })

  it("description 的 > 和 | 多行写法拼成一行", () => {
    expect(parseSkillMeta("---\nname: a\ndescription: >\n  第一行\n  第二行\nlicense: MIT\n---\n").description).toBe("第一行 第二行")
    expect(parseSkillMeta("---\ndescription: |-\n  行一\n\n  行二\n---\n").description).toBe("行一 行二")
  })

  it("没有 description：退回正文第一行（去掉标题的 #）", () => {
    expect(parseSkillMeta("---\nname: a\n---\n\n# 发周报\n步骤").description).toBe("发周报")
    expect(parseSkillMeta("# 没有 frontmatter\n正文").description).toBe("没有 frontmatter")
  })

  it("什么都没有：空说明，不抛错", () => {
    expect(parseSkillMeta("")).toEqual({ description: "", hidden: false })
    expect(parseSkillMeta("---\n")).toEqual({ description: "", hidden: false })
  })

  describe("disable-model-invocation", () => {
    it.each([
      ["true", true],
      ["True", true],
      ['"true"', true],
      ["yes", true],
      ["false", false],
      ["", false],
      ["maybe", false],
    ])("写成 %s → hidden=%s", (raw, expected) => {
      expect(parseSkillMeta(`---\nname: a\ndisable-model-invocation: ${raw}\n---\n`).hidden).toBe(expected)
    })

    it("没写、或没有 frontmatter：不隐藏", () => {
      expect(parseSkillMeta("---\nname: a\n---\n").hidden).toBe(false)
      expect(parseSkillMeta("disable-model-invocation: true\n正文里写的不算").hidden).toBe(false)
    })

    it("只认顶格的键：缩进的（比如写在别的字段下面）不算", () => {
      expect(parseSkillMeta("---\nmetadata:\n  disable-model-invocation: true\n---\n").hidden).toBe(false)
    })
  })
})

describe("skillSummary 的 max：调用方按场景定长度", () => {
  const long = `---\ndescription: ${"很长".repeat(100)}\n---\n`

  it("默认 160", () => {
    const s = skillSummary(long)
    expect(s.length).toBe(161)
    expect(s.endsWith("…")).toBe(true)
  })

  it("给小一点的上限", () => {
    const s = skillSummary(long, 20)
    expect(s).toBe(`${"很长".repeat(10)}…`)
  })

  it("给大一点的上限就不截断", () => {
    expect(skillSummary(long, 1000)).toBe("很长".repeat(100))
  })

  it("不到上限原样返回，不加省略号", () => {
    expect(skillSummary("---\ndescription: 短\n---\n", 20)).toBe("短")
  })
})
