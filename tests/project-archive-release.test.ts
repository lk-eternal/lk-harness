import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { APP_CHANNEL_CHAT_ID, makeChatKey, normalizeSessionKey } from "../src/shared/channel-types"
import { projectSessionKey } from "../src/shared/project-types"

/**
 * 项目归档后，停在它上面的飞书 / 微信聊天要挪回主会话。
 * 现场：一个应用内建的项目归档后，飞书私聊的当前会话还停在它上面一天，
 * 私聊里再发普通消息会进这个已归档项目的会话，任务结果的卡片也被标成它发的。
 * 真实的 config-store、project-store、project-create、session-dispatcher，
 * 只把落盘的 electron-store、electron 和假 daemon（答「各聊天当前会话」、记录挪会话的请求）顶掉。
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
  shell: { trashItem: async () => {} },
  dialog: {},
  clipboard: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const APP = "ch_app"
const FEISHU = "ch_fs"
const APP_CHAT = makeChatKey(APP, APP_CHANNEL_CHAT_ID)
const FEISHU_CHAT = makeChatKey(FEISHU, "ou_main")
const FEISHU_GROUP = makeChatKey(FEISHU, "oc_group_a")
const FEISHU_OTHER_GROUP = makeChatKey(FEISHU, "oc_group_b")

let server: http.Server
let port = 0
let mainDir = ""
/** 假 daemon 答的「各聊天当前会话」 */
let activeSessions: Record<string, string> = {}
let gets = 0
let moves: { chatId: string; sessionKey: string }[] = []

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "proj-archive-"))
  mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-archive-main-"))
  activeSessions = {}
  gets = 0
  moves = []
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.method === "GET" && req.url === "/api/active-sessions") {
        gets++
        res.end(JSON.stringify({ sessions: activeSessions }))
        return
      }
      if (req.method === "POST" && req.url === "/api/active-session") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { chatId: string; sessionKey: string }
        moves.push(body)
        activeSessions[body.chatId] = body.sessionKey
      }
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  port = (server.address() as { port: number }).port
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  if (server.listening) await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(mainDir, { recursive: true, force: true })
})

function channel(id: string, type: "app" | "feishu") {
  return {
    id, name: id, enabled: true, type, agentResourceId: "sdk_t", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "",
    workspaceDir: type === "feishu" ? mainDir : "",
    mainUserEnabled: true, mainUserChatId: type === "app" ? APP_CHANNEL_CHAT_ID : "ou_main",
  }
}

async function boot() {
  vi.resetModules()
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [channel(APP, "app"), channel(FEISHU, "feishu")] as never,
    agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
    favWorkspacesMigrated: true,
  })
  const store = await import("../src/shared/project-store")
  store.initProjectStore(userData)
  const create = await import("../electron/project-create")
  const dispatcher = await import("../electron/session-dispatcher")
  const mk = (name: string, over: Record<string, unknown> = {}) =>
    store.createProject({
      name, goal: "g", repoPath: "/r", baseBranch: "main", featureBranch: `feature/${name}`,
      worktreePath: path.join(userData, `wt-${name}`), ...over,
    })
  return { store, create, dispatcher, mk }
}

/** mainDir 是每个用例前新建的，所以现算 */
const mainKeyOf = (chat: string) => normalizeSessionKey(`${chat}::${mainDir}`)

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}
type Boot = Awaited<ReturnType<typeof boot>>

/**
 * 「什么都没发生」没法靠多等一会儿来证明（等多久都可能不够，偶尔就漏过回归）。改用对照：
 * 再归档一个一定会触发的项目，等它的挪会话落地。它的请求排在前面那一步之后，
 * 前面那一步要是偷偷发过请求，这时一定已经留下痕迹；之后只该多出对照自己的一次读和一次挪。
 */
