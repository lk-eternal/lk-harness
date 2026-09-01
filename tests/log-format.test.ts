import { describe, expect, it } from "vitest"
import { formatLogLineForUi } from "../src/shared/log-format"

describe("formatLogLineForUi", () => {
  it("replaces full sessionKey with resolveLabel", () => {
    const line = "[SDK] ch_e8f4e1be|oc_a9a2d8e20e851b4be59e5afb471804f3::project_90507a7006ce 消息"
    const out = formatLogLineForUi(line, () => "📦 测试项目")
    expect(out).toBe("[SDK] 📦 测试项目 消息")
  })

  it("does not touch worktree paths containing oc_ substring", () => {
    const line = "wt=D:\\workspace\\AI\\测试\\stu-center oc_32cb78537b97c685e29f8a77e8a510cc"
    expect(formatLogLineForUi(line)).toBe(line)
  })

  it("preserves full path in non-sessionKey context", () => {
    const line = "文件 D:\\workspace\\lk-harness\\electron\\daemon-manager.ts"
    expect(formatLogLineForUi(line)).toBe(line)
  })

  it("replaces sessionKey with workspace path suffix", () => {
    const sk = "ch_c0130dd0|oc_32cb78537b97c685e29f8a77e8a510cc::D:\\workspace\\lk-harness"
    const line = `[Agent] 会话 ${sk} 启动`
    const out = formatLogLineForUi(line, () => "📂 lk-harness")
    expect(out).toBe("[Agent] 会话 📂 lk-harness 启动")
  })

  it("replaces bracketed scheduled task session id", () => {
    const id = "f7ad9795-a2ac-42a3-beda-0bbcfd4a24f5"
    const line = `[SDK] [${id}] Agent 执行中`
    const out = formatLogLineForUi(line, (sk) => (sk === id ? "⏰ 定时任务" : undefined))
    expect(out).toBe("[SDK] [⏰ 定时任务] Agent 执行中")
  })

  it("preserves notify_session_key inside Prompt dump", () => {
    const id = "e126c5ba-ce6f-4558-8096-9ca5c07e6ea0"
    const notify = "ch_c9fc9ff4|oc_be3ec98dda1e4f0d172474e6c19d98b"
    const line = `[SDK] INFO [${id}] 启动 Prompt:\n[notify_session_key=${notify}]\n禁止调用send_text`
    const out = formatLogLineForUi(line, (sk) => (sk === id ? "⏰ 定时" : undefined))
    expect(out).toContain(`[notify_session_key=${notify}]`)
    expect(out).toContain("禁止调用send_text")
    expect(out).toMatch(/\[⏰ 定时\] 启动 Prompt:/)
  })
})
