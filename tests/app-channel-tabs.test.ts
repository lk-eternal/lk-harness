import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { makeChatKey, normalizeSessionKey } from "../src/shared/channel-types"

/**
 * 新建应用内通道后，对话页左侧的会话列表里不能有自动冒出来的目录会话。
 * 真实的 config-store + session-dispatcher 的会话树（listDashboardTree），
 * 只把落盘的 electron-store、electron、假 daemon（只答「当前活跃会话」）和运行中的引擎顶掉。
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
vi.mock("../electron/agent-engine/factory", async (orig) => {
  const actual = await orig<typeof import("../electron/agent-engine/factory")>()
  const engine = { listSessions: () => [], isRunning: () => false, setIdleHandler: () => {} }
  return { ...actual, getAllAgentEngines: () => [engine] as never }
})

// 真实的绝对路径：config-store 会 path.resolve 它们，写死盘符在 Linux/macOS 上会被当成相对路径拼上 cwd
const DIR_ROOT = path.join(os.tmpdir(), "lkh-app-tabs-test")
const MINE = path.join(DIR_ROOT, "mine")
const GLOBAL_DIRS = [path.join(DIR_ROOT, "alpha"), path.join(DIR_ROOT, "beta")]
const APP = "ch_app"
const FEISHU = "ch_fs"
const APP_CHAT = makeChatKey(APP, "app_main")
const FEISHU_CHAT = makeChatKey(FEISHU, "ou_main")

let server: http.Server

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "app-channel-tabs-"))
  server = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(req.url === "/api/active-sessions" ? { sessions: {} } : { ok: true }))
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

function channel(id: string, type: "app" | "feishu") {
  return {
    id, name: id, enabled: true, type, agentResourceId: "", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
    mainUserEnabled: true, mainUserChatId: type === "app" ? "app_main" : "ou_main",
  }
}

/** 全局有常用目录、两个通道都是迁移之后才建的（自己没存过列表），换一套全新的模块实例 */
async function boot() {
  vi.resetModules()
  // 会话 tab 要读会话级的模型覆盖；这个存储没初始化就抛错（真实应用启动时会初始化）。
  // 不能靠本机恰好设了 APP_DATA_DIR 环境变量混过去——那样读的是真实数据目录，CI 上则直接报错
  const overrides = await import("../src/shared/session-overrides-store")
  overrides.initSessionOverridesStore(userData)
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [channel(APP, "app"), channel(FEISHU, "feishu")] as never,
    favoriteWorkspaces: GLOBAL_DIRS,
    favWorkspacesMigrated: true,
  })
  const dispatcher = await import("../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  const tabsOf = async (channelId: string) => {
    const tree = await dispatcher.listDashboardTree()
    expect(tree.ok).toBe(true)
    // 会话树里「没读到 daemon 锁文件」和「某个通道构建时抛错」都会静默变成空列表；
    // 不先排除这两种，下面「是空的」的断言会空过（之前就在这上面踩过一次）
    expect(tree.error, "会话树报错（没读到 daemon 锁文件）").toBeUndefined()
    const tabs = tree.channels.find((c) => c.channelId === channelId)!.mainTabs
    if (tabs.length === 0) {
      // 直接走同一套构建（它不吞错）：构建抛错时，真正的原因在这里露出来
      await dispatcher.listMainSessionTabs()
    }
    return tabs
  }
  return { config, tabsOf }
}

const keyFor = (chat: string, dir: string) => normalizeSessionKey(`${chat}::${dir}`)

describe("新建的应用内通道，会话列表是空的", () => {
  it("全局有常用目录，应用内通道的会话树里没有任何目录会话", async () => {
    const { tabsOf } = await boot()
    expect(await tabsOf(APP)).toEqual([])
  })

  it("用户自己选了一个目录之后，只出现这一个", async () => {
    const { config, tabsOf } = await boot()
    config.setChannelFavoriteWorkspaces(APP, [...config.getChannelFavoriteWorkspaces(config.getChannel(APP)), MINE])
    const tabs = await tabsOf(APP)
    expect(tabs.map((t) => [t.sessionKey, t.kind])).toEqual([[keyFor(APP_CHAT, MINE), "dir"]])
  })

  it("飞书通道没存过列表时不变：全局常用目录仍列出来（手机上 /c 切换用）", async () => {
    const { tabsOf } = await boot()
    const tabs = await tabsOf(FEISHU)
    expect(tabs.map((t) => t.sessionKey).sort()).toEqual(GLOBAL_DIRS.map((d) => keyFor(FEISHU_CHAT, d)).sort())
  })
})
