import { describe, expect, it, vi } from "vitest"
import {
  createGroupStatesController,
  shouldReveal,
  type GroupStatesApi,
} from "../src/renderer/components/chat/session-groups-state"
import { parseGroupStates, type GroupStatePatch, type SessionGroupStates, type SessionListGroupId } from "../src/shared/session-groups"

/** 桌面端会话栏各分类的折叠 / 展开：读写电脑端那一份，点了先生效、没改成回滚 */

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

type SetResult = Awaited<ReturnType<GroupStatesApi["setGroup"]>>

function fakeApi(initial: unknown = undefined) {
  let listener: ((states: unknown) => void) | null = null
  const server = { states: parseGroupStates(initial) }
  const setCalls: [SessionListGroupId, GroupStatePatch][] = []
  const api: GroupStatesApi & { push: (states: unknown) => void; unsubscribed: boolean } = {
    getStates: vi.fn(async () => structuredClone(server.states)),
    setGroup: vi.fn(async (group: SessionListGroupId, patch: GroupStatePatch): Promise<SetResult> => {
      setCalls.push([group, patch])
      server.states = { ...server.states, [group]: { ...server.states[group], ...patch } }
      return { ok: true, sessionGroups: structuredClone(server.states) }
    }),
    onStates: (cb) => { listener = cb; return () => { api.unsubscribed = true; listener = null } },
    push: (states) => listener?.(states),
    unsubscribed: false,
  }
  return { api, server, setCalls }
}

function setup(initial: unknown = undefined) {
  const { api, server, setCalls } = fakeApi(initial)
  const changes: SessionGroupStates[] = []
  const errors: string[] = []
  const c = createGroupStatesController(api, (s) => changes.push(s), (m) => errors.push(m))
  return { api, server, setCalls, c, changes, errors }
}

describe("桌面端分类状态：读取", () => {
  it("一开始是默认状态，拉到电脑端存的之后更新", async () => {
    const { c, changes } = setup({ chat: { collapsed: true, level: 1 } })
    expect(c.states().chat).toEqual({ collapsed: false, level: 0 })
    await tick()
    expect(c.states().chat).toEqual({ collapsed: true, level: 1 })
    expect(changes).toHaveLength(1)
  })

  it("电脑端存的就是默认状态：不触发多余的刷新", async () => {
    const { changes } = setup()
    await tick()
    expect(changes).toEqual([])
  })

  it("拉取期间已经收到推送：以推送为准，晚到的拉取结果不覆盖它", async () => {
    const { api } = fakeApi()
    const late = deferred<unknown>()
    api.getStates = vi.fn(() => late.promise)
    const c = createGroupStatesController(api, () => {}, () => {})
    api.push({ project: { collapsed: true } })
    late.resolve({ chat: { collapsed: true } })
    await tick()
    expect(c.states().project.collapsed).toBe(true)
    expect(c.states().chat.collapsed).toBe(false)
  })

  it("另一端（手机）改了：推送过来就更新；内容没变不触发刷新", async () => {
    const { api, c, changes } = setup()
    await tick()
    api.push({ archived: { collapsed: false, level: 2 } })
    expect(c.states().archived).toEqual({ collapsed: false, level: 2 })
    expect(changes).toHaveLength(1)
    api.push({ archived: { collapsed: false, level: 2 } })
    expect(changes).toHaveLength(1)
  })

  it("推送来的内容不合法：该字段退回默认值", async () => {
    const { api, c } = setup()
    await tick()
    api.push({ chat: { collapsed: "x", level: 9 }, project: { level: 1 } })
    expect(c.states().chat).toEqual({ collapsed: false, level: 0 })
    expect(c.states().project).toEqual({ collapsed: false, level: 1 })
  })

  it("拉取失败：保持默认，不报错；之后的推送照常生效", async () => {
    const { api } = fakeApi()
    api.getStates = vi.fn(async () => { throw new Error("ipc down") })
    const errors: string[] = []
    const c = createGroupStatesController(api, () => {}, (m) => errors.push(m))
    await tick()
    expect(errors).toEqual([])
    api.push({ chat: { collapsed: true } })
    expect(c.states().chat.collapsed).toBe(true)
  })
})

