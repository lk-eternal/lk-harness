import { describe, expect, it } from "vitest"
import {
  DELETED_SESSION_TTL_MS,
  forgetDeletedSession,
  hideDeletedTabs,
  markSessionDeleted,
  type DeletedSessions,
} from "../src/shared/deleted-sessions"

const KEY_A = "app_ch|app::D:\\ws\\a"
const KEY_B = "app_ch|app::D:\\ws\\b"

const tab = (sessionKey: string) => ({ sessionKey, label: sessionKey })
const view = (...keys: string[]) => ({ channelId: "app_ch", tabs: keys.map(tab) })

describe("hideDeletedTabs", () => {
  it("没有墓碑时原样返回同一个数组", () => {
    const views = [view(KEY_A, KEY_B)]
    expect(hideDeletedTabs(views, new Map())).toBe(views)
  })

  it("刷新结果里还带着刚删的会话时先藏起来（删除后那次迟到的刷新）", () => {
    const deleted: DeletedSessions = new Map()
    markSessionDeleted(deleted, KEY_A, 1000)
    const out = hideDeletedTabs([view(KEY_A, KEY_B)], deleted, 2000)
    expect(out[0].tabs.map((t) => t.sessionKey)).toEqual([KEY_B])
    expect(deleted.size).toBe(1)
  })

  it("服务端已不再返回它：墓碑撤掉，之后同名会话能正常出现", () => {
    const deleted: DeletedSessions = new Map()
    markSessionDeleted(deleted, KEY_A, 1000)
    hideDeletedTabs([view(KEY_B)], deleted, 2000)
    expect(deleted.size).toBe(0)
    const again = [view(KEY_A, KEY_B)]
    expect(hideDeletedTabs(again, deleted, 3000)).toBe(again)
  })

  it("超时的墓碑不再压制，避免服务端迟迟不收敛时会话永远不显示", () => {
    const deleted: DeletedSessions = new Map()
    markSessionDeleted(deleted, KEY_A, 1000)
    const views = [view(KEY_A)]
    expect(hideDeletedTabs(views, deleted, 1000 + DELETED_SESSION_TTL_MS + 1)).toBe(views)
    expect(deleted.size).toBe(0)
  })

  it("路径大小写、分隔符写法不同也算同一个会话", () => {
    const deleted: DeletedSessions = new Map()
    markSessionDeleted(deleted, "app_ch|app::D:/WS/A", 1000)
    const out = hideDeletedTabs([view(KEY_A, KEY_B)], deleted, 2000)
    expect(out[0].tabs.map((t) => t.sessionKey)).toEqual([KEY_B])
  })

  it("重新打开同一个会话时可以撤掉墓碑", () => {
    const deleted: DeletedSessions = new Map()
    markSessionDeleted(deleted, KEY_A, 1000)
    forgetDeletedSession(deleted, KEY_A)
    const views = [view(KEY_A)]
    expect(hideDeletedTabs(views, deleted, 2000)).toBe(views)
  })

  it("只改动命中的通道，其它通道保持同一个对象", () => {
    const deleted: DeletedSessions = new Map()
    markSessionDeleted(deleted, KEY_A, 1000)
    const other = { channelId: "other", tabs: [tab(KEY_B)] }
    const out = hideDeletedTabs([view(KEY_A), other], deleted, 2000)
    expect(out[0].tabs).toEqual([])
    expect(out[1]).toBe(other)
  })
})
