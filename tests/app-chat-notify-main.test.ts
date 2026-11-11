import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appChatSessionId, type AppChatEvent } from "../src/shared/app-chat-types"

/**
 * 回复完成通知的主进程接线：真实的 app-chat-notify + 真实的会话记录文件（临时数据目录），
 * 只把 electron、聊天事件源、标题表、项目表顶掉。
 * 重点是「该弹的弹、不该弹的不弹」，以及点通知后窗口和界面都被带到那个会话。
 */

let userData = ""
let packaged = false
let supported = true
let windows: FakeWindow[] = []
let chatListener: ((event: AppChatEvent) => void) | null = null
const ipcOn = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const notifications: FakeNotification[] = []
const titles: Record<string, string> = {}
const projects: Record<string, { name: string }> = {}
const aumid: string[] = []

class FakeWindow {
  visible = true
  minimized = false
  focused = true
  destroyed = false
  calls: string[] = []
  sent: Array<{ channel: string; payload: unknown }> = []
  webContents = { send: (channel: string, payload: unknown) => { this.sent.push({ channel, payload }) } }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  isFocused() { return this.focused }
  restore() { this.calls.push("restore"); this.minimized = false }
  show() { this.calls.push("show"); this.visible = true }
  focus() { this.calls.push("focus"); this.focused = true }
}

class FakeNotification {
  static isSupported() { return supported }
  shown = false
  handlers: Record<string, () => void> = {}
  constructor(public opts: { title: string; body: string }) { notifications.push(this) }
  on(event: string, fn: () => void) { this.handlers[event] = fn; return this }
  show() { this.shown = true }
}

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
    get isPackaged() { return packaged },
    setAppUserModelId: (id: string) => { aumid.push(id) },
  },
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: { on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => { ipcOn.set(channel, fn) }, handle: () => {} },
  Notification: FakeNotification,
}))
vi.mock("../electron/app-chat", () => ({
  subscribeAppChatEvent: (listener: (event: AppChatEvent) => void) => { chatListener = listener; return () => {} },
}))
vi.mock("../electron/app-chat-title", () => ({ getAppChatTitles: () => ({ ...titles }) }))
vi.mock("../src/shared/project-store", () => ({
  initProjectStore: () => {},
  getProject: (id: string) => projects[id],
}))

type Notify = typeof import("../electron/app-chat-notify")
type Store = typeof import("../src/shared/session-overrides-store")
async function load(): Promise<{ notify: Notify; store: Store }> {
  vi.resetModules()
  const notify = await import("../electron/app-chat-notify")
  // 和接线里的是同一份模块实例（resetModules 之后第一次 import 起的缓存）
  const store = await import("../src/shared/session-overrides-store")
  return { notify, store }
}

const A = "ch|app_main::D:\\work\\a"
const B = "ch|app_main::D:\\work\\b"
let cardSeq = 0
function finishReply(sessionKey: string, text = "改好了", over: Record<string, unknown> = {}): void {
  chatListener!({
    type: "item",
    sessionKey,
    item: { kind: "assistant", id: `card-${++cardSeq}`, ts: 1, segments: [{ type: "reply", text }], finished: true, ...over },
  } as AppChatEvent)
}
const report = (viewing: unknown) => ipcOn.get("app-chat:viewing")!({}, viewing)
const win = () => windows[0]

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-notify-"))
  packaged = false
  supported = true
  windows = [new FakeWindow()]
  chatListener = null
  ipcOn.clear()
  notifications.length = 0
  aumid.length = 0
  for (const k of Object.keys(titles)) delete titles[k]
  for (const k of Object.keys(projects)) delete projects[k]
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe("回复完成通知：弹不弹", () => {
  it("窗口不在前台：回复完成就弹，标题是会话名，正文是回复开头", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    titles[appChatSessionId(A)] = "修登录"
    finishReply(A, "## 完成\n登录问题已修复")
    expect(notifications).toHaveLength(1)
    expect(notifications[0].opts).toEqual({ title: "修登录", body: "完成 登录问题已修复" })
    expect(notifications[0].shown).toBe(true)
  })

  it("窗口在前台、对话页正停在这个会话上：不弹", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    report(A)
    finishReply(A)
    expect(notifications).toEqual([])
  })

  it("窗口在前台但看的是别的会话：弹", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    report(B)
    finishReply(A)
    expect(notifications).toHaveLength(1)
  })

  it("窗口在前台但不在对话页（上报 null）：弹", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    report(A)
    report(null)
    finishReply(A)
    expect(notifications).toHaveLength(1)
  })

  it("对话页停在这个会话上，但窗口藏到托盘 / 最小化 / 没有焦点：弹", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    report(A)
    win().visible = false
    finishReply(A)
    win().visible = true
    win().minimized = true
    finishReply(A)
    win().minimized = false
    win().focused = false
    finishReply(A)
    expect(notifications).toHaveLength(3)
  })

  it("上报的不是字符串（异常载荷）：当作没在看", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    report(A)
    report({ not: "a string" })
    finishReply(A)
    expect(notifications).toHaveLength(1)
  })

  it("被打断的回合、还没收口的回合：不弹", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    finishReply(A, "停了", { interrupted: true })
    finishReply(A, "写一半", { finished: false })
    expect(notifications).toEqual([])
  })

  it("系统不支持通知，或者已经没有窗口（点了没处可跳）：不弹", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    supported = false
    finishReply(A)
    supported = true
    windows = []
    finishReply(A)
    windows = [Object.assign(new FakeWindow(), { destroyed: true })]
    finishReply(A)
    expect(notifications).toEqual([])
  })
})

