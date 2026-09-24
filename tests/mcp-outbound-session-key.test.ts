import { describe, expect, it } from "vitest"
import { resolveMcpSendSessionKey } from "../src/shared/mcp-outbound-session-key.js"
import type { ScheduledTask } from "../src/shared/scheduled-task.js"

const tasks: ScheduledTask[] = [
  {
    id: "task-1",
    name: "t",
    cron: "0 * * * *",
    content: "x",
    enabled: true,
    channelId: "ch_a",
    notifyChatId: "oc_g",
  },
]

describe("resolveMcpSendSessionKey", () => {
  it("defaults invoker for normal chat session", () => {
    const sk = "ch_a|oc_x::D:\\ws"
    expect(resolveMcpSendSessionKey(sk, tasks)).toBe(sk)
  })

  it("defaults independent task invoker to notify chatKey", () => {
    expect(resolveMcpSendSessionKey("task-1", tasks, () => "ou_main")).toBe("ch_a|oc_g")
  })
})
