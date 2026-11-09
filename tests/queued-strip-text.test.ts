import { describe, expect, it } from "vitest"
import { HANDOFF_HINT_MAX_MS, phaseAfterSend, queuedHeaderText, sendNowOutcome } from "../src/renderer/components/chat/queued-strip-text"

describe("sendNowOutcome：主进程返回 → 界面该怎么提示", () => {
  it("soft：已打断，Agent 没重启", () => {
    expect(sendNowOutcome({ ok: true, via: "soft" })).toBe("soft")
  })

  it.each(["launching", "relaunch", "hard"] as const)("%s：Agent 要（重新）启动", (via) => {
    expect(sendNowOutcome({ ok: true, via })).toBe("starting")
  })

  it("没发出去（没有排队中的消息等）：不显示交接提示", () => {
    expect(sendNowOutcome({ ok: false })).toBe("none")
    expect(sendNowOutcome({ ok: false, via: "soft" })).toBe("none")
  })

  it("发出去了但返回里没有 via：不瞎猜", () => {
    expect(sendNowOutcome({ ok: true })).toBe("none")
  })
})

describe("queuedHeaderText", () => {
  it("平时的提示保持原样", () => {
    expect(queuedHeaderText(3, null)).toBe("排队中 · 3 条，Agent 完成当前回合后自动发出")
  })

  it("三个交接阶段各有各的说法，都带条数", () => {
    expect(queuedHeaderText(2, "interrupting")).toBe("正在打断当前回合… · 2 条")
    expect(queuedHeaderText(2, "soft")).toBe("已打断，Agent 马上处理 · 2 条")
    expect(queuedHeaderText(2, "starting")).toBe("Agent 正在启动，启动后马上处理 · 2 条")
  })

  it("交接阶段不再说「完成当前回合后自动发出」（已经不是在等回合结束了）", () => {
    for (const p of ["interrupting", "soft", "starting"] as const) {
      expect(queuedHeaderText(1, p)).not.toContain("完成当前回合")
    }
  })
})

describe("phaseAfterSend", () => {
  it("soft/starting 进入对应提示，none 回到平时的提示", () => {
    expect(phaseAfterSend("soft")).toBe("soft")
    expect(phaseAfterSend("starting")).toBe("starting")
    expect(phaseAfterSend("none")).toBeNull()
  })

  it("提示有上限，避免 Agent 一直起不来时永远挂着「正在启动」", () => {
    expect(HANDOFF_HINT_MAX_MS).toBe(30_000)
  })
})
