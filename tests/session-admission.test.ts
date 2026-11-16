import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"

/**
 * 准入的第二道闸（调度器这一侧）：真实的 config-store + session-dispatcher，
 * 只顶掉落盘的 electron-store、electron、假 daemon（内存队列）和假引擎（记停了谁）。
 *
 * 第一道闸在 daemon 入口，被拒的消息根本不入队（见 inbound-access-gate.test.ts）。
 * 这里管的是漏网的：升级前就在队列里的、设置后来才关掉的、还在运行的别人的会话。
 */

let userData = ""
let disk: Record<string, unknown> = {}
vi.mock("electron-store", () => ({
  default: class {
    constructor(opts: { defaults?: Record<string, unknown> }) {
      disk = structuredClone(opts.defaults ?? {})
    }
    get store() { return disk }
    set(patch: Record<string, unknown>) { Object.assign(disk, structuredClone(patch)) }
  },
}))
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const running = new Set<string>()
const listed: Array<{ sessionKey: string; chatType: string }> = []
const stopped: string[] = []
const engine = {
  listSessions: () => listed.map((s) => ({ ...s, runtimeId: "sdk", startedAt: 1, lastActivityAt: 1 })),
  isRunning: (k: string) => running.has(k),
  stop: vi.fn(async (k: string) => { stopped.push(k); running.delete(k) }),
  setIdleHandler: () => {},
}
vi.mock("../electron/agent-engine/factory", async (orig) => {
  const actual = await orig<typeof import("../electron/agent-engine/factory")>()
  return { ...actual, getAllAgentEngines: () => [engine] as never }
})

const CH = "ch_f"
const WS = "D:\\ws\\admission-main"
const key = (chat: string, ws = WS) => `${CH}|${chat}::${ws}`

interface QMsg { fileId: string; sessionKey: string; chatType: string; messageId: string; preview: string; index: number }
let server: http.Server
let queue: QMsg[] = []
let deleted: string[] = []
let chats: Array<{ sessionKey: string; chatType: string; hasPending?: boolean }> = []

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "session-admission-"))
  queue = []
  deleted = []
  chats = []
  running.clear()
  listed.length = 0
  stopped.length = 0
  server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url === "/queue") return void res.end(JSON.stringify({ messages: queue }))
      if (req.url === "/queue-chat-ids") return void res.end(JSON.stringify({ chats }))
      if (req.url === "/queue-delete") {
        const { fileId } = JSON.parse(body || "{}") as { fileId: string }
        deleted.push(fileId)
        queue = queue.filter((m) => m.fileId !== fileId)
        return void res.end(JSON.stringify({ ok: true }))
      }
      res.end(JSON.stringify({ ok: true, sessions: {} }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as { port: number }
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(userData, { recursive: true, force: true })
})

function feishu(extra: Record<string, unknown> = {}) {
  return {
    id: CH, name: "飞书", enabled: true, type: "feishu", agentResourceId: "", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: true, mainUserChatId: "oc_main",
    allowOthers: false, digitalIdentity: "", workspaceDir: WS,
    ...extra,
  }
}

