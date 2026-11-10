import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { APP_CHANNEL_CHAT_ID, makeChatKey, normalizeSessionKey } from "../src/shared/channel-types"
import { appChatSessionId } from "../src/shared/app-chat-types"
import { isTempChatWorkspace } from "../src/shared/temp-workspace"

/**
 * 应用内会话的工作目录是会话的属性，不是会话的身份：
 * 临时会话可以选任意目录（多个会话共用同一个目录），Agent 以该目录为 cwd 启动。
 * 真实的 config-store + app-chat + session-dispatcher（会话树、真实 launchAgent），
 * 只把落盘的 electron-store、electron、假 daemon 和引擎顶掉。
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
  clipboard: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const launches: { sessionKey: string; workspaceDir: string }[] = []
vi.mock("../electron/agent-engine/factory", async (orig) => {
  const actual = await orig<typeof import("../electron/agent-engine/factory")>()
  const engine = {
    listSessions: () => [],
    isRunning: () => false,
    setIdleHandler: () => {},
    launch: async (p: { sessionKey: string; workspaceDir: string }) => {
      launches.push({ sessionKey: p.sessionKey, workspaceDir: p.workspaceDir })
      return { ok: true }
    },
  }
  return { ...actual, getAllAgentEngines: () => [engine] as never, getAgentEngine: () => engine as never }
})

const ROOT = path.join(os.tmpdir(), "lkh-app-session-dir-test")
const APP = "ch_app"
const FEISHU = "ch_fs"
const APP_CHAT = makeChatKey(APP, APP_CHANNEL_CHAT_ID)

let server: http.Server
/** 假 daemon 认为「已经有聊天记录」的会话（会话已开始） */
let startedKeys: string[] = []
let projectDir = ""

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "app-session-dir-"))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-session-dir-proj-"))
  startedKeys = []
  launches.length = 0
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url === "/api/active-sessions") return res.end(JSON.stringify({ sessions: {} }))
      if (req.url === "/api/app-chat/last-active") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { sessionKeys?: string[] }
        const times: Record<string, number> = {}
        for (const k of body.sessionKeys ?? []) {
          if (startedKeys.some((s) => normalizeSessionKey(s) === normalizeSessionKey(k))) times[appChatSessionId(k)] = Date.now()
        }
        return res.end(JSON.stringify({ ok: true, times }))
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as { port: number }
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function channel(id: string, type: "app" | "feishu") {
  return {
    id, name: id, enabled: true, type, agentResourceId: "sdk_t", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
    mainUserEnabled: true, mainUserChatId: type === "app" ? APP_CHANNEL_CHAT_ID : "ou_main",
  }
}

