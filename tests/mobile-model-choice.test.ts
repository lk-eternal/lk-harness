import { describe, expect, it } from "vitest"
import {
  choiceForListed,
  choiceForQuick,
  currentModelLabel,
  isCurrentListed,
  isCurrentQuick,
  listedRowKey,
  resolveProviderId,
} from "../src/mobile/model-choice"

// 同一个模型在供应商那里有好几档推理参数，每一档是单独的一行（id 相同、params 不同）
const HIGH = JSON.stringify([{ id: "effort", value: "high" }])
const XHIGH = JSON.stringify([{ id: "effort", value: "xhigh" }])
const MODEL = "claude-sonnet-5-5-300k"

describe("常用卡片是不是当前值", () => {
  const cur = { model: MODEL, params: HIGH, resourceId: "r1" }

  it("同一个模型的两档，只有参数一样的那张算当前（原来两张都打勾）", () => {
    expect(isCurrentQuick({ model: MODEL, modelParams: HIGH, resourceId: "r1" }, cur)).toBe(true)
    expect(isCurrentQuick({ model: MODEL, modelParams: XHIGH, resourceId: "r1" }, cur)).toBe(false)
  })

  it("不带参数的卡片和带参数的当前值不是一回事，反过来也一样", () => {
    expect(isCurrentQuick({ model: MODEL, resourceId: "r1" }, cur)).toBe(false)
    expect(isCurrentQuick({ model: MODEL, modelParams: HIGH, resourceId: "r1" }, { model: MODEL, resourceId: "r1" })).toBe(false)
  })

  it("undefined、空串、两端空白都算「没有参数」", () => {
    const bare = { model: MODEL, resourceId: "r1" }
    expect(isCurrentQuick({ model: MODEL, modelParams: "", resourceId: "r1" }, bare)).toBe(true)
    expect(isCurrentQuick({ model: MODEL, modelParams: undefined, resourceId: "r1" }, { ...bare, params: "" })).toBe(true)
    expect(isCurrentQuick({ model: MODEL, modelParams: ` ${HIGH} `, resourceId: "r1" }, cur)).toBe(true)
  })

  it("模型名不同不算；供应商不同不算；老条目没绑供应商的不看供应商", () => {
    expect(isCurrentQuick({ model: "other", modelParams: HIGH, resourceId: "r1" }, cur)).toBe(false)
    expect(isCurrentQuick({ model: MODEL, modelParams: HIGH, resourceId: "r2" }, cur)).toBe(false)
    expect(isCurrentQuick({ model: MODEL, modelParams: HIGH }, cur)).toBe(true)
  })

  it("当前还没有模型（默认 / 没选）：没有卡片算当前", () => {
    expect(isCurrentQuick({ model: MODEL, resourceId: "r1" }, {})).toBe(false)
    expect(isCurrentQuick({ model: "", resourceId: "r1" }, { model: "" })).toBe(false)
  })
})

describe("供应商模型列表里的一行是不是当前值", () => {
  const cur = { model: MODEL, params: HIGH }

  it("同 id 的几档只有参数一样的那行算当前（原来 id 相同就全打勾）", () => {
    const rows = [
      { id: MODEL, label: `${MODEL}-high`, params: HIGH },
      { id: MODEL, label: `${MODEL}-xhigh`, params: XHIGH },
      { id: MODEL, label: MODEL, params: "" },
    ]
    expect(rows.map((r) => isCurrentListed(r, cur))).toEqual([true, false, false])
  })

  it("没有 params 字段的供应商（LLM 类）按没有参数算", () => {
    expect(isCurrentListed({ id: "gpt-x" }, { model: "gpt-x" })).toBe(true)
    expect(isCurrentListed({ id: "gpt-x" }, { model: "gpt-x", params: HIGH })).toBe(false)
    expect(isCurrentListed({ id: "gpt-y" }, { model: "gpt-x" })).toBe(false)
  })

  it("当前没有模型：没有行算当前", () => {
    expect(isCurrentListed({ id: MODEL, params: "" }, {})).toBe(false)
  })
})