describe("桌面端分类状态：点击", () => {
  it("点了马上生效（不等电脑端回话），并告诉电脑端改的是哪一类的什么", async () => {
    const { c, changes, setCalls } = setup()
    await tick()
    c.update("chat", { collapsed: true })
    expect(c.states().chat.collapsed).toBe(true)
    expect(changes).toHaveLength(1)
    expect(setCalls).toEqual([["chat", { collapsed: true }]])
    await tick()
    expect(c.states().chat.collapsed).toBe(true)
  })

  it("已经是目标状态：不发请求，也不触发刷新", async () => {
    const { c, changes, setCalls } = setup()
    await tick()
    c.update("chat", { collapsed: false, level: 0 })
    expect(setCalls).toEqual([])
    expect(changes).toEqual([])
  })

  it("电脑端返回了最新状态：以它为准（比如这期间手机也折叠了别的类）", async () => {
    const { server, c } = setup()
    await tick()
    server.states = { ...server.states, project: { collapsed: true, level: 1 } }
    c.update("chat", { level: 1 })
    await tick()
    expect(c.states().project).toEqual({ collapsed: true, level: 1 })
    expect(c.states().chat.level).toBe(1)
  })

  it("电脑端没改成：报错，并按电脑端的真实状态回滚", async () => {
    const { api, c, errors } = setup()
    await tick()
    api.setGroup = vi.fn(async (): Promise<SetResult> => ({ ok: false, error: "会话分类的参数不对" }))
    c.update("chat", { collapsed: true })
    expect(c.states().chat.collapsed).toBe(true)
    await tick()
    expect(errors).toEqual(["会话分类的参数不对"])
    expect(c.states().chat.collapsed).toBe(false)
  })

  it("没改成又没说原因：用默认提示", async () => {
    const { api, c, errors } = setup()
    await tick()
    api.setGroup = vi.fn(async (): Promise<SetResult> => ({ ok: false }))
    c.update("chat", { collapsed: true })
    await tick()
    expect(errors).toEqual(["保存列表的折叠状态失败"])
  })

  it("通信本身出错（IPC 异常）：同样报错并回滚", async () => {
    const { api, c, errors } = setup()
    await tick()
    api.setGroup = vi.fn(async () => { throw new Error("ipc down") })
    c.update("archived", { collapsed: false })
    await tick()
    expect(errors).toEqual(["ipc down"])
    expect(c.states().archived.collapsed).toBe(true)
  })

  it("连点两类：都生效", async () => {
    const { c } = setup()
    await tick()
    c.update("project", { collapsed: true })
    c.update("chat", { level: 2 })
    await tick()
    expect(c.states().project.collapsed).toBe(true)
    expect(c.states().chat.level).toBe(2)
  })
})

describe("桌面端分类状态：页面关掉之后", () => {
  it("取消订阅，之后的推送和晚到的结果都不再处理", async () => {
    const { api, c, changes, errors } = setup()
    await tick()
    const slow = deferred<SetResult>()
    api.setGroup = vi.fn(() => slow.promise)
    c.update("chat", { collapsed: true })
    changes.length = 0
    c.dispose()
    expect(api.unsubscribed).toBe(true)
    slow.resolve({ ok: false, error: "晚到的错误" })
    await tick()
    expect(errors).toEqual([])
    expect(changes).toEqual([])
  })
})

describe("选中的会话要不要为它撑开分类", () => {
  const KEY_A = "ch|app_main::D:\\work\\a"
  const KEY_B = "ch|app_main::D:\\work\\b"

  it("第一次选中（开 app 或载入完成后默认选中的）不算：否则每次重启记住的折叠都白记了", () => {
    expect(shouldReveal(null, KEY_A, "chat")).toBe(false)
  })

  it("换选了另一个会话（点通知跳过来的、新建了会话、列表里点了别的）：要", () => {
    expect(shouldReveal({ key: KEY_A, group: "chat" }, KEY_B, "chat")).toBe(true)
    expect(shouldReveal({ key: KEY_A, group: "chat" }, KEY_B, undefined)).toBe(true)
  })

  it("还是同一个会话，只是键的写法不同（路径分隔符、大小写）：不算换选", () => {
    expect(shouldReveal({ key: "ch|app_main::D:\\Work\\A", group: "chat" }, "ch|app_main::d:/work/a", "chat")).toBe(false)
  })

  it("同一个会话换了分类（刚把当前项目归档了、取消归档了）：要", () => {
    expect(shouldReveal({ key: KEY_A, group: "project" }, KEY_A, "archived")).toBe(true)
    expect(shouldReveal({ key: KEY_A, group: "archived" }, KEY_A, "project")).toBe(true)
  })

  it("同一个会话同一类：不要", () => {
    expect(shouldReveal({ key: KEY_A, group: "chat" }, KEY_A, "chat")).toBe(false)
  })

  it("会话还没出现在列表里（分类未知）：无从比较，不要", () => {
    expect(shouldReveal({ key: KEY_A, group: undefined }, KEY_A, "chat")).toBe(false)
    expect(shouldReveal({ key: KEY_A, group: "chat" }, KEY_A, undefined)).toBe(false)
  })
})