async function boot(channelExtra: Record<string, unknown> = {}, otherChannels: Array<Record<string, unknown>> = []) {
  vi.resetModules()
  const overrides = await import("../src/shared/session-overrides-store")
  overrides.initSessionOverridesStore(userData)
  const projects = await import("../src/shared/project-store")
  projects.initProjectStore(userData)
  const config = await import("../electron/config-store")
  config.saveConfig({ channels: [feishu(channelExtra), ...otherChannels] as never })
  const dispatcher = await import("../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  return { dispatcher, config, projects }
}

const msg = (i: number, sessionKey: string, chatType: string): QMsg =>
  ({ fileId: `f${i}.qmsg`, sessionKey, chatType, messageId: `om_${i}`, preview: "hi", index: i })

describe("checkSessionAdmission", () => {
  it("别人的私聊：看「其他人私聊」开关；主用户私聊永远放行", async () => {
    const { dispatcher, config } = await boot({ othersDm: false, groupPolicy: "off" })
    expect(dispatcher.checkSessionAdmission(key("oc_main"), "p2p")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission(key("oc_x"), "p2p")).toEqual({ ok: false, reason: "dm-off" })
    config.updateChannel(CH, { othersDm: true })
    expect(dispatcher.checkSessionAdmission(key("oc_x"), "p2p")).toEqual({ ok: true })
  })

  it("群聊：不允许 / 仅名单 / 所有群", async () => {
    const { dispatcher, config } = await boot({ othersDm: true, groupPolicy: "off" })
    const g = `${CH}|oc_g1`
    expect(dispatcher.checkSessionAdmission(g, "group")).toEqual({ ok: false, reason: "group-off" })
    config.updateChannel(CH, { groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_g1" }] })
    expect(dispatcher.checkSessionAdmission(g, "group")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission(`${CH}|oc_g2`, "group")).toEqual({ ok: false, reason: "group-not-allowed" })
    config.updateChannel(CH, { groupPolicy: "all" })
    expect(dispatcher.checkSessionAdmission(`${CH}|oc_g2`, "group")).toEqual({ ok: true })
  })

  it("群聊策略关着时，只开私聊不放行群；群聊开着时，私聊开关不影响群", async () => {
    const { dispatcher } = await boot({ othersDm: true, groupPolicy: "off" })
    expect(dispatcher.checkSessionAdmission(`${CH}|oc_g1`, "group")).toMatchObject({ ok: false })
    const b = await boot({ othersDm: false, groupPolicy: "all" })
    expect(b.dispatcher.checkSessionAdmission(`${CH}|oc_g1`, "group")).toEqual({ ok: true })
    expect(b.dispatcher.checkSessionAdmission(key("oc_x"), "p2p")).toMatchObject({ ok: false })
  })

  it("项目会话（含项目专属群）、定时任务、临时会话：不管准入怎么设都放行", async () => {
    const { dispatcher } = await boot({ othersDm: false, groupPolicy: "off" })
    expect(dispatcher.checkSessionAdmission(`${CH}|oc_g1::project_abc`, "group")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission(`${CH}|oc_x::project_abc`, "p2p")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission("task_1", "task")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission("temp_1", "temp")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission(key("oc_x"), undefined)).toEqual({ ok: true })
  })

  it("找不到通道 / 应用内通道：不拦（交给启动路径报错，不在这里悄悄吞消息）", async () => {
    const { dispatcher } = await boot({}, [{ ...feishu(), id: "ch_app", type: "app", name: "应用内", mainUserChatId: "app_main" }])
    expect(dispatcher.checkSessionAdmission("ch_gone|oc_x::D:\\ws", "p2p")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission("ch_app|app_main::D:\\ws", "p2p")).toEqual({ ok: true })
  })

  it("升级前 allowOthers=true 的存量通道：别人的私聊和任何群都照常放行", async () => {
    const { dispatcher } = await boot({ allowOthers: true })
    expect(dispatcher.checkSessionAdmission(key("oc_x"), "p2p")).toEqual({ ok: true })
    expect(dispatcher.checkSessionAdmission(`${CH}|oc_any`, "group")).toEqual({ ok: true })
  })
})

describe("enforceChannelAccess：准入收紧后清理", () => {
  it("只停不再被允许的别人的会话，主用户 / 仍然放行的群不受影响", async () => {
    const { dispatcher } = await boot({ othersDm: false, groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_ok" }] })
    const sessions = [
      { sessionKey: key("oc_main"), chatType: "p2p" },
      { sessionKey: key("oc_stranger"), chatType: "p2p" },
      { sessionKey: `${CH}|oc_ok`, chatType: "group" },
      { sessionKey: `${CH}|oc_removed`, chatType: "group" },
      { sessionKey: `${CH}|oc_g::project_p1`, chatType: "project" },
      { sessionKey: "ch_other|oc_stranger", chatType: "p2p" },
    ]
    for (const s of sessions) { listed.push(s); running.add(s.sessionKey) }

    const r = await dispatcher.enforceChannelAccess(CH)
    expect(r.stopped).toBe(2)
    expect(stopped.sort()).toEqual([key("oc_stranger"), `${CH}|oc_removed`].sort())
  })

  it("积压消息：被拒会话的全部丢掉，放行的会话不动；别的通道不碰", async () => {
    const { dispatcher } = await boot({ othersDm: false, groupPolicy: "off" })
    queue = [
      msg(1, key("oc_main"), "p2p"),
      msg(2, key("oc_stranger"), "p2p"),
      msg(3, key("oc_stranger"), "p2p"),
      msg(4, `${CH}|oc_g1`, "group"),
      msg(5, "ch_other|oc_stranger::D:\\x", "p2p"),
    ]
    const r = await dispatcher.enforceChannelAccess(CH)
    expect(r.dropped).toBe(3)
    expect(deleted.sort()).toEqual(["f2.qmsg", "f3.qmsg", "f4.qmsg"])
    expect(queue.map((m) => m.fileId).sort()).toEqual(["f1.qmsg", "f5.qmsg"])
  })

  it("没有要清的：什么都不做", async () => {
    const { dispatcher } = await boot({ othersDm: true, groupPolicy: "all" })
    queue = [msg(1, key("oc_stranger"), "p2p"), msg(2, `${CH}|oc_g1`, "group")]
    listed.push({ sessionKey: key("oc_stranger"), chatType: "p2p" })
    running.add(key("oc_stranger"))
    expect(await dispatcher.enforceChannelAccess(CH)).toEqual({ stopped: 0, dropped: 0 })
    expect(deleted).toEqual([])
    expect(stopped).toEqual([])
  })

  it("会话已经自己结束了（没在运行）：不重复停", async () => {
    const { dispatcher } = await boot({ othersDm: false, groupPolicy: "off" })
    listed.push({ sessionKey: key("oc_stranger"), chatType: "p2p" })
    expect((await dispatcher.enforceChannelAccess(CH)).stopped).toBe(0)
  })
})

describe("调度循环：积压的被拒消息直接丢弃，不起 Agent、不通知", () => {
  it("别人的私聊和未开通的群：积压全删；没有给对方发任何通知", async () => {
    const { dispatcher } = await boot({ othersDm: false, groupPolicy: "off" })
    const sk = key("oc_stranger")
    const gk = `${CH}|oc_g1`
    queue = [msg(1, sk, "p2p"), msg(2, sk, "p2p"), msg(3, gk, "group")]
    chats = [{ sessionKey: sk, chatType: "p2p", hasPending: true }, { sessionKey: gk, chatType: "group", hasPending: true }]

    await dispatcher.dispatchSessionAgents()

    expect(deleted.sort()).toEqual(["f1.qmsg", "f2.qmsg", "f3.qmsg"])
    expect(queue).toEqual([])
    expect(stopped).toEqual([])
  })

  it("别人的会话在开放后不被删（仍在名单里的群）", async () => {
    const { dispatcher } = await boot({ othersDm: false, groupPolicy: "allowlist", allowedGroups: [{ chatId: "oc_g1" }] })
    const gk = `${CH}|oc_g1`
    queue = [msg(1, gk, "group")]
    chats = [{ sessionKey: gk, chatType: "group", hasPending: true }]
    // 放行的会话会走到真正的拉起流程；这里只看它没有被当作被拒的积压丢掉
    await dispatcher.dispatchSessionAgents().catch(() => {})
    expect(deleted).toEqual([])
  })
})
