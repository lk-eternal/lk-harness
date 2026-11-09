import { describe, expect, it } from "vitest"
import { visibleChatTabs } from "../src/shared/app-chat-types.js"

describe("visibleChatTabs：对话页会话列表", () => {
  it("定时任务会话不列，其它照常", () => {
    const tabs = [
      { sessionKey: "ch|app_main::D:/chat", kind: "main" },
      { sessionKey: "ai-61db5c69-3", kind: "task" },
      { sessionKey: "ch|app_main::D:/lk", kind: "dir" },
      { sessionKey: "temp_abc", kind: "temp" },
    ]
    expect(visibleChatTabs(tabs).map((t) => t.kind)).toEqual(["main", "dir", "temp"])
  })

  it("没有任务会话时原样返回", () => {
    const tabs = [{ sessionKey: "a", kind: "main" }]
    expect(visibleChatTabs(tabs)).toEqual(tabs)
  })
})
