import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  httpPost: vi.fn(),
  readLockFile: vi.fn(),
  resolveChannelForSession: vi.fn(),
  broadcastLog: vi.fn(),
}))

vi.mock("electron", () => ({ app: { getPath: () => "" } }))
vi.mock("../electron/daemon-client", () => ({ readLockFile: h.readLockFile, httpPost: h.httpPost }))
vi.mock("../electron/config-store", () => ({ resolveChannelForSession: h.resolveChannelForSession }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: h.broadcastLog }))

import { clearAllFailureNotices, clearFailureNotices, reportAgentFailure } from "../electron/agent-failure-notice"

const MAIN_CHAT = "ch_a|oc_main::D:/ws"
const VISITOR_CHAT = "ch_a|oc_visitor::D:/ws"
const feishuChannel = { id: "ch_a", type: "feishu", mainUserEnabled: true, mainUserChatId: "oc_main" }
const appChannel = { id: "ch_app", type: "app", mainUserEnabled: false, mainUserChatId: "" }

function sentBodies(): Array<{ text: string; message_id?: string; session_key?: string }> {
  return h.httpPost.mock.calls.map((c) => c[1] as { text: string; message_id?: string; session_key?: string })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"))
  clearAllFailureNotices()
  h.httpPost.mockReset()
  h.httpPost.mockResolvedValue({ ok: true })
  h.readLockFile.mockReset()
  h.readLockFile.mockReturnValue({ pid: 1, port: 7777, version: "test" })
  h.resolveChannelForSession.mockReset()
  h.resolveChannelForSession.mockReturnValue(feishuChannel)
  h.broadcastLog.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("reportAgentFailure：把失败告诉用户", () => {
  it("作为对出事那条消息的独立回复发出：只带 message_id，不带 session_key（不并进会话的流式卡）", async () => {
    await reportAgentFailure(MAIN_CHAT, { kind: "auth", retry: "auto", replyToMessageId: "om_1" })

    expect(h.httpPost).toHaveBeenCalledTimes(1)
    expect(h.httpPost.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/send-text")
    const body = sentBodies()[0]
    expect(body.message_id).toBe("om_1")
    expect(body).not.toHaveProperty("session_key")
    expect(body.text).toContain("API Key 无效")
  })

  it("没有消息在处理就没有失败可报：什么都不发", async () => {
    await reportAgentFailure(MAIN_CHAT, { kind: "auth", retry: "auto" })
    expect(h.httpPost).not.toHaveBeenCalled()
  })

  it("别人的会话：只收到通用提示，看不到原因和原始报错", async () => {
    await reportAgentFailure(VISITOR_CHAT, { kind: "other", retry: "auto", detail: "internal detail", replyToMessageId: "om_9" })

    const { text } = sentBodies()[0]
    expect(text).toBe("⚠️ 这条消息暂时没能处理，系统会自动重试，请稍候。")
  })

  it("应用内通道没有「别人」：按主用户处理", async () => {
    h.resolveChannelForSession.mockReturnValue(appChannel)
    await reportAgentFailure("ch_app|app_main::D:/ws", { kind: "network", retry: "auto", replyToMessageId: "om_2" })

    expect(sentBodies()[0].text).toContain("连不上模型服务")
  })

  it("查不到通道的会话（定时任务、临时会话）：按主用户处理", async () => {
    h.resolveChannelForSession.mockReturnValue(undefined)
    await reportAgentFailure("task_1", { kind: "quota", retry: "auto", replyToMessageId: "internal_1" })

    expect(sentBodies()[0].text).toContain("额度")
  })
})

describe("自动重试的失败：同一会话同一类原因 10 分钟最多提示一次", () => {
  const report = (kind: "auth" | "quota", sessionKey = MAIN_CHAT) =>
    reportAgentFailure(sessionKey, { kind, retry: "auto", replyToMessageId: "om_1" })

  it("10 分钟内重复的原因不再提示，到点后再提示", async () => {
    await report("auth")
    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(2)
  })

  it("换了一类原因要提示", async () => {
    await report("auth")
    await report("quota")
    expect(h.httpPost).toHaveBeenCalledTimes(2)
  })

  it("不同会话互不影响", async () => {
    await report("auth")
    await report("auth", "ch_a|oc_other::D:/ws")
    expect(h.httpPost).toHaveBeenCalledTimes(2)
  })

  it("会话恢复（清掉失败记录）后，下一次失败重新提示", async () => {
    await report("auth")
    clearFailureNotices(MAIN_CHAT)
    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(2)
  })

  it("提示没发出去不占名额：下一次失败还会再试", async () => {
    h.httpPost.mockRejectedValueOnce(new Error("HTTP 500"))
    await report("auth")
    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(2)
    expect(h.broadcastLog).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"), "WARN")
  })

  it("daemon 没在运行：记日志、不抛错、不占名额", async () => {
    h.readLockFile.mockReturnValueOnce(null)
    await expect(report("auth")).resolves.toBeUndefined()
    expect(h.httpPost).not.toHaveBeenCalled()
    expect(h.broadcastLog).toHaveBeenCalledWith(expect.stringContaining("Daemon 未运行"), "WARN")

    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(1)
  })

  it("daemon 返回发送失败：同样记日志、不占名额", async () => {
    h.httpPost.mockResolvedValueOnce({ ok: false, error: "通道解析失败" })
    await report("auth")
    expect(h.broadcastLog).toHaveBeenCalledWith(expect.stringContaining("通道解析失败"), "WARN")

    await report("auth")
    expect(h.httpPost).toHaveBeenCalledTimes(2)
  })
})

describe("需要重发的失败：用户的每一条消息都要得到回应", () => {
  it("不限频，并说明这条消息不会自动重试", async () => {
    await reportAgentFailure(MAIN_CHAT, { kind: "quota", retry: "resend", replyToMessageId: "om_1" })
    await reportAgentFailure(MAIN_CHAT, { kind: "quota", retry: "resend", replyToMessageId: "om_2" })

    expect(h.httpPost).toHaveBeenCalledTimes(2)
    expect(sentBodies().map((b) => b.message_id)).toEqual(["om_1", "om_2"])
    expect(sentBodies()[0].text).toContain("不会自动重试")
  })

  it("不占用自动重试的限频名额", async () => {
    await reportAgentFailure(MAIN_CHAT, { kind: "quota", retry: "resend", replyToMessageId: "om_1" })
    await reportAgentFailure(MAIN_CHAT, { kind: "quota", retry: "auto", replyToMessageId: "om_1" })
    expect(h.httpPost).toHaveBeenCalledTimes(2)
  })
})
