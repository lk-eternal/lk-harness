import { describe, expect, it } from "vitest"
import { ARCHIVED_GROUP_TITLE, pickDefaultTab, splitArchived } from "../src/shared/session-archive"

/** 会话列表里的「已归档」分组：怎么分、没选中会话时默认进哪个 */

interface Tab { sessionKey: string; archived?: boolean }
const tab = (sessionKey: string, archived?: boolean): Tab => (archived ? { sessionKey, archived } : { sessionKey })
const same = (a: string, b: string | undefined) => a === b

describe("splitArchived", () => {
  it("分成正常的和已归档的，各自保持原来的顺序", () => {
    const tabs = [tab("a"), tab("b", true), tab("c"), tab("d", true)]
    const { live, archived } = splitArchived(tabs)
    expect(live.map((t) => t.sessionKey)).toEqual(["a", "c"])
    expect(archived.map((t) => t.sessionKey)).toEqual(["b", "d"])
  })

  it("没有归档的：archived 为空（界面据此不渲染分组）", () => {
    const { live, archived } = splitArchived([tab("a"), tab("b")])
    expect(live).toHaveLength(2)
    expect(archived).toEqual([])
  })

  it("archived: false 按没归档算；空列表不报错；不改原数组", () => {
    const tabs = [{ sessionKey: "a", archived: false }]
    expect(splitArchived(tabs).live).toHaveLength(1)
    expect(splitArchived([])).toEqual({ live: [], archived: [] })
    const frozen = Object.freeze([tab("x", true)])
    expect(() => splitArchived(frozen)).not.toThrow()
  })

  it("分组标题", () => {
    expect(ARCHIVED_GROUP_TITLE).toBe("已归档")
  })
})

describe("pickDefaultTab", () => {
  it("优先当前会话", () => {
    expect(pickDefaultTab([tab("a"), tab("b")], "b", same)?.sessionKey).toBe("b")
  })

  it("当前会话是归档的：不落在收起来的会话上，改选第一个没归档的", () => {
    expect(pickDefaultTab([tab("a"), tab("b", true)], "b", same)?.sessionKey).toBe("a")
  })

  it("没有当前会话：取第一个没归档的，哪怕归档的排在前面", () => {
    expect(pickDefaultTab([tab("x", true), tab("a"), tab("b")], undefined, same)?.sessionKey).toBe("a")
  })

  it("全是归档的：只能退而求其次，当前会话优先，否则第一个", () => {
    expect(pickDefaultTab([tab("a", true), tab("b", true)], "b", same)?.sessionKey).toBe("b")
    expect(pickDefaultTab([tab("a", true), tab("b", true)], undefined, same)?.sessionKey).toBe("a")
  })

  it("没有会话：undefined", () => {
    expect(pickDefaultTab([], "a", same)).toBeUndefined()
  })
})
