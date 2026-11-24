import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { APP_CHANNEL_CHAT_ID, makeChatKey } from "../src/shared/channel-types"

/**
 * 项目信息里点「最近成果」要能预览：项目会话的可预览范围 = 项目的工作目录。
 * 范围之外的文件、不是应用内通道的会话，仍然不行。真实的 file-preview + preview-open + project-store。
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
/** 主进程注册的 ipcMain.handle 处理函数：电脑端的预览接口只能这样调到 */
const handlers = new Map<string, IpcHandler>()
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
  ipcMain: { handle: (name: string, fn: IpcHandler) => { handlers.set(name, fn) }, on: () => {} },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const APP = "ch_app"
const FEISHU = "ch_fs"
const APP_CHAT = makeChatKey(APP, APP_CHANNEL_CHAT_ID)

let server: http.Server
let projectDir = ""
let outside = ""

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "proj-preview-"))
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-preview-dir-"))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "proj-preview-out-"))
  server = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as { port: number }
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  for (const d of [userData, projectDir, outside]) fs.rmSync(d, { recursive: true, force: true })
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
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [channel(APP, "app"), channel(FEISHU, "feishu")] as never,
    agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
    favWorkspacesMigrated: true,
  })
  const store = await import("../src/shared/project-store")
  store.initProjectStore(userData)
  const { mobilePreview, initFilePreview } = await import("../electron/file-preview")
  initFilePreview()
  /** 调电脑端界面用的预览接口（和界面经 IPC 调的是同一个处理函数） */
  const desktop = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args)
  const p = store.createProject({
    name: "写作", goal: "", repoPath: "", baseBranch: "", featureBranch: "",
    worktreePath: projectDir, groupIds: ["writing"], groupId: "writing", workspaceType: "plain",
  })
  return { mobilePreview, desktop, project: p }
}

describe("项目会话预览自己工作目录里的成果", () => {
  it("项目目录里的文件可以预览；目录外的不行", async () => {
    const { mobilePreview, project } = await boot()
    const sk = `${APP_CHAT}::project_${project.id}`
    const art = path.join(projectDir, ".lk-harness", "artifacts", "周报.md")
    fs.mkdirSync(path.dirname(art), { recursive: true })
    fs.writeFileSync(art, "# 周报")
    const other = path.join(outside, "别处.md")
    fs.writeFileSync(other, "# 别处")

    const ok = await mobilePreview.open(sk, art)
    expect(ok.ok).toBe(true)
    const bad = await mobilePreview.open(sk, other)
    expect(bad.ok).toBe(false)
  })

  it("不是应用内通道的项目会话不开放预览", async () => {
    const { mobilePreview, project } = await boot()
    const art = path.join(projectDir, "a.md")
    fs.writeFileSync(art, "x")
    expect((await mobilePreview.open(`${makeChatKey(FEISHU, "ou_main")}::project_${project.id}`, art)).ok).toBe(false)
  })

  it("项目已经不存在：不再开放它的目录", async () => {
    const { mobilePreview, project } = await boot()
    const art = path.join(projectDir, "a.md")
    fs.writeFileSync(art, "x")
    const store = await import("../src/shared/project-store")
    store.deleteProject(project.id)
    expect((await mobilePreview.open(`${APP_CHAT}::project_${project.id}`, art)).ok).toBe(false)
  })
})

describe("文件夹预览的可见范围：电脑端不限制，手机端限定在项目目录", () => {
  it("手机端：项目目录里的文件夹能列、能检查；目录之外的不行；检查结果里 paths 只有文件、文件夹在 dirs", async () => {
    const { mobilePreview, project } = await boot()
    const sk = `${APP_CHAT}::project_${project.id}`
    const inside = path.join(projectDir, "成果.md")
    fs.writeFileSync(inside, "x")
    const other = path.join(outside, "别处.md")
    fs.writeFileSync(other, "x")

    const listed = await mobilePreview.dir(sk, projectDir)
    expect(listed.ok && listed.entries.map((e) => e.name)).toEqual(["成果.md"])
    expect((await mobilePreview.dir(sk, outside)).ok).toBe(false)
    expect(await mobilePreview.check(sk, [inside, projectDir, other, outside])).toEqual({
      paths: [inside, null, null, null],
      dirs: [null, projectDir, null, null],
    })
  })

  it("电脑端：项目目录之外的文件、文件夹也能预览、列出、检查", async () => {
    const { desktop, project } = await boot()
    const sk = `${APP_CHAT}::project_${project.id}`
    const other = path.join(outside, "别处.md")
    fs.writeFileSync(other, "x")

    expect(await desktop("preview:file-open", sk, other)).toMatchObject({ ok: true, name: "别处.md" })
    const listed = await desktop("preview:dir-list", sk, outside) as { ok: boolean; entries?: { name: string }[] }
    expect(listed.ok && listed.entries?.map((e) => e.name)).toEqual(["别处.md"])
    expect(await desktop("preview:file-check", sk, [other, outside])).toEqual([
      { path: other, isDir: false },
      { path: path.resolve(outside), isDir: true },
    ])
  })

  it("电脑端也只给应用内通道的会话", async () => {
    const { desktop, project } = await boot()
    const sk = `${makeChatKey(FEISHU, "ou_main")}::project_${project.id}`
    expect(await desktop("preview:dir-list", sk, projectDir)).toEqual({ ok: false, error: "不是应用内对话的会话" })
  })
})
