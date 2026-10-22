import { describe, expect, it } from "vitest"
import type { AppChatItem } from "../src/shared/app-chat-types"
import { activityFromItems, applyActivityItem, isActivityBusy } from "../src/mobile/session-activity"

const user = (id: string): AppChatItem => ({ id, kind: "user", ts: 1, text: "hi" })
const assistant = (id: string, finished: boolean): AppChatItem => ({ id, kind: "assistant", ts: 1, segments: [], finished })
const notice = (id: string): AppChatItem => ({ id, kind: "notice", ts: 1, text: "ok" })

describe("session activity", () => {
  it("is idle with no items", () => {
    expect(isActivityBusy(undefined)).toBe(false)
    expect(isActivityBusy(activityFromItems([]))).toBe(false)
  })

  it("is busy while a user message has no reply yet", () => {
    expect(isActivityBusy(activityFromItems([user("u1")]))).toBe(true)
  })

  it("is busy while the assistant turn is not finished", () => {
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", false)]))).toBe(true)
  })

  it("goes idle once the turn is finished", () => {
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", false), assistant("a1", true)]))).toBe(false)
  })

  it("a file or notice arriving mid-turn does not end the turn", () => {
    const cur = activityFromItems([user("u1"), assistant("a1", false)])
    expect(isActivityBusy(applyActivityItem(cur, notice("n1")))).toBe(true)
  })

  it("a notice clears the waiting state when no turn is live", () => {
    expect(isActivityBusy(applyActivityItem(activityFromItems([user("u1")]), notice("n1")))).toBe(false)
  })

  it("keeps the same object when nothing changes", () => {
    const cur = activityFromItems([user("u1"), assistant("a1", false)])
    expect(applyActivityItem(cur, assistant("a1", false))).toBe(cur)
  })
})
