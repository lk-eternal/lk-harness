import { describe, expect, it } from "vitest"
import { classifyAgentFailure, describeAgentFailure, failureBackoffMs } from "../electron/agent-failure"

describe("classifyAgentFailure：这轮失败算哪一类", () => {
  it.each([
    ["invalid_api_key: Incorrect API key provided", "auth"],
    ["API key not valid. Please pass a valid API key", "auth"],
    ["HTTP 401 Unauthorized", "auth"],
    ['{"status":403,"error":"Forbidden"}', "auth"],
    ["You exceeded your current quota", "quota"],
    ["Rate limit reached for requests", "quota"],
    ["insufficient credits", "quota"],
    ["Model grok-9 not found", "model"],
    ["model foo is not available", "model"],
    ["fetch failed", "network"],
    ["read ECONNRESET", "network"],
    ["Pi 回合无活动超时（30min）", "other"],
    ["something unexpected happened", "other"],
  ] as const)("%s → %s", (reason, kind) => {
    expect(classifyAgentFailure(reason)).toBe(kind)
  })

  it("先看是不是网络问题：同一段报错里既有 fetch failed 又有 401，按网络处理（立即重试）", () => {
    expect(classifyAgentFailure("fetch failed while calling gateway, last status 401")).toBe("network")
  })

  it("SDK 换 Key 的请求失败是网络抖动，不是 Key 无效", () => {
    expect(classifyAgentFailure("API key exchange failed: unauthenticated")).toBe("network")
  })

  it("状态码必须是独立的数字：耗时 4013ms、端口 4031、运行编号里的 403 不算", () => {
    expect(classifyAgentFailure('{"durationMs":4013,"id":"run-a403b"}')).toBe("other")
    expect(classifyAgentFailure("gateway http://127.0.0.1:4031/v1 返回空")).toBe("other")
  })
})

describe("failureBackoffMs：重试节奏", () => {
  it("Key 无效 / 额度 / 模型不可用：5s → 10s → 30s → 1min → 5min 封顶", () => {
    for (const kind of ["auth", "quota", "model"] as const) {
      expect([1, 2, 3, 4, 5, 6, 50].map((n) => failureBackoffMs(kind, n)))
        .toEqual([5_000, 10_000, 30_000, 60_000, 300_000, 300_000, 300_000])
    }
  })

  it("网络问题和未知错误不退避，立即重试", () => {
    expect(failureBackoffMs("network", 9)).toBe(0)
    expect(failureBackoffMs("other", 9)).toBe(0)
  })

  it("次数从 1 起算：传 0 也不会越界", () => {
    expect(failureBackoffMs("auth", 0)).toBe(5_000)
  })
})

describe("describeAgentFailure：给用户看的话", () => {
  it("主用户：说清原因、该做什么、会自动重试", () => {
    const text = describeAgentFailure({ kind: "auth", audience: "main", retry: "auto" })
    expect(text).toContain("API Key 无效")
    expect(text).toContain("设置 → Agent")
    expect(text).toContain("自动继续处理这条消息")
  })

  it("需要重发的失败：明说不会自动重试", () => {
    const text = describeAgentFailure({ kind: "quota", audience: "main", retry: "resend" })
    expect(text).toContain("额度")
    expect(text).toContain("不会自动重试")
    expect(text).toContain("重新发送")
  })

  it("每一类都有原因和下一步", () => {
    for (const kind of ["auth", "quota", "network", "model", "other"] as const) {
      const lines = describeAgentFailure({ kind, audience: "main", retry: "auto" }).split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^⚠️ .+这条消息没能处理。$/)
    }
  })

  it("未知错误附一句原因摘要：压成一行、截断、凭据打码", () => {
    const text = describeAgentFailure({
      kind: "other",
      audience: "main",
      retry: "auto",
      detail: `boom\nAuthorization: Bearer abcdefghijklmnop ${"x".repeat(300)}`,
    })
    expect(text).toContain("Agent 处理出错了（boom Authorization: Bearer ***")
    expect(text).not.toContain("abcdefghijklmnop")
    expect(text.split("\n")[0].length).toBeLessThan(200)
    expect(text).toContain("…")
  })

  it("已识别的类别不附原始报错", () => {
    const text = describeAgentFailure({ kind: "auth", audience: "main", retry: "auto", detail: "sk-secret-detail" })
    expect(text).not.toContain("sk-secret-detail")
  })

  it("别人的会话：只给通用提示，不透出原因、设置路径和原始报错", () => {
    for (const kind of ["auth", "quota", "network", "model", "other"] as const) {
      const auto = describeAgentFailure({ kind, audience: "others", retry: "auto", detail: "internal secret detail" })
      expect(auto).toBe("⚠️ 这条消息暂时没能处理，系统会自动重试，请稍候。")
      const resend = describeAgentFailure({ kind, audience: "others", retry: "resend", detail: "internal secret detail" })
      expect(resend).toBe("⚠️ 这条消息暂时没能处理，请稍后重新发送。")
    }
  })
})
