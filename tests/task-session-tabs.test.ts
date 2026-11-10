import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { makeChatKey } from "../src/shared/channel-types"
import { configDir } from "../src/shared/data-paths"
import { globalRoutingPath } from "../src/shared/session-entry-paths"
import { findScheduledTaskBySessionKey, isOrphanTaskSessionKey, type ScheduledTask } from "../src/shared/scheduled-task"

/**
 * 定时任务的会话键是裸的任务 id，daemon 每次投递都会把它登记到所属聊天的路由里。
 * 任务跑完（AI 排程跑满次数）或被删之后，这条登记还在，但任务表里已经没有这个任务了：
 * 对话页的会话列表把它当成一个会话列出来，点删除只会报「不是应用内对话的会话」。
 * 真实的 config-store + session-dispatcher 会话树；只顶掉落盘的 electron-store、electron、假 daemon 和运行中的引擎。
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

const APP = "ch_app"
const APP_CHAT = makeChatKey(APP, "app_main")
const ENDED = "ai-61db5c69-3"
const LIVE = "ai-aaaa1111-0"

let server: http.Server

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "task-session-tabs-"))
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

function task(id: string, name: string): ScheduledTask {
  return { id, name, cron: "*/5 * * * *", content: "x", enabled: true } as ScheduledTask
}

/** 路由表里登记了两个任务会话（一个任务还在、一个已经跑完被清掉），任务表里只剩还在的那个 */
async function boot(opts: { tasksFile?: "ok" | "corrupt" } = {}) {
  fs.mkdirSync(configDir(userData), { recursive: true })
  const tasksPath = path.join(configDir(userData), "scheduled-tasks.json")
  fs.writeFileSync(tasksPath, opts.tasksFile === "corrupt" ? "{ not json" : JSON.stringify([task(LIVE, "每天看日志")]))
  const routing = globalRoutingPath(userData)
  fs.mkdirSync(path.dirname(routing), { recursive: true })
  fs.writeFileSync(routing, JSON.stringify({ sessionToChat: { [ENDED]: APP_CHAT, [LIVE]: APP_CHAT } }))

  vi.resetModules()
  // 会话 tab 要读会话级的模型覆盖；这个存储没初始化就抛错（真实应用启动时会初始化）。
  // 不能靠本机恰好设了 APP_DATA_DIR 环境变量混过去——那样读的是真实数据目录，CI 上则直接报错
  const overrides = await import("../src/shared/session-overrides-store")
  overrides.initSessionOverridesStore(userData)
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [{
      id: APP, name: "应用内", enabled: true, type: "app", agentResourceId: "", model: "auto", modelParams: "",
      othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
      mainUserEnabled: true, mainUserChatId: "app_main",
    }] as never,
  })
  const dispatcher = await import("../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  const tabs = async () => {
    const tree = await dispatcher.listDashboardTree()
    expect(tree.ok).toBe(true)
    return tree.channels.find((c) => c.channelId === APP)!.mainTabs
  }
  return { tabs }
}

describe("isOrphanTaskSessionKey：任务会话键的形状还在、任务已经没了", () => {
  const tasks = [task("t1", "a")]
  it("裸 id 且任务表里没有 → 是", () => {
    expect(isOrphanTaskSessionKey("gone", tasks)).toBe(true)
    expect(isOrphanTaskSessionKey("gone", [])).toBe(true)
  })
  it("任务还在 → 不是", () => {
    expect(isOrphanTaskSessionKey("t1", tasks)).toBe(false)
  })
  it("带通道前缀或目录的聊天会话、项目会话、临时会话，不管任务表怎样都不是", () => {
    // 最后两个是没有通道前缀的老式键（聊天 id::目录 / 聊天 id::项目）
    for (const k of ["ch_a|app_main", "ch_a|app_main::D:\\x", "ch_a|oc_1::project_abc", "ch_a|app_main::C:\\ws\\temp_1700000000000", "oc_old::D:\\work\\dir", "oc_old::project_abc"]) {
      expect(isOrphanTaskSessionKey(k, [])).toBe(false)
    }
  })
  it("裸的 temp_* 是临时会话，不是任务，也不是孤儿", () => {
    expect(isOrphanTaskSessionKey("temp_1a2b3c4d", [])).toBe(false)
  })
  it("空键不是", () => {
    expect(isOrphanTaskSessionKey("", [])).toBe(false)
    expect(isOrphanTaskSessionKey("  ", [])).toBe(false)
  })
  it("和「找任务」同一口径：找得到的一定不是孤儿", () => {
    for (const k of ["t1", "t2", "ch|x", "a::b"]) {
      expect(isOrphanTaskSessionKey(k, tasks) && !!findScheduledTaskBySessionKey(k, tasks)).toBe(false)
    }
  })
})

describe("任务跑完后留下的会话键不进会话列表", () => {
  it("已经没有的任务：不列出来（也就没有一个删不掉的会话）", async () => {
    const { tabs } = await boot()
    expect((await tabs()).map((t) => t.sessionKey)).not.toContain(ENDED)
  })

  it("还在的任务照旧：作为 task 类的 tab 在树里（对话页和工作台按 kind 自己过滤，运行中的任务靠它取名字）", async () => {
    const { tabs } = await boot()
    const live = (await tabs()).find((t) => t.sessionKey === LIVE)
    expect(live?.kind).toBe("task")
    expect(live?.label).toContain("每天看日志")
  })

  it("任务文件读不出来时只是先不列，什么都不删：路由里的登记原样在，文件修好后就回来", async () => {
    const { tabs } = await boot({ tasksFile: "corrupt" })
    expect((await tabs()).map((t) => t.sessionKey)).not.toContain(ENDED)
    const routing = JSON.parse(fs.readFileSync(globalRoutingPath(userData), "utf8")) as { sessionToChat: Record<string, string> }
    expect(Object.keys(routing.sessionToChat).sort()).toEqual([ENDED, LIVE].sort())
    // 文件恢复后，还在的任务重新出现
    fs.writeFileSync(path.join(configDir(userData), "scheduled-tasks.json"), JSON.stringify([task(LIVE, "每天看日志")]))
    expect((await tabs()).map((t) => t.sessionKey)).toContain(LIVE)
  })
})
