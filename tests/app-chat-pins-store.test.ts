import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appChatSessionId } from "../src/shared/app-chat-types"

/**
 * 置顶会话存在电脑端（主进程）：桌面端和手机端都以它为准。
 * 真实的 app-chat-pins + 真实文件（临时数据目录），只把 electron 顶掉；
 * 「重启」用 vi.resetModules() 换一套全新的模块实例，内存缓存清空、磁盘上的留着。
 */

let userData = ""
const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) } } }],
  },
  ipcMain: { handle: () => {}, on: () => {} },
}))

type Pins = typeof import("../electron/app-chat-pins")
async function load(): Promise<Pins> {
  vi.resetModules()
  return await import("../electron/app-chat-pins")
}

const A = "ch|app_main::D:\\work\\a"
const B = "ch|app_main::D:\\work\\b"
const file = () => path.join(userData, "app-chat-pins.json")

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-pins-"))
  sent.length = 0
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe("电脑端的置顶会话", () => {
  it("没存过：没有置顶", async () => {
    expect((await load()).getAppChatPins()).toEqual([])
  })

  it("置顶后能读到，先置顶的在前", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, true)
    pins.setAppChatPinned(B, true)
    expect(pins.getAppChatPins()).toEqual([appChatSessionId(A), appChatSessionId(B)])
  })

  it("存在磁盘上：重启后还在", async () => {
    const first = await load()
    first.setAppChatPinned(A, true)
    const second = await load()
    expect(second.getAppChatPins()).toEqual([appChatSessionId(A)])
  })

  it("取消置顶：只去掉那一个，磁盘上也跟着变", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, true)
    pins.setAppChatPinned(B, true)
    pins.setAppChatPinned(A, false)
    expect(pins.getAppChatPins()).toEqual([appChatSessionId(B)])
    expect(JSON.parse(fs.readFileSync(file(), "utf-8"))).toEqual([appChatSessionId(B)])
  })

  it("同一个会话路径写法不同（大小写、分隔符）：认作同一个，不会置顶两次", async () => {
    const pins = await load()
    pins.setAppChatPinned("ch|app_main::D:\\Work\\A", true)
    pins.setAppChatPinned("ch|app_main::d:/work/a", true)
    expect(pins.getAppChatPins()).toHaveLength(1)
  })

  it("读到的是拷贝：外面改它不影响电脑端存着的", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, true)
    pins.getAppChatPins().push("x")
    expect(pins.getAppChatPins()).toEqual([appChatSessionId(A)])
  })

  it("文件被改坏了：当作没有置顶，之后还能正常置顶", async () => {
    fs.writeFileSync(file(), "{not json", "utf-8")
    const pins = await load()
    expect(pins.getAppChatPins()).toEqual([])
    pins.setAppChatPinned(A, true)
    expect(pins.getAppChatPins()).toEqual([appChatSessionId(A)])
  })

  it("文件里混进了别的东西：只认字符串", async () => {
    fs.writeFileSync(file(), JSON.stringify(["a", 1, null, "a", ""]), "utf-8")
    expect((await load()).getAppChatPins()).toEqual(["a"])
  })
})

describe("置顶变化通知两端", () => {
  it("改了就推给所有桌面窗口和订阅者（手机网关靠它推实时流）", async () => {
    const pins = await load()
    const seen: string[][] = []
    pins.subscribeAppChatPins((p) => seen.push(p))
    pins.setAppChatPinned(A, true)
    expect(sent).toEqual([{ channel: "app-chat:pins", payload: [appChatSessionId(A)] }])
    expect(seen).toEqual([[appChatSessionId(A)]])
    pins.setAppChatPinned(A, false)
    expect(seen[1]).toEqual([])
  })

  it("已经是目标状态：不写盘、不通知", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, false)
    expect(fs.existsSync(file())).toBe(false)
    expect(sent).toHaveLength(0)
    pins.setAppChatPinned(A, true)
    sent.length = 0
    const before = fs.statSync(file()).mtimeMs
    pins.setAppChatPinned(A, true)
    expect(sent).toHaveLength(0)
    expect(fs.statSync(file()).mtimeMs).toBe(before)
  })

  it("取消订阅后不再收到；订阅者抛错不影响别人", async () => {
    const pins = await load()
    const seen: number[] = []
    const off = pins.subscribeAppChatPins(() => seen.push(1))
    pins.subscribeAppChatPins(() => { throw new Error("boom") })
    pins.subscribeAppChatPins(() => seen.push(2))
    pins.setAppChatPinned(A, true)
    expect(seen).toEqual([1, 2])
    off()
    pins.setAppChatPinned(B, true)
    expect(seen).toEqual([1, 2, 2])
  })
})

describe("写不进磁盘", () => {
  it("抛错，内存里也不变（不会界面上置顶了、重启又没了）", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, true)
    sent.length = 0
    fs.rmSync(userData, { recursive: true, force: true })
    expect(() => pins.setAppChatPinned(B, true)).toThrow()
    expect(pins.getAppChatPins()).toEqual([appChatSessionId(A)])
    expect(sent).toHaveLength(0)
  })

  it("删会话时顺手取消置顶失败：不抛错，不连累删除", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, true)
    fs.rmSync(userData, { recursive: true, force: true })
    expect(() => pins.removeAppChatPin(A)).not.toThrow()
  })
})

describe("会话删除后", () => {
  it("取消置顶；没置顶过的无事发生", async () => {
    const pins = await load()
    pins.setAppChatPinned(A, true)
    pins.removeAppChatPin(B)
    expect(pins.getAppChatPins()).toEqual([appChatSessionId(A)])
    pins.removeAppChatPin(A)
    expect(pins.getAppChatPins()).toEqual([])
  })
})