async function runControl({ create, mk }: Pick<Boot, "create" | "mk">): Promise<void> {
  const ctl = mk("对照")
  activeSessions[FEISHU_OTHER_GROUP] = projectSessionKey(FEISHU_OTHER_GROUP, ctl.id)
  create.setProjectArchivedByUser(ctl.id, true)
  expect(await waitFor(() => moves.some((m) => m.chatId === FEISHU_OTHER_GROUP))).toBe(true)
}
const movedChats = () => moves.map((m) => m.chatId)

describe("releaseProjectRoutes：挪走谁、不动谁", () => {
  it("飞书私聊停在这个项目上：挪回通道的主目录会话", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql")
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    expect(await dispatcher.releaseProjectRoutes(port, p)).toEqual([FEISHU_CHAT])
    expect(moves).toEqual([{ chatId: FEISHU_CHAT, sessionKey: mainKeyOf(FEISHU_CHAT) }])
  })

  it("私聊停在别的项目、目录会话、主会话上：都不动", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql")
    const other = mk("别的")
    for (const sk of [projectSessionKey(FEISHU_CHAT, other.id), `${FEISHU_CHAT}::${mainDir}`, FEISHU_CHAT]) {
      activeSessions = { [FEISHU_CHAT]: sk }
      expect(await dispatcher.releaseProjectRoutes(port, p)).toEqual([])
    }
    expect(moves).toEqual([])
  })

  it("项目 id 只是前缀相同的另一个项目：不误伤", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql", { id: "8b75777e7d36" })
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, "8b75777e7d36a") }
    expect(await dispatcher.releaseProjectRoutes(port, p)).toEqual([])
    expect(moves).toEqual([])
  })

  it("应用内通道的指针不动（它每次发消息都会重设，界面选哪个会话也不靠它）", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql")
    activeSessions = { [APP_CHAT]: projectSessionKey(APP_CHAT, p.id) }
    expect(await dispatcher.releaseProjectRoutes(port, p)).toEqual([])
    expect(moves).toEqual([])
  })

  it("项目自己的专属群不动（归档后仍可 /p use 回去继续）；别的群、私聊照挪", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql", { groupChatId: FEISHU_GROUP })
    activeSessions = {
      [FEISHU_GROUP]: projectSessionKey(FEISHU_GROUP, p.id),
      [FEISHU_OTHER_GROUP]: projectSessionKey(FEISHU_OTHER_GROUP, p.id),
      [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id),
    }
    const moved = await dispatcher.releaseProjectRoutes(port, p)
    expect(moved.sort()).toEqual([FEISHU_CHAT, FEISHU_OTHER_GROUP].sort())
    expect(moves.map((m) => m.chatId).sort()).toEqual([FEISHU_CHAT, FEISHU_OTHER_GROUP].sort())
    expect(activeSessions[FEISHU_GROUP]).toBe(projectSessionKey(FEISHU_GROUP, p.id))
  })

  it("通道已经不存在的聊天：不动（算不出它的主会话）", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql")
    const gone = makeChatKey("ch_deleted", "ou_x")
    activeSessions = { [gone]: projectSessionKey(gone, p.id) }
    expect(await dispatcher.releaseProjectRoutes(port, p)).toEqual([])
    expect(moves).toEqual([])
  })

  it("daemon 连不上：什么都不做，也不抛", async () => {
    const { dispatcher, mk } = await boot()
    const p = mk("慢sql")
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    await new Promise<void>((r) => server.close(() => r()))
    await expect(dispatcher.releaseProjectRoutes(port, p)).resolves.toEqual([])
  })
})

