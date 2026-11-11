import { describe, expect, it } from "vitest"
import { MULTI_ANSWER_SEP, checkerFieldName, joinChoices, readFormChoices, splitChoices, toggleChoice } from "../src/shared/question-multi"

const OPTIONS = ["SUB_CHILD", "SUB_TEEN", "SUB_ADULT", "SUB_ALL"]

describe("toggleChoice 勾选 / 取消勾选", () => {
  it("勾上一项；再点一次取消", () => {
    const one = toggleChoice(OPTIONS, [], "SUB_TEEN")
    expect(one).toEqual(["SUB_TEEN"])
    expect(toggleChoice(OPTIONS, one, "SUB_TEEN")).toEqual([])
  })

  it("结果始终按题目里的顺序排，和点击先后无关", () => {
    let sel: string[] = []
    sel = toggleChoice(OPTIONS, sel, "SUB_ALL")
    sel = toggleChoice(OPTIONS, sel, "SUB_CHILD")
    sel = toggleChoice(OPTIONS, sel, "SUB_ADULT")
    expect(sel).toEqual(["SUB_CHILD", "SUB_ADULT", "SUB_ALL"])
  })

  it("不是选项的内容不会被勾上；原来的勾选保持", () => {
    expect(toggleChoice(OPTIONS, ["SUB_TEEN"], "不存在")).toEqual(["SUB_TEEN"])
    expect(toggleChoice(OPTIONS, undefined, "不存在")).toEqual([])
  })

  it("不改传进来的数组", () => {
    const sel = ["SUB_CHILD"]
    toggleChoice(OPTIONS, sel, "SUB_TEEN")
    expect(sel).toEqual(["SUB_CHILD"])
  })
})

describe("joinChoices 拼成答案", () => {
  it("按题目顺序用「、」连起来", () => {
    expect(MULTI_ANSWER_SEP).toBe("、")
    expect(joinChoices(OPTIONS, ["SUB_ALL", "SUB_CHILD"])).toBe("SUB_CHILD、SUB_ALL")
  })

  it("只勾一项就是这个选项本身；一项没勾是空串", () => {
    expect(joinChoices(OPTIONS, ["SUB_TEEN"])).toBe("SUB_TEEN")
    expect(joinChoices(OPTIONS, [])).toBe("")
    expect(joinChoices(OPTIONS, undefined)).toBe("")
  })

  it("忽略不在选项里的内容", () => {
    expect(joinChoices(OPTIONS, ["乱入", "SUB_TEEN"])).toBe("SUB_TEEN")
  })
})

describe("splitChoices 从答案还原勾选", () => {
  it("和 joinChoices 互为反过程", () => {
    for (const sel of [[], ["SUB_CHILD"], ["SUB_TEEN", "SUB_ALL"], [...OPTIONS]]) {
      expect(splitChoices(joinChoices(OPTIONS, sel), OPTIONS)).toEqual(sel)
    }
  })

  it("没有答案 / 答案认不出来：什么也不勾", () => {
    expect(splitChoices(undefined, OPTIONS)).toEqual([])
    expect(splitChoices("", OPTIONS)).toEqual([])
    expect(splitChoices("完全不相干", OPTIONS)).toEqual([])
  })

  it("选项文本里带逗号也不会被拆错", () => {
    const options = ["红色, 偏深", "蓝色", "绿色"]
    const answer = joinChoices(options, ["红色, 偏深", "绿色"])
    expect(answer).toBe("红色, 偏深、绿色")
    expect(splitChoices(answer, options)).toEqual(["红色, 偏深", "绿色"])
  })

  it("一个选项是另一个的前缀也分得清（只有后面紧跟分隔符或结束才算选中）", () => {
    const options = ["A", "AB", "C"]
    expect(splitChoices("AB、C", options)).toEqual(["AB", "C"])
    expect(splitChoices("A、C", options)).toEqual(["A", "C"])
    expect(splitChoices("AB", options)).toEqual(["AB"])
  })
})

describe("checkerFieldName 勾选框 name", () => {
  it("前缀 + 序号；同一前缀下各选项不重名，不同前缀（同卡里的不同题）互不重名", () => {
    expect(checkerFieldName("q_ab12", 0)).toBe("q_ab12_0")
    const names = ["q_a", "q_b"].flatMap((p) => OPTIONS.map((_, i) => checkerFieldName(p, i)))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("readFormChoices 从飞书表单提交值读勾选", () => {
  const P = "q_ab12"
  const form = (checked: Record<number, unknown>) =>
    Object.fromEntries(OPTIONS.map((_, i) => [checkerFieldName(P, i), checked[i] ?? false]))

  it("勾上的项按题目顺序返回（布尔 true）", () => {
    expect(readFormChoices(OPTIONS, form({ 3: true, 0: true }), P)).toEqual(["SUB_CHILD", "SUB_ALL"])
  })

  it("字符串 \"true\" 也算勾上（飞书可能把布尔转成字符串回传）；\"false\"、空串、其它都不算", () => {
    expect(readFormChoices(OPTIONS, form({ 1: "true", 2: " TRUE ", 0: "false", 3: "" }), P)).toEqual(["SUB_TEEN", "SUB_ADULT"])
    expect(readFormChoices(OPTIONS, form({ 0: "yes", 1: 1, 2: ["true"] }), P)).toEqual([])
  })

  it("一项没勾：返回空数组（字段都在，只是都是 false）", () => {
    expect(readFormChoices(OPTIONS, form({}), P)).toEqual([])
  })

  it("表单里一个本题的勾选框字段都没有：返回 null，和「一项没勾」区分开", () => {
    expect(readFormChoices(OPTIONS, undefined, P)).toBeNull()
    expect(readFormChoices(OPTIONS, {}, P)).toBeNull()
    expect(readFormChoices(OPTIONS, { custom_input: "A" }, P)).toBeNull()
  })

  it("只认自己前缀的字段：同卡里别的题的勾选不会算到这道题头上", () => {
    const other = Object.fromEntries(OPTIONS.map((_, i) => [checkerFieldName("q_other", i), true]))
    expect(readFormChoices(OPTIONS, other, P)).toBeNull()
    expect(readFormChoices(OPTIONS, { ...other, ...form({ 2: true }) }, P)).toEqual(["SUB_ADULT"])
  })
})
