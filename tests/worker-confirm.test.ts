import { describe, it, expect, vi } from "vitest"
import { markMessagesProcessed } from "../electron/poll-host.js"

describe("markMessagesProcessed", () => {
  it("内存标记 + 认领一体：缺一即可能重做", async () => {
    const session = { processedMessageIds: new Set<string>() }
    const confirm = vi.fn(async (_sk: string) => {})
    await markMessagesProcessed(session, "sk1", [
      { messageId: "m1" },
      { messageId: "m2" },
      { text: "无 id 跳过" },
    ], confirm)
    expect([...session.processedMessageIds].sort()).toEqual(["m1", "m2"])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith("sk1")
  })

  it("认领失败不抛（best-effort），内存标记不受影响", async () => {
    const session = { processedMessageIds: new Set<string>() }
    const confirm = vi.fn(async (_sk: string) => { throw new Error("daemon 挂了") })
    await expect(
      markMessagesProcessed(session, "sk1", [{ messageId: "m1" }], confirm),
    ).resolves.toBeUndefined()
    expect(session.processedMessageIds.has("m1")).toBe(true)
  })
})