describe("回复完成通知：标题叫什么", () => {
  async function titleOf(sessionKey: string, setup?: (store: Store) => void): Promise<string> {
    const { notify, store } = await load()
    notify.initAppChatNotify()
    win().focused = false
    setup?.(store)
    finishReply(sessionKey)
    return notifications[0].opts.title
  }

  it("没有摘要标题：显示目录名", async () => {
    expect(await titleOf(A)).toBe("a")
  })

  it("用户给会话选了目录（临时会话）：显示选的目录名，不是临时文件夹名", async () => {
    const temp = `ch|app_main::${path.join(userData, "workspaces", "temp_1700000000000")}`
    const picked = path.join(userData, "repos", "my-repo")
    const title = await titleOf(temp, (store) => {
      store.initSessionOverridesStore(userData)
      store.patchSessionRecord(temp, { boundDir: picked })
    })
    expect(title).toBe("my-repo")
  })

  it("还没选目录的临时会话：新会话", async () => {
    const temp = `ch|app_main::${path.join(userData, "workspaces", "temp_1700000000001")}`
    expect(await titleOf(temp)).toBe("新会话")
  })

  it("项目会话：显示项目名", async () => {
    projects.p1 = { name: "周报项目" }
    expect(await titleOf("ch|app_main::project_p1")).toBe("周报项目")
  })

  it("项目已经被删、读不到：用兜底名，通知照发", async () => {
    expect(await titleOf("ch|app_main::project_gone")).toBe("应用内会话")
  })
})

describe("点通知", () => {
  it("窗口被唤到前台，并通知界面切到这个会话", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    win().visible = false
    finishReply(A)
    notifications[0].handlers.click()
    expect(win().calls).toEqual(["show", "focus"])
    expect(win().sent).toEqual([{ channel: "app-chat:open-session", payload: A }])
  })

  it("窗口最小化着：先还原再显示", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    win().minimized = true
    finishReply(A)
    notifications[0].handlers.click()
    expect(win().calls).toEqual(["restore", "show", "focus"])
    expect(win().sent).toHaveLength(1)
  })

  it("点的时候窗口已经没了：什么都不做，不报错", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    finishReply(A)
    windows = []
    expect(() => notifications[0].handlers.click()).not.toThrow()
  })

  it("多条通知各带各的会话", async () => {
    const { notify } = await load()
    notify.initAppChatNotify()
    win().focused = false
    finishReply(A)
    finishReply(B)
    notifications[1].handlers.click()
    notifications[0].handlers.click()
    expect(win().sent.map((s) => s.payload)).toEqual([B, A])
  })
})

describe("Windows 通知归属", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value })
  afterEach(() => Object.defineProperty(process, "platform", original))

  it("打包后的 Windows 版：登记和安装包一致的应用 ID", async () => {
    setPlatform("win32")
    packaged = true
    const { notify } = await load()
    notify.initAppChatNotify()
    expect(aumid).toEqual(["com.lk-harness.desktop"])
  })

  it("开发模式、或者不是 Windows：不动应用 ID", async () => {
    setPlatform("win32")
    packaged = false
    ;(await load()).notify.initAppChatNotify()
    setPlatform("darwin")
    packaged = true
    ;(await load()).notify.initAppChatNotify()
    expect(aumid).toEqual([])
  })
})