describe("点一下得到的选择", () => {
  it("点列表里的一行要带上推理参数（原来丢了，选中的是不带参数的默认档）", () => {
    expect(choiceForListed({ id: MODEL, label: "x", params: XHIGH }, "r1")).toEqual({ model: MODEL, modelParams: XHIGH, resourceId: "r1" })
  })

  it("没有参数的行不带 modelParams 字段", () => {
    const a = choiceForListed({ id: "gpt-x", params: "" }, "r1")
    const b = choiceForListed({ id: "gpt-x" }, "r1")
    expect(a).toEqual({ model: "gpt-x", resourceId: "r1" })
    expect(b).toEqual({ model: "gpt-x", resourceId: "r1" })
    expect("modelParams" in a).toBe(false)
  })

  it("点常用卡片：模型、参数、供应商原样", () => {
    expect(choiceForQuick({ model: MODEL, modelParams: HIGH, label: "x", resourceId: "r1" })).toEqual({ model: MODEL, modelParams: HIGH, resourceId: "r1" })
  })
})

describe("列表行的 key", () => {
  it("同 id 的几档 key 不重复", () => {
    const keys = [
      listedRowKey({ id: MODEL, params: HIGH }),
      listedRowKey({ id: MODEL, params: XHIGH }),
      listedRowKey({ id: MODEL, params: "" }),
      listedRowKey({ id: MODEL }),
    ]
    // 空串和没有 params 是同一档，所以只有 3 个不同
    expect(new Set(keys).size).toBe(3)
    expect(keys[2]).toBe(keys[3])
  })
})

describe("顶栏上的模型名", () => {
  const quick = [
    { model: MODEL, modelParams: HIGH, label: "Sonnet 高" },
    { model: MODEL, modelParams: XHIGH, label: "Sonnet 超高" },
  ]

  it("取同模型同参数那一项的名字，不是同模型的第一项", () => {
    expect(currentModelLabel(MODEL, XHIGH, quick)).toBe("Sonnet 超高")
    expect(currentModelLabel(MODEL, HIGH, quick)).toBe("Sonnet 高")
  })

  it("常用里没有这一档：按模型加参数拼，带上档位，不是光秃秃的模型 id", () => {
    expect(currentModelLabel(MODEL, JSON.stringify([{ id: "effort", value: "low" }]), quick)).toBe(`${MODEL}-low`)
    expect(currentModelLabel(MODEL, undefined, quick)).toBe(MODEL)
  })

  it("没选模型 / auto 显示「默认模型」", () => {
    expect(currentModelLabel(undefined, undefined, quick)).toBe("默认模型")
    expect(currentModelLabel("auto", undefined, quick)).toBe("默认模型")
    expect(currentModelLabel("", undefined, quick)).toBe("默认模型")
  })
})

describe("抽屉里选中的供应商", () => {
  const rs = [{ id: "a" }, { id: "b" }, { id: "c" }]

  it("用户选的那家还在列表里就保持：每 10 秒的刷新会换一个新数组，不能把人拉回当前供应商", () => {
    expect(resolveProviderId("b", rs, "a")).toBe("b")
    // 同样的内容、换了一个数组，结果不变
    expect(resolveProviderId("b", rs.map((r) => ({ ...r })), "a")).toBe("b")
  })

  it("还没选过：用会话当前的供应商", () => {
    expect(resolveProviderId("", rs, "c")).toBe("c")
  })

  it("没选过、会话也没记供应商：第一家", () => {
    expect(resolveProviderId("", rs, undefined)).toBe("a")
    expect(resolveProviderId("", rs, "")).toBe("a")
  })

  it("选的那家已经被删了：回落到会话当前的，再回落到第一家", () => {
    expect(resolveProviderId("gone", rs, "c")).toBe("c")
    expect(resolveProviderId("gone", rs, "also-gone")).toBe("a")
  })

  it("一家都没有：空串（不去拉列表）", () => {
    expect(resolveProviderId("a", [], "a")).toBe("")
  })
})
