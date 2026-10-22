import { describe, expect, it } from "vitest"
import type { MobileChannelView, MobileChatTab } from "../src/mobile/api"
import { withDrafts } from "../src/mobile/session-drafts"

const tab = (sessionKey: string, extra: Partial<MobileChatTab> = {}): MobileChatTab => ({
  sessionKey,
  label: sessionKey,
  kind: "dir",
  running: false,
  current: false,
  ...extra,
})

const view = (channelId: string, tabs: MobileChatTab[]): MobileChannelView => ({
  channelId,
  name: channelId,
  tabs,
})

describe("withDrafts", () => {
  it("returns the same views when there are no drafts", () => {
    const views = [view("ch1", [tab("a")])]
    expect(withDrafts(views, [], {})).toBe(views)
  })

  it("adds a draft tab to its own channel only, ahead of existing tabs", () => {
    const views = [view("ch1", [tab("a")]), view("ch2", [tab("b")])]
    const out = withDrafts(views, [{ channelId: "ch2", sessionKey: "d1" }], {})
    expect(out[0].tabs.map((t) => t.sessionKey)).toEqual(["a"])
    expect(out[1].tabs.map((t) => t.sessionKey)).toEqual(["d1", "b"])
    expect(out[1].tabs[0]).toMatchObject({ label: "新会话", removable: true, running: false })
  })

  it("does not duplicate a draft once the server already lists that session", () => {
    const views = [view("ch1", [tab("d1")])]
    const out = withDrafts(views, [{ channelId: "ch1", sessionKey: "d1" }], {})
    expect(out[0].tabs).toHaveLength(1)
  })

  // 回归：草稿不在服务端会话树里，选了模型后界面一直显示默认模型
  it("carries the model the server reports for a draft session", () => {
    const views = [view("ch1", [tab("a", { model: "other" })])]
    const out = withDrafts(
      views,
      [{ channelId: "ch1", sessionKey: "d1" }],
      { d1: { model: "gpt-x", modelParams: "high", resourceId: "res-2" } },
    )
    expect(out[0].tabs[0]).toMatchObject({ sessionKey: "d1", model: "gpt-x", modelParams: "high", resourceId: "res-2" })
    expect(out[0].tabs[1].model).toBe("other")
  })

  it("leaves model fields empty for a draft with no reported model", () => {
    const out = withDrafts([view("ch1", [])], [{ channelId: "ch1", sessionKey: "d1" }], { other: { model: "x" } })
    expect(out[0].tabs[0].model).toBeUndefined()
  })
})
