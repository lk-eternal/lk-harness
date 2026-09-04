import { describe, it, expect } from "vitest"
import { preserveChannelBindings } from "../src/shared/channel-binding.js"

describe("preserveChannelBindings", () => {
  it("旧快照缺 openId 时回填落盘值", () => {
    const got = preserveChannelBindings(
      [{ id: "ch1", mainUserOpenId: "" }],
      [{ id: "ch1", mainUserOpenId: "ou_abc" }],
    )
    expect(got?.[0].mainUserOpenId).toBe("ou_abc")
  })

  it("本次换绑尊重新值", () => {
    const got = preserveChannelBindings(
      [{ id: "ch1", mainUserOpenId: "ou_new" }],
      [{ id: "ch1", mainUserOpenId: "ou_old" }],
    )
    expect(got?.[0].mainUserOpenId).toBe("ou_new")
  })

  it("落盘无值时不编造", () => {
    const incoming = [{ id: "ch1", mainUserOpenId: "" }]
    expect(preserveChannelBindings(incoming, [{ id: "ch1" }])).toBe(incoming)
  })

  it("新通道不受影响", () => {
    const incoming = [{ id: "ch2", mainUserOpenId: "" }]
    expect(preserveChannelBindings(incoming, [{ id: "ch1", mainUserOpenId: "ou_x" }])).toBe(incoming)
  })

  it("无输入直接返回", () => {
    expect(preserveChannelBindings(undefined, [])).toBeUndefined()
  })
})
