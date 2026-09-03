import { describe, expect, it } from "vitest"

import { resolveCustomModelApi, normalizeGatewayRoot } from "../electron/llm-model-catalog"

/**
 * pi 内置表这条分支在这里测不到：getModel 依赖 pi 运行时的 provider 注册，
 * vitest 环境下取不到（返回 null），只能验兜底路径。
 * 生产上以每回合那行日志为准：`本回合模型: <id> · <api> · <baseUrl>`。
 */
describe("自定义网关协议判定", () => {
  it("签名是 modelId + 可选 baseUrl（按网关区分多提供商同名模型）", () => {
    expect(resolveCustomModelApi.length).toBe(2)
  })

  it("目录都认不出时退回 openai-completions（自托管网关绝大多数走这个）", () => {
    expect(resolveCustomModelApi("definitely-not-a-real-model-xyz")).toBe("openai-completions")
    expect(resolveCustomModelApi("definitely-not-a-real-model-xyz", "https://opencode.ai/zen/go/v1")).toBe(
      "openai-completions",
    )
  })
})

describe("normalizeGatewayRoot", () => {
  it("剥掉端点自带的能力后缀，否则 pi 拼出 /v1/messages/chat/completions", () => {
    expect(normalizeGatewayRoot("https://ai-gW3qIw.zeusl.ink/v1/messages/")).toBe("https://ai-gW3qIw.zeusl.ink/v1")
    expect(normalizeGatewayRoot("https://relay.example.com/openai/v1/chat/completions")).toBe("https://relay.example.com/openai/v1")
    expect(normalizeGatewayRoot("https://opencode.ai/zen/go/v1/responses")).toBe("https://opencode.ai/zen/go/v1")
    expect(normalizeGatewayRoot("https://gw.example.com/v1")).toBe("https://gw.example.com/v1")
  })
})