async function boot() {
  vi.resetModules()
  const overrides = await import("../src/shared/session-overrides-store")
  overrides.initSessionOverridesStore(userData)
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [channel(APP, "app"), channel(FEISHU, "feishu")] as never,
    agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
    favWorkspacesMigrated: true,
  })
  const appChat = await import("../electron/app-chat")
  const dispatcher = await import("../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  const boundDirOf = (sessionKey: string) => overrides.getSessionRecord(sessionKey)?.boundDir
  const newTemp = (dir?: string) => appChat.createAppChatTempSession(APP, dir)
  /** 会话开始后 daemon 里会有它的路由登记，会话树里才有这个 tab */
  const route = (sessionKey: string) => {
    const file = path.join(userData, "sessions", "_global", "routing.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as { sessionToChat?: Record<string, string> } : {}
    fs.writeFileSync(file, JSON.stringify({ ...prev, sessionToChat: { ...prev.sessionToChat, [sessionKey]: APP_CHAT } }))
  }
  const tabs = async () => {
    const tree = await dispatcher.listDashboardTree()
    expect(tree.error, "会话树报错（没读到 daemon 锁文件）").toBeUndefined()
    return tree.channels.find((c) => c.channelId === APP)!.mainTabs
  }
  const launch = (sessionKey: string) =>
    dispatcher.launchSessionAgent(sessionKey, "p2p", { chatType: "p2p", chatId: APP_CHAT }, true)
  return { appChat, config, boundDirOf, newTemp, route, tabs, launch }
}

describe("新建会话时直接选目录", () => {
  it("带目录新建：会话记下这个目录，临时文件夹照常建好", async () => {
    const { newTemp, boundDirOf } = await boot()
    const r = newTemp(projectDir)
    expect(r.ok).toBe(true)
    expect(isTempChatWorkspace(r.sessionKey?.split("::")[1])).toBe(true)
    expect(boundDirOf(r.sessionKey!)).toBe(path.resolve(projectDir))
  })

  it("同一个目录可以新建多个会话，各记各的", async () => {
    const { newTemp, boundDirOf } = await boot()
    const a = newTemp(projectDir)
    const b = newTemp(projectDir)
    expect(a.sessionKey).not.toBe(b.sessionKey)
    expect(boundDirOf(a.sessionKey!)).toBe(boundDirOf(b.sessionKey!))
  })

  it("不带目录新建：和以前一样，什么都没记", async () => {
    const { newTemp, boundDirOf } = await boot()
    const r = newTemp()
    expect(r.ok).toBe(true)
    expect(boundDirOf(r.sessionKey!)).toBeUndefined()
  })

  it("目录不存在、不是目录、不是绝对路径：报错，也不留下空的临时文件夹", async () => {
    const { newTemp } = await boot()
    const file = path.join(projectDir, "a.txt")
    fs.writeFileSync(file, "x")
    for (const bad of [path.join(projectDir, "nope"), file, "relative/dir", ""]) {
      const r = newTemp(bad)
      expect(r.ok, `应该拒绝 ${JSON.stringify(bad)}`).toBe(false)
      expect(r.error).toBeTruthy()
    }
    const wsRoot = path.join(userData, "workspaces")
    expect(fs.existsSync(wsRoot) ? fs.readdirSync(wsRoot) : []).toEqual([])
  })
})

describe("给还没开始的临时会话改选目录", () => {
  it("选好目录后记在会话上，可以再改选", async () => {
    const { appChat, newTemp, boundDirOf } = await boot()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "app-session-dir-other-"))
    try {
      const { sessionKey } = newTemp()
      expect((await appChat.setAppChatSessionDir(sessionKey!, projectDir)).ok).toBe(true)
      expect(boundDirOf(sessionKey!)).toBe(path.resolve(projectDir))
      expect((await appChat.setAppChatSessionDir(sessionKey!, other)).ok).toBe(true)
      expect(boundDirOf(sessionKey!)).toBe(path.resolve(other))
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it("会话已经开始（有聊天记录）就不能再换，原来的目录保持不变", async () => {
    const { appChat, newTemp, boundDirOf } = await boot()
    const { sessionKey } = newTemp(projectDir)
    startedKeys.push(sessionKey!)
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "app-session-dir-other-"))
    try {
      const r = await appChat.setAppChatSessionDir(sessionKey!, other)
      expect(r.ok).toBe(false)
      expect(r.error).toContain("已经开始")
      expect(boundDirOf(sessionKey!)).toBe(path.resolve(projectDir))
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it("键里带真实目录的会话（常用目录）目录就是它的身份，不能改", async () => {
    const { appChat, boundDirOf } = await boot()
    const dirKey = normalizeSessionKey(`${APP_CHAT}::${projectDir}`)
    const r = await appChat.setAppChatSessionDir(dirKey, os.tmpdir())
    expect(r.ok).toBe(false)
    expect(boundDirOf(dirKey)).toBeUndefined()
  })

  it("不是应用内通道的会话不处理", async () => {
    const { appChat, boundDirOf } = await boot()
    const feishuKey = normalizeSessionKey(`${makeChatKey(FEISHU, "ou_main")}::${path.join(userData, "workspaces", "temp_1700000000000")}`)
    const r = await appChat.setAppChatSessionDir(feishuKey, projectDir)
    expect(r.ok).toBe(false)
    expect(boundDirOf(feishuKey)).toBeUndefined()
  })

  it("目录不存在：报错，已选的目录不被冲掉", async () => {
    const { appChat, newTemp, boundDirOf } = await boot()
    const { sessionKey } = newTemp(projectDir)
    const r = await appChat.setAppChatSessionDir(sessionKey!, path.join(projectDir, "nope"))
    expect(r.ok).toBe(false)
    expect(boundDirOf(sessionKey!)).toBe(path.resolve(projectDir))
  })

  it("daemon 不可用，没法确认会话有没有开始：宁可不改", async () => {
    const { appChat, newTemp, boundDirOf } = await boot()
    const { sessionKey } = newTemp()
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    const r = await appChat.setAppChatSessionDir(sessionKey!, projectDir)
    expect(r.ok).toBe(false)
    expect(boundDirOf(sessionKey!)).toBeUndefined()
  })
})

describe("会话树里的工作目录", () => {
  it("选了目录的临时会话带 boundDir，标签是目录名；没选的不带", async () => {
    const { newTemp, route, tabs } = await boot()
    const bound = newTemp(projectDir).sessionKey!
    const plain = newTemp().sessionKey!
    route(bound)
    route(plain)
    const byKey = new Map((await tabs()).map((t) => [t.sessionKey, t]))
    const boundTab = byKey.get(normalizeSessionKey(bound))!
    const plainTab = byKey.get(normalizeSessionKey(plain))!
    expect(boundTab.boundDir).toBe(path.resolve(projectDir))
    expect(boundTab.label.startsWith(path.basename(projectDir))).toBe(true)
    expect(plainTab.boundDir).toBeUndefined()
    expect(plainTab.label.startsWith("temp_")).toBe(true)
  })

  it("两个会话共用同一个目录：会话树里是两个独立的 tab", async () => {
    const { newTemp, route, tabs } = await boot()
    const a = newTemp(projectDir).sessionKey!
    const b = newTemp(projectDir).sessionKey!
    route(a)
    route(b)
    const list = (await tabs()).filter((t) => t.boundDir)
    expect(list.map((t) => t.sessionKey).sort()).toEqual([normalizeSessionKey(a), normalizeSessionKey(b)].sort())
  })
})

describe("Agent 的启动目录", () => {
  it("选了目录的会话：以这个目录为 cwd 启动，不是临时文件夹", async () => {
    const { newTemp, launch } = await boot()
    const { sessionKey } = newTemp(projectDir)
    const r = await launch(sessionKey!)
    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(launches).toHaveLength(1)
    expect(launches[0].workspaceDir).toBe(path.resolve(projectDir))
  })

  it("同一个目录的两个会话各自启动，cwd 都是这个目录", async () => {
    const { newTemp, launch } = await boot()
    const a = newTemp(projectDir).sessionKey!
    const b = newTemp(projectDir).sessionKey!
    expect((await launch(a)).ok).toBe(true)
    expect((await launch(b)).ok).toBe(true)
    expect(launches.map((l) => l.sessionKey).sort()).toEqual([normalizeSessionKey(a), normalizeSessionKey(b)].sort())
    expect(launches.every((l) => l.workspaceDir === path.resolve(projectDir))).toBe(true)
  })

  it("没选目录的临时会话：仍然在自己的临时文件夹里启动", async () => {
    const { newTemp, launch } = await boot()
    const { sessionKey } = newTemp()
    expect((await launch(sessionKey!)).ok).toBe(true)
    expect(isTempChatWorkspace(launches[0].workspaceDir)).toBe(true)
  })

  it("选的目录后来没了：启动失败并说明原因，不会悄悄新建空目录、也不会退回临时文件夹", async () => {
    const { newTemp, launch } = await boot()
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "app-session-dir-gone-"))
    const { sessionKey } = newTemp(gone)
    fs.rmSync(gone, { recursive: true, force: true })
    const r = await launch(sessionKey!)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("不存在")
    expect(launches).toHaveLength(0)
    expect(fs.existsSync(gone)).toBe(false)
  })
})
