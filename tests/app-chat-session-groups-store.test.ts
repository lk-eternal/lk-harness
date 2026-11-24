import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * 会话列表各分类的折叠 / 展开状态存在电脑端（主进程）：桌面端和手机端都以它为准。
 * 真实的 app-chat-session-groups + 真实文件（临时数据目录），只把 electron 顶掉；
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

type Store = typeof import("../electron/app-chat-session-groups")
async function load(): Promise<Store> {
  vi.resetModules()
  return await import("../electron/app-chat-session-groups")
}

const file = () => path.join(userData, "app-chat-session-groups.json")

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-session-groups-"))
  sent.length = 0
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe("电脑端的会话分类状态", () => {
  it("没存过：项目、会话展开，已归档折着，都是第一档", async () => {
    expect((await load()).getSessionGroupStates()).toEqual({
      project: { collapsed: false, level: 0 },
      chat: { collapsed: false, level: 0 },
      archived: { collapsed: true, level: 0 },
    })
  })

  it("改了能读到，只动那一类", async () => {
    const store = await load()
    store.setSessionGroupState("chat", { collapsed: true })
    store.setSessionGroupState("project", { level: 2 })
    const s = store.getSessionGroupStates()
    expect(s.chat).toEqual({ collapsed: true, level: 0 })
    expect(s.project).toEqual({ collapsed: false, level: 2 })
    expect(s.archived).toEqual({ collapsed: true, level: 0 })
  })

  it("折叠和档位分开改：只改折叠不动档位", async () => {
    const store = await load()
    store.setSessionGroupState("chat", { level: 1 })
    store.setSessionGroupState("chat", { collapsed: true })
    expect(store.getSessionGroupStates().chat).toEqual({ collapsed: true, level: 1 })
  })

  it("存在磁盘上：重启后还在", async () => {
    const first = await load()
    first.setSessionGroupState("archived", { collapsed: false, level: 1 })
    const second = await load()
    expect(second.getSessionGroupStates().archived).toEqual({ collapsed: false, level: 1 })
  })

  it("读到的是拷贝：外面改它不影响电脑端存着的", async () => {
    const store = await load()
    store.getSessionGroupStates().chat.collapsed = true
    expect(store.getSessionGroupStates().chat.collapsed).toBe(false)
  })

  it("文件被改坏了：当作没存过，之后还能正常改", async () => {
    fs.writeFileSync(file(), "{not json", "utf-8")
    const store = await load()
    expect(store.getSessionGroupStates().chat).toEqual({ collapsed: false, level: 0 })
    store.setSessionGroupState("chat", { collapsed: true })
    expect(store.getSessionGroupStates().chat.collapsed).toBe(true)
  })

  it("文件里有不认识的类、不合法的值：只认合法的，其余用默认", async () => {
    fs.writeFileSync(file(), JSON.stringify({ chat: { collapsed: true, level: 7 }, other: { collapsed: true }, project: "x" }), "utf-8")
    const s = (await load()).getSessionGroupStates()
    expect(s.chat).toEqual({ collapsed: true, level: 0 })
    expect(s.project).toEqual({ collapsed: false, level: 0 })
    expect(Object.keys(s).sort()).toEqual(["archived", "chat", "project"])
  })
})

describe("分类状态变化通知两端", () => {
  it("改了就推给所有桌面窗口和订阅者（手机网关靠它推实时流）", async () => {
    const store = await load()
    const seen: unknown[] = []
    store.subscribeSessionGroupStates((s) => seen.push(s))
    store.setSessionGroupState("chat", { collapsed: true })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe("app-chat:session-groups")
    expect((sent[0].payload as { chat: unknown }).chat).toEqual({ collapsed: true, level: 0 })
    expect(seen).toEqual([sent[0].payload])
  })

  it("已经是目标状态：不写盘、不通知", async () => {
    const store = await load()
    store.setSessionGroupState("chat", { collapsed: false, level: 0 })
    expect(fs.existsSync(file())).toBe(false)
    expect(sent).toHaveLength(0)
    store.setSessionGroupState("chat", { level: 1 })
    sent.length = 0
    const before = fs.statSync(file()).mtimeMs
    store.setSessionGroupState("chat", { level: 1 })
    expect(sent).toHaveLength(0)
    expect(fs.statSync(file()).mtimeMs).toBe(before)
  })

  it("取消订阅后不再收到；订阅者抛错不影响别人", async () => {
    const store = await load()
    const seen: number[] = []
    const off = store.subscribeSessionGroupStates(() => seen.push(1))
    store.subscribeSessionGroupStates(() => { throw new Error("boom") })
    store.subscribeSessionGroupStates(() => seen.push(2))
    store.setSessionGroupState("chat", { collapsed: true })
    expect(seen).toEqual([1, 2])
    off()
    store.setSessionGroupState("chat", { collapsed: false })
    expect(seen).toEqual([1, 2, 2])
  })
})

describe("写不进磁盘", () => {
  it("抛错，内存里也不变，也不通知（不会界面上折了、重启又展开）", async () => {
    const store = await load()
    store.setSessionGroupState("chat", { level: 1 })
    sent.length = 0
    fs.rmSync(userData, { recursive: true, force: true })
    expect(() => store.setSessionGroupState("chat", { collapsed: true })).toThrow()
    expect(store.getSessionGroupStates().chat).toEqual({ collapsed: false, level: 1 })
    expect(sent).toHaveLength(0)
  })
})
