import { describe, expect, it, vi } from "vitest"
import { createPinsController, type PinsApi } from "../src/renderer/components/chat/pinned-sessions"
import { appChatSessionId } from "../src/shared/app-chat-types"

/** 桌面端对话页的置顶：读写电脑端那一份，点了先生效、没改成回滚 */

const A = "ch|app_main::D:\\work\\a"
const B = "ch|app_main::D:\\work\\b"
const idA = appChatSessionId(A)
const idB = appChatSessionId(B)

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

type SetResult = Awaited<ReturnType<PinsApi["setPinned"]>>

function fakeApi(initial: string[] = []) {
  let listener: ((pins: string[]) => void) | null = null
  const state = { server: [...initial] }
  const api: PinsApi & { push: (pins: string[]) => void; setCalls: [string, boolean][]; unsubscribed: boolean } = {
    getPins: vi.fn(async () => [...state.server]),
    setPinned: vi.fn(async (key: string, pinned: boolean): Promise<SetResult> => {
      api.setCalls.push([key, pinned])
      const id = appChatSessionId(key)
      state.server = pinned ? [...state.server.filter((x) => x !== id), id] : state.server.filter((x) => x !== id)
      return { ok: true, pins: [...state.server] }
    }),
    onPins: (cb) => { listener = cb; return () => { api.unsubscribed = true; listener = null } },
    push: (pins) => listener?.(pins),
    setCalls: [],
    unsubscribed: false,
  }
  return { api, state }
}

function setup(initial: string[] = []) {
  const { api, state } = fakeApi(initial)
  const changes: (readonly string[])[] = []
  const errors: string[] = []
  const c = createPinsController(api, (ids) => changes.push(ids), (m) => errors.push(m))
  return { api, state, c, changes, errors }
}

describe("桌面端置顶：读取", () => {
  it("一开始没有，拉到电脑端的置顶后更新", async () => {
    const { c, changes } = setup([idA])
    expect(c.ids()).toEqual([])
    await tick()
    expect(c.ids()).toEqual([idA])
    expect(changes).toEqual([[idA]])
  })

  it("电脑端也没有置顶：不触发多余的刷新", async () => {
    const { changes } = setup([])
    await tick()
    expect(changes).toEqual([])
  })

  it("拉取期间已经收到推送：以推送为准，晚到的拉取结果不覆盖它", async () => {
    const { api } = fakeApi()
    const late = deferred<string[]>()
    api.getPins = vi.fn(() => late.promise)
    const changes: (readonly string[])[] = []
    const c = createPinsController(api, (ids) => changes.push(ids), () => {})
    api.push([idB])
    late.resolve([idA])
    await tick()
    expect(c.ids()).toEqual([idB])
  })

  it("另一端（手机）改了：推送过来就更新", async () => {
    const { api, c } = setup()
    await tick()
    api.push([idA, idB])
    expect(c.ids()).toEqual([idA, idB])
    api.push([])
    expect(c.ids()).toEqual([])
  })

  it("推送的内容没变：不触发刷新", async () => {
    const { api, changes } = setup([idA])
    await tick()
    api.push([idA])
    expect(changes).toEqual([[idA]])
  })

  it("拉取失败：保持现状，不报错；之后的推送照常生效", async () => {
    const { api } = fakeApi()
    api.getPins = vi.fn(async () => { throw new Error("ipc down") })
    const errors: string[] = []
    const c = createPinsController(api, () => {}, (m) => errors.push(m))
    await tick()
    expect(c.ids()).toEqual([])
    expect(errors).toEqual([])
    api.push([idA])
    expect(c.ids()).toEqual([idA])
  })
})

describe("桌面端置顶：点击", () => {
  it("点了马上生效（不等电脑端回话），并告诉电脑端", async () => {
    const { api, c, changes } = setup()
    await tick()
    c.toggle(A)
    expect(c.ids()).toEqual([idA])
    expect(changes).toEqual([[idA]])
    expect(api.setCalls).toEqual([[A, true]])
    await tick()
    expect(c.ids()).toEqual([idA])
  })

  it("已置顶的再点一次：取消", async () => {
    const { api, c } = setup([idA])
    await tick()
    c.toggle(A)
    expect(c.ids()).toEqual([])
    expect(api.setCalls).toEqual([[A, false]])
  })

  it("电脑端返回了最新列表：以它为准（比如这期间手机也置顶了别的）", async () => {
    const { state, c } = setup()
    await tick()
    state.server = [idB]
    c.toggle(A)
    await tick()
    expect(c.ids()).toEqual([idB, idA])
  })

  it("电脑端没改成：报错，并按电脑端的真实状态回滚", async () => {
    const { api, c, errors } = setup()
    await tick()
    api.setPinned = vi.fn(async (): Promise<SetResult> => ({ ok: false, error: "不是应用内对话的会话" }))
    c.toggle(A)
    expect(c.ids()).toEqual([idA])
    await tick()
    expect(errors).toEqual(["不是应用内对话的会话"])
    expect(c.ids()).toEqual([])
  })

  it("没改成又没说原因：用默认提示（置顶和取消置顶各一句）", async () => {
    const { api, c, errors } = setup([idB])
    await tick()
    api.setPinned = vi.fn(async (): Promise<SetResult> => ({ ok: false }))
    c.toggle(A)
    await tick()
    c.toggle(B)
    await tick()
    expect(errors).toEqual(["置顶失败", "取消置顶失败"])
  })

  it("通信本身出错（IPC 异常）：同样报错并回滚", async () => {
    const { api, c, errors } = setup()
    await tick()
    api.setPinned = vi.fn(async () => { throw new Error("ipc down") })
    c.toggle(A)
    await tick()
    expect(errors).toEqual(["ipc down"])
    expect(c.ids()).toEqual([])
  })

  it("连点两个不同的会话：都生效", async () => {
    const { c } = setup()
    await tick()
    c.toggle(A)
    c.toggle(B)
    expect(c.ids()).toEqual([idA, idB])
    await tick()
    expect(c.ids()).toEqual([idA, idB])
  })
})

describe("桌面端置顶：页面关掉之后", () => {
  it("取消订阅，之后的推送和晚到的结果都不再处理", async () => {
    const { api, c, changes, errors } = setup()
    await tick()
    const slow = deferred<SetResult>()
    api.setPinned = vi.fn(() => slow.promise)
    c.toggle(A)
    changes.length = 0
    c.dispose()
    expect(api.unsubscribed).toBe(true)
    slow.resolve({ ok: false, error: "晚到的错误" })
    await tick()
    expect(errors).toEqual([])
    expect(changes).toEqual([])
  })
})
