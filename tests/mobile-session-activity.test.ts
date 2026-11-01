import { describe, expect, it } from "vitest"
import { upsertChatItems, type AppChatItem } from "../src/shared/app-chat-types"
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

  it("a queued message (still in the staging area) does not count as awaiting a reply", () => {
    const queued: AppChatItem = { id: "u2", kind: "user", ts: 1, text: "later", queued: true }
    const cur = activityFromItems([user("u1"), assistant("a1", false), assistant("a1", true)])
    expect(isActivityBusy(applyActivityItem(cur, queued))).toBe(false)
  })

  it("once the queued message is delivered it counts as awaiting a reply", () => {
    const cur = activityFromItems([user("u1"), assistant("a1", false), assistant("a1", true)])
    expect(isActivityBusy(applyActivityItem(cur, user("u2")))).toBe(true)
  })

  it("keeps the same object when nothing changes", () => {
    const cur = activityFromItems([user("u1"), assistant("a1", false)])
    expect(applyActivityItem(cur, assistant("a1", false))).toBe(cur)
  })
})

// 历史接口返回的是每条记录的最终状态：已收口的回合卡前面没有「未收口」那一帧，
// 不能照搬事件流的规则，否则「等待回应」会一直挂着，回复完了还显示「正在思考」、发送键变停止键
describe("session activity from a stored history", () => {
  it("is idle when the last turn already has a finished reply", () => {
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", true)]))).toBe(false)
  })

  it("is idle after several finished turns", () => {
    const history = [user("u1"), assistant("a1", true), user("u2"), assistant("a2", true)]
    expect(isActivityBusy(activityFromItems(history))).toBe(false)
  })

  it("stays idle when a notice or a queued message follows the finished reply", () => {
    const queued: AppChatItem = { id: "u2", kind: "user", ts: 1, text: "later", queued: true }
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", true), notice("n1")]))).toBe(false)
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", true), queued]))).toBe(false)
  })

  it("is busy when a delivered user message has no reply yet", () => {
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", true), user("u2")]))).toBe(true)
  })

  it("is busy while the last reply card is still open", () => {
    expect(isActivityBusy(activityFromItems([user("u1"), assistant("a1", true), user("u2"), assistant("a2", false)]))).toBe(true)
  })

  it("is idle when the snapshot is stale but a finish arrived while it was loading", () => {
    // 拉历史期间实时流先到了收口事件：并入后以收口为准，不能被拉回来的旧快照盖成「还在回复」
    const snapshot = [user("u1"), assistant("a1", false)]
    const live = [assistant("a1", true)]
    expect(isActivityBusy(activityFromItems(upsertChatItems(snapshot, live)))).toBe(false)
  })

  it("a re-sent finish of an older card does not end the wait for a newly delivered message", () => {
    // 实时流里重新收口旧卡（Resume 时会补发）不能把「刚发出去、AI 还没回应」的新消息当成已回应
    const cur = activityFromItems([user("u1"), assistant("a1", true), user("u2")])
    expect(isActivityBusy(applyActivityItem(cur, assistant("a1", true)))).toBe(true)
  })
})
