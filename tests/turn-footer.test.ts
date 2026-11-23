/**
 * 回合页脚的共享规则：飞书流式卡和应用内聊天都靠它决定「显示哪几项、什么顺序、耗时怎么写」。
 * 两端只负责把结果画出来，所以规则只在这里测一遍。
 */
import { describe, expect, it } from "vitest"
import { buildTurnFooter, formatTurnDuration } from "../src/shared/turn-footer.js"

describe("formatTurnDuration：取整秒，满分钟不带 0s", () => {
  it.each([
    [0, "1s"], // 极短的回合也至少 1s，不显示 0s
    [400, "1s"],
    [1_000, "1s"],
    [12_300, "12s"], // 不再带小数
    [59_400, "59s"],
    [60_000, "1m"],
    [129_000, "2m9s"],
    [120_000, "2m"], // 整分钟不写 2m0s
    [3_540_000, "59m"],
    [3_900_000, "1h5m"],
    [3_600_000, "1h"],
    [3 * 3_600_000 + 7_000, "3h"], // 满一小时不再带秒
  ])("%i ms → %s", (ms, text) => {
    expect(formatTurnDuration(ms)).toBe(text)
  })
})

describe("buildTurnFooter：模型 → 状态 → 耗时 → 时间，缺的项直接不出现", () => {
  const TS = 1_700_000_000_000

  it("运行中：模型 · 运行中… · 耗时（还没有完成时间）", () => {
    expect(buildTurnFooter({ modelLabel: "gpt-5.5", status: "running", elapsedMs: 83_000 })).toEqual([
      { kind: "model", text: "gpt-5.5" },
      { kind: "status", status: "running", text: "运行中…" },
      { kind: "elapsed", text: "耗时 1m23s" },
    ])
  })

  it("正常完成：没有状态项，末尾是完成时间", () => {
    expect(buildTurnFooter({ modelLabel: "gpt-5.5", elapsedMs: 129_000, time: TS })).toEqual([
      { kind: "model", text: "gpt-5.5" },
      { kind: "elapsed", text: "耗时 2m9s" },
      { kind: "time", ts: TS },
    ])
  })

  it("已中断：状态项夹在模型和耗时之间，文案没有 Agent 前缀", () => {
    expect(buildTurnFooter({ modelLabel: "gpt-5.5", status: "interrupted", elapsedMs: 129_000, time: TS })).toEqual([
      { kind: "model", text: "gpt-5.5" },
      { kind: "status", status: "interrupted", text: "已中断" },
      { kind: "elapsed", text: "耗时 2m9s" },
      { kind: "time", ts: TS },
    ])
  })

  it("没有模型名（或只有空白）：模型项不出现，其余照常", () => {
    expect(buildTurnFooter({ elapsedMs: 5_000 })).toEqual([{ kind: "elapsed", text: "耗时 5s" }])
    expect(buildTurnFooter({ modelLabel: "   ", elapsedMs: 5_000 })).toEqual([{ kind: "elapsed", text: "耗时 5s" }])
  })

  it("模型名两侧的空白会去掉", () => {
    expect(buildTurnFooter({ modelLabel: "  gpt-5.5 " })).toEqual([{ kind: "model", text: "gpt-5.5" }])
  })

  it("旧记录没有收口时间：不写耗时，时间项交给调用方传（回落到开始时间）", () => {
    expect(buildTurnFooter({ modelLabel: "m", time: TS })).toEqual([
      { kind: "model", text: "m" },
      { kind: "time", ts: TS },
    ])
  })

  it("耗时为 0 是合法的（显示 1s）；负数（时钟回拨）不写耗时", () => {
    expect(buildTurnFooter({ elapsedMs: 0 })).toEqual([{ kind: "elapsed", text: "耗时 1s" }])
    expect(buildTurnFooter({ elapsedMs: -5 })).toEqual([])
  })

  it("什么都没有：空数组", () => {
    expect(buildTurnFooter({})).toEqual([])
  })
})