describe("归档项目时触发（setProjectArchivedByUser）", () => {
  it("私聊停在它上面：归档后被挪回主会话", async () => {
    const { create, mk } = await boot()
    const p = mk("慢sql")
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    expect(create.setProjectArchivedByUser(p.id, true)).toEqual({ ok: true, name: "慢sql" })
    expect(await waitFor(() => moves.length > 0)).toBe(true)
    expect(moves).toEqual([{ chatId: FEISHU_CHAT, sessionKey: mainKeyOf(FEISHU_CHAT) }])
  })

  it("取消归档不动指针", async () => {
    const b = await boot()
    const p = b.mk("慢sql")
    b.create.setProjectArchivedByUser(p.id, true)
    expect(await waitFor(() => gets > 0)).toBe(true)
    gets = 0
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    expect(b.create.setProjectArchivedByUser(p.id, false).ok).toBe(true)
    await runControl(b)
    expect(gets).toBe(1) // 只有对照那一次
    expect(movedChats()).toEqual([FEISHU_OTHER_GROUP])
    expect(activeSessions[FEISHU_CHAT]).toBe(projectSessionKey(FEISHU_CHAT, p.id))
  })

  it("归档的是别的项目：私聊停着的项目不受影响", async () => {
    const b = await boot()
    const p = b.mk("慢sql")
    const other = b.mk("别的")
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    expect(b.create.setProjectArchivedByUser(other.id, true).ok).toBe(true)
    expect(await waitFor(() => gets > 0)).toBe(true) // 确实去问过了，只是没有要挪的
    await runControl(b)
    expect(gets).toBe(2) // 归档 other 一次 + 对照一次
    expect(movedChats()).toEqual([FEISHU_OTHER_GROUP])
    expect(activeSessions[FEISHU_CHAT]).toBe(projectSessionKey(FEISHU_CHAT, p.id))
  })

  it("全局「当前项目」指针：指着被归档的就清掉，指着别的不动", async () => {
    const { create, store, mk } = await boot()
    const p = mk("慢sql")
    const other = mk("别的")
    store.setCurrentProjectId(other.id)
    create.setProjectArchivedByUser(p.id, true)
    expect(store.getCurrentProjectId()).toBe(other.id)
    store.setCurrentProjectId(p.id)
    create.setProjectArchivedByUser(p.id, true)
    expect(store.getCurrentProjectId()).toBeNull()
  })

  it("daemon 没起来（没有锁文件）：归档照常成功，当前项目指针照样清", async () => {
    const b = await boot()
    const p = b.mk("慢sql")
    b.store.setCurrentProjectId(p.id)
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    const lockPath = path.join(userData, LOCK_FILE_NAME)
    const lock = fs.readFileSync(lockPath)
    fs.rmSync(lockPath)
    expect(b.create.setProjectArchivedByUser(p.id, true)).toEqual({ ok: true, name: "慢sql" })
    expect(b.store.getCurrentProjectId()).toBeNull()
    expect(b.store.getProject(p.id)?.archivedAt).toBeTruthy()
    // 之后 daemon 起来了：对照归档能挪，而刚才那次一个请求都没发过
    fs.writeFileSync(lockPath, lock)
    await runControl(b)
    expect(gets).toBe(1)
    expect(movedChats()).toEqual([FEISHU_OTHER_GROUP])
  })

  it("项目不存在 / 没权限：不去动任何聊天", async () => {
    const b = await boot()
    const p = b.mk("慢sql")
    activeSessions = { [FEISHU_CHAT]: projectSessionKey(FEISHU_CHAT, p.id) }
    expect(b.create.setProjectArchivedByUser("000000000000", true)).toEqual({ ok: false, error: "项目不存在" })
    // 指定了一个没有应用内通道的通道：没归属，不许归档
    expect(b.create.setProjectArchivedByUser(p.id, true, { channelId: "ch_nobody" }).ok).toBe(false)
    expect(b.store.getProject(p.id)?.archivedAt).toBeUndefined()
    await runControl(b)
    expect(gets).toBe(1)
    expect(movedChats()).toEqual([FEISHU_OTHER_GROUP])
    expect(activeSessions[FEISHU_CHAT]).toBe(projectSessionKey(FEISHU_CHAT, p.id))
  })
})
