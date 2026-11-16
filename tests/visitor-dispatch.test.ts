import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"

/**
 * 访客限制在调度器这一侧：真实的 config-store + session-dispatcher，
 * 只顶掉落盘的 electron-store、electron、假 daemon（内存队列）和假引擎（记下拉起参数、停了谁）。
 * 验证：别人的会话拉起时带上按通道档位算出的限制，主人自己的会话不带；
 * 设置保存后，限制变了的通道里别人正在跑的会话被停掉。
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
const launch = vi.fn(async () => ({ ok: true }))
const engine = {
  launch,
  listSessions: () => listed.map((s) => ({ ...s, runtimeId: "sdk", startedAt: 1, lastActivityAt: 1 })),
  isRunning: (k: string) => running.has(k),
  stop: vi.fn(async (k: string) => { stopped.push(k); running.delete(k) }),
  setIdleHandler: () => {},
}
vi.mock("../electron/agent-engine/factory", async (orig) => {
  const actual = await orig<typeof import("../electron/agent-engine/factory")>()
  return { ...actual, getAllAgentEngines: () => [engine] as never, getAgentEngine: () => engine as never }
})

const CH = "ch_f"
const WS = "D:\\ws\\visitor-main"
const key = (chat: string, ws = WS) => `${CH}|${chat}::${ws}`

let server: http.Server

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "visitor-dispatch-"))
  running.clear()
  listed.length = 0
  stopped.length = 0
  launch.mockClear()
  server = http.createServer((req, res) => {
    req.on("data", () => {})
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.url === "/queue") return void res.end(JSON.stringify({ messages: [] }))
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
    id: CH, name: "飞书", enabled: true, type: "feishu", agentResourceId: "r1", model: "composer-2", modelParams: "",
    othersModel: "", othersModelParams: "", mainUserEnabled: true, mainUserChatId: "oc_main",
    allowOthers: false, digitalIdentity: "", workspaceDir: path.join(userData, "ws"),
    ...extra,
  }
}

async function boot(channelExtra: Record<string, unknown> = {}) {
  vi.resetModules()
  const overrides = await import("../src/shared/session-overrides-store")
  overrides.initSessionOverridesStore(userData)
  const projects = await import("../src/shared/project-store")
  projects.initProjectStore(userData)
  const config = await import("../electron/config-store")
  config.saveConfig({
    agentResources: [{ id: "r1", name: "SDK", type: "sdk", apiKey: "k" }] as never,
    channels: [feishu(channelExtra)] as never,
  })
  const dispatcher = await import("../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  return { dispatcher, config, projects }
}

/** 登记一个以 oc_xxx 为专属群的项目（群聊算「我」的，不受准入和访客限制） */
function addProjectGroup(projects: typeof import("../src/shared/project-store"), rawChatId: string): void {
  const groupChatId = `${CH}|${rawChatId}`
  projects.saveProject({
    id: "p1", name: "项目", goal: "g", repoPath: "", baseBranch: "main", featureBranch: "", worktreePath: "",
    workspaceType: "plain", sessionKey: `${groupChatId}::project_p1`, groupChatId, createdAt: Date.now(), updatedAt: Date.now(),
  } as never)
}

/** 引擎收到的拉起参数里的 visitor（没有 = 不受限） */
function launchedVisitor(): unknown {
  expect(launch).toHaveBeenCalledTimes(1)
  return (launch.mock.calls[0] as unknown as [{ visitor?: unknown }])[0].visitor
}

