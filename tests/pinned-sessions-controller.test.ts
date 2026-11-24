import { describe, expect, it, vi } from "vitest"
import { createPinsController, pinMoveOf, type PinsApi } from "../src/renderer/components/chat/pinned-sessions"
import { movePinned, type PinPlacement } from "../src/shared/app-chat-pins"
import { appChatSessionId } from "../src/shared/app-chat-types"

/** 桌面端对话页的置顶：读写电脑端那一份，点了先生效、没改成回滚 */

const A = "ch|app_main::D:\\work\\a"
const B = "ch|app_main::D:\\work\\b"
const idA = appChatSessionId(A)
const idB = appChatSessionId(B)
const C = "ch|app_main::D:\\work\\c"
const idC = appChatSessionId(C)

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
  const api: PinsApi & { push: (pins: string[]) => void; setCalls: [string, boolean][]; moveCalls: [string, string, PinPlacement][]; unsubscribed: boolean } = {
    getPins: vi.fn(async () => [...state.server]),
    setPinned: vi.fn(async (key: string, pinned: boolean): Promise<SetResult> => {
      api.setCalls.push([key, pinned])
      const id = appChatSessionId(key)
      state.server = pinned ? [id, ...state.server.filter((x) => x !== id)] : state.server.filter((x) => x !== id)
      return { ok: true, pins: [...state.server] }
    }),
    movePin: vi.fn(async (key: string, targetKey: string, placement: PinPlacement): Promise<SetResult> => {
      api.moveCalls.push([key, targetKey, placement])
      state.server = [...movePinned(state.server, key, targetKey, placement)]
      return { ok: true, pins: [...state.server] }
    }),
    onPins: (cb) => { listener = cb; return () => { api.unsubscribed = true; listener = null } },
    push: (pins) => listener?.(pins),
    setCalls: [],
    moveCalls: [],
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
    expect(c.ids()).toEqual([idA, idB])
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

  it("连点两个不同的会话：都生效，后置顶的在最前", async () => {
    const { c } = setup()
    await tick()
    c.toggle(A)
    c.toggle(B)
    expect(c.ids()).toEqual([idB, idA])
    await tick()
    expect(c.ids()).toEqual([idB, idA])
  })
})

describe("桌面端置顶：拖动调整顺序", () => {
  it("松手马上换位置（不等电脑端回话），并告诉电脑端挪的是谁、挪到谁的哪一边", async () => {
    const { api, c, changes } = setup([idA, idB, idC])
    await tick()
    changes.length = 0
    c.move(A, C, "after")
    expect(c.ids()).toEqual([idB, idC, idA])
    expect(changes).toEqual([[idB, idC, idA]])
    expect(api.moveCalls).toEqual([[A, C, "after"]])
    await tick()
    expect(c.ids()).toEqual([idB, idC, idA])
  })

  it("顺序没变（放回原位）、有一个没置顶：不发请求，也不触发刷新", async () => {
    const { api, c, changes } = setup([idA, idB])
    await tick()
    changes.length = 0
    c.move(A, B, "before")
    c.move(B, A, "after")
    c.move(A, C, "before")
    c.move(A, A, "after")
    expect(api.moveCalls).toEqual([])
    expect(changes).toEqual([])
  })

  it("电脑端返回了最新列表：以它为准（比如这期间手机又置顶了别的）", async () => {
    const { state, c } = setup([idA, idB])
    await tick()
    state.server = [idC, idA, idB]
    c.move(B, A, "before")
    await tick()
    expect(c.ids()).toEqual([idC, idB, idA])
  })

  it("电脑端没改成：报错，并按电脑端的真实状态回滚", async () => {
    const { api, c, errors } = setup([idA, idB])
    await tick()
    api.movePin = vi.fn(async (): Promise<SetResult> => ({ ok: false, error: "置顶排序的参数不对" }))
    c.move(B, A, "before")
    expect(c.ids()).toEqual([idB, idA])
    await tick()
    expect(errors).toEqual(["置顶排序的参数不对"])
    expect(c.ids()).toEqual([idA, idB])
  })

  it("没改成又没说原因：用默认提示", async () => {
    const { api, c, errors } = setup([idA, idB])
    await tick()
    api.movePin = vi.fn(async (): Promise<SetResult> => ({ ok: false }))
    c.move(B, A, "before")
    await tick()
    expect(errors).toEqual(["调整置顶顺序失败"])
  })

  it("通信本身出错（IPC 异常）：同样报错并回滚", async () => {
    const { api, c, errors } = setup([idA, idB])
    await tick()
    api.movePin = vi.fn(async () => { throw new Error("ipc down") })
    c.move(B, A, "before")
    await tick()
    expect(errors).toEqual(["ipc down"])
    expect(c.ids()).toEqual([idA, idB])
  })

  it("页面关掉之后晚到的结果不再处理", async () => {
    const { api, c, changes, errors } = setup([idA, idB])
    await tick()
    const slow = deferred<SetResult>()
    api.movePin = vi.fn(() => slow.promise)
    c.move(B, A, "before")
    changes.length = 0
    c.dispose()
    slow.resolve({ ok: false, error: "晚到的错误" })
    await tick()
    expect(errors).toEqual([])
    expect(changes).toEqual([])
  })
})

describe("桌面端置顶：拖动排好的新顺序换算成移动参数", () => {
  it("放在最前或中间：挪到后一项的前面；放在最后：挪到前一项的后面", () => {
    expect(pinMoveOf(["b", "a", "c"], "b")).toEqual({ targetKey: "a", placement: "before" })
    expect(pinMoveOf(["a", "c", "b"], "c")).toEqual({ targetKey: "b", placement: "before" })
    expect(pinMoveOf(["a", "c", "b"], "b")).toEqual({ targetKey: "c", placement: "after" })
  })

  it("只有一项、被拖的不在顺序里：没有可挪的", () => {
    expect(pinMoveOf(["a"], "a")).toBeUndefined()
    expect(pinMoveOf([], "a")).toBeUndefined()
    expect(pinMoveOf(["a", "b"], "x")).toBeUndefined()
  })

  it("套回 movePinned，同一类里得到的就是排好的顺序（别的类的置顶夹在中间也一样）", () => {
    const group = ["a", "b", "c"]
    const all = ["a", "x", "b", "y", "c"]
    for (const moved of group) {
      for (let to = 0; to < group.length; to++) {
        const rest = group.filter((k) => k !== moved)
        const next = [...rest.slice(0, to), moved, ...rest.slice(to)]
        const move = pinMoveOf(next, moved)
        expect(move).toBeDefined()
        const result = movePinned(all, moved, move!.targetKey, move!.placement)
        expect(result.filter((k) => group.includes(k))).toEqual(next)
      }
    }
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