describe("拉起别人的会话：按通道档位带上访客限制", () => {
  it("别人的私聊 + 访客档：带限制（默认没有本机工具、没有用户 MCP / Skill）", async () => {
    const { dispatcher } = await boot({ othersDm: true, visitorTier: "visitor" })
    const r = await dispatcher.launchSessionAgent(key("oc_stranger"), "p2p", { chatId: `${CH}|oc_stranger` }, false, "ou_x")
    expect(r).toEqual({ ok: true })
    expect(launchedVisitor()).toMatchObject({ mcpAllow: [], skillAllow: [], canRead: false })
    expect((launchedVisitor() as { sdkTools: string[] }).sdkTools).not.toContain("shell")
  })

  it("别人的私聊 + 同我档：不带限制", async () => {
    const { dispatcher } = await boot({ othersDm: true, visitorTier: "full" })
    await dispatcher.launchSessionAgent(key("oc_stranger"), "p2p", { chatId: `${CH}|oc_stranger` }, false, "ou_x")
    expect(launchedVisitor()).toBeUndefined()
  })

  it("主用户自己的私聊：就算通道档位是访客也不带限制", async () => {
    const { dispatcher } = await boot({ othersDm: true, visitorTier: "visitor" })
    await dispatcher.launchSessionAgent(key("oc_main"), "p2p", { chatId: `${CH}|oc_main` }, true, "ou_main")
    expect(launchedVisitor()).toBeUndefined()
  })

  it("群聊 + 访客档 + 额外开放：点名的 MCP / Skill 带进限制，开放 Skill 同时开放 read", async () => {
    const { dispatcher } = await boot({
      groupPolicy: "all", visitorTier: "visitor", visitorMcp: ["notion"], visitorSkills: ["weekly-report"],
    })
    await dispatcher.launchSessionAgent(`${CH}|oc_g1`, "group", { chatId: `${CH}|oc_g1` }, false, "ou_x")
    expect(launchedVisitor()).toMatchObject({ mcpAllow: ["notion"], skillAllow: ["weekly-report"], canRead: true })
  })

  it("项目专属群：算「我」的，就算群聊没开放、档位是访客，也能拉起且不带限制", async () => {
    const { dispatcher, projects } = await boot({ groupPolicy: "off", visitorTier: "visitor" })
    addProjectGroup(projects, "oc_pg")
    const r = await dispatcher.launchSessionAgent(`${CH}|oc_pg`, "group", { chatId: `${CH}|oc_pg` }, false, "ou_x")
    expect(r).toEqual({ ok: true })
    expect(launchedVisitor()).toBeUndefined()
  })

  it("对照：同一个通道里普通的群没开放就拉不起来（上一条的放行来自项目专属群，不是准入失效）", async () => {
    const { dispatcher } = await boot({ groupPolicy: "off", visitorTier: "visitor" })
    const r = await dispatcher.launchSessionAgent(`${CH}|oc_plain`, "group", { chatId: `${CH}|oc_plain` }, false, "ou_x")
    expect(r.ok).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it("升级前 allowOthers=true 的存量通道（迁移为同我档）：别人的会话行为不变，不带限制", async () => {
    const { dispatcher } = await boot({ allowOthers: true })
    await dispatcher.launchSessionAgent(key("oc_stranger"), "p2p", { chatId: `${CH}|oc_stranger` }, false, "ou_x")
    expect(launchedVisitor()).toBeUndefined()
  })

  it("定时任务 / 临时会话归主人：不带限制", async () => {
    const { dispatcher } = await boot({ othersDm: true, visitorTier: "visitor" })
    await dispatcher.launchSessionAgent("temp_1", "temp", { chatId: `${CH}|oc_main` }, true, "ou_main")
    expect(launchedVisitor()).toBeUndefined()
  })
})

describe("restartVisitorSessions / applyChannelPolicyChanges：限制变了就停掉别人正在跑的会话", () => {
  const sessions = () => [
    { sessionKey: key("oc_main"), chatType: "p2p" },
    { sessionKey: key("oc_stranger"), chatType: "p2p" },
    { sessionKey: `${CH}|oc_g1`, chatType: "group" },
    { sessionKey: `${CH}|oc_pg::project_p1`, chatType: "project" },
    { sessionKey: "ch_other|oc_stranger", chatType: "p2p" },
  ]
  const seed = () => { for (const s of sessions()) { listed.push(s); running.add(s.sessionKey) } }

  it("restartVisitorSessions：只停这个通道里别人的私聊和群；主用户、项目、别的通道不动", async () => {
    const { dispatcher } = await boot({ othersDm: true, groupPolicy: "all" })
    seed()
    expect(await dispatcher.restartVisitorSessions(CH)).toBe(2)
    expect(stopped.sort()).toEqual([key("oc_stranger"), `${CH}|oc_g1`].sort())
  })

  it("项目专属群里正在跑的会话不停（它不受访客限制，限制变了也与它无关）", async () => {
    const { dispatcher, projects } = await boot({ othersDm: true, groupPolicy: "all" })
    addProjectGroup(projects, "oc_pg")
    listed.push({ sessionKey: `${CH}|oc_pg`, chatType: "group" }, { sessionKey: `${CH}|oc_g1`, chatType: "group" })
    running.add(`${CH}|oc_pg`); running.add(`${CH}|oc_g1`)
    expect(await dispatcher.restartVisitorSessions(CH)).toBe(1)
    expect(stopped).toEqual([`${CH}|oc_g1`])
  })

  it("没在运行的不重复停", async () => {
    const { dispatcher } = await boot({ othersDm: true, groupPolicy: "all" })
    listed.push({ sessionKey: key("oc_stranger"), chatType: "p2p" })
    expect(await dispatcher.restartVisitorSessions(CH)).toBe(0)
  })

  it("档位从访客改成同我（或相反）：停；什么限制都没变：不停", async () => {
    const { dispatcher, config } = await boot({ othersDm: true, groupPolicy: "all", visitorTier: "visitor" })
    const before = config.getChannels()

    config.updateChannel(CH, { visitorTier: "full" })
    seed()
    await dispatcher.applyChannelPolicyChanges(before, config.getChannels())
    expect(stopped.length).toBe(2)

    stopped.length = 0
    running.clear(); listed.length = 0
    seed()
    const same = config.getChannels()
    config.updateChannel(CH, { name: "改了个名字" })
    await dispatcher.applyChannelPolicyChanges(same, config.getChannels())
    expect(stopped).toEqual([])
  })

  it("额外开放的 MCP / Skill 变了：停", async () => {
    const { dispatcher, config } = await boot({ othersDm: true, visitorTier: "visitor" })
    const before = config.getChannels()
    config.updateChannel(CH, { visitorMcp: ["notion"] })
    seed()
    await dispatcher.applyChannelPolicyChanges(before, config.getChannels())
    expect(stopped).toContain(key("oc_stranger"))

    stopped.length = 0
    running.clear(); listed.length = 0
    seed()
    const mid = config.getChannels()
    config.updateChannel(CH, { visitorSkills: ["s1"] })
    await dispatcher.applyChannelPolicyChanges(mid, config.getChannels())
    expect(stopped).toContain(key("oc_stranger"))
  })

  it("新增的通道没有「变化」，不停任何会话", async () => {
    const { dispatcher, config } = await boot({ othersDm: true, visitorTier: "visitor" })
    seed()
    await dispatcher.applyChannelPolicyChanges([], config.getChannels())
    expect(stopped).toEqual([])
  })

  it("准入收紧也走同一个入口：不再允许的别人的会话被停", async () => {
    const { dispatcher, config } = await boot({ othersDm: true, groupPolicy: "all" })
    const before = config.getChannels()
    config.updateChannel(CH, { othersDm: false })
    seed()
    await dispatcher.applyChannelPolicyChanges(before, config.getChannels())
    expect(stopped).toEqual([key("oc_stranger")])
  })
})
