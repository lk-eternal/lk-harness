import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { APP_CHANNEL_CHAT_ID, makeChatKey } from "../src/shared/channel-types"

/**
 * 应用内建项目 / 推进步骤 / 删除：真实的 config-store、project-store、project-commands、project-create，
 * 只把落盘的 electron-store、electron（含回收站）和假 daemon 顶掉。
 * 守住几件事：不动飞书用的全局「当前项目」指针、用户自己选的文件夹删项目时原样保留、
 * 项目会话归应用内通道、步骤提示词投进项目会话。
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
const trashed: string[] = []
vi.mock("electron", () => ({
  app: { getPath: () => userData, getVersion: () => "0", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { trashItem: async (p: string) => { trashed.push(p) } },
  dialog: {},
  clipboard: {},
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

const APP = "ch_app"
const FEISHU = "ch_fs"
const APP_CHAT = makeChatKey(APP, APP_CHANNEL_CHAT_ID)

type Hit = { url: string; body: Record<string, unknown> }
let hits: Hit[] = []
let server: http.Server
let folder = ""

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "proj-create-"))
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "proj-create-user-"))
  hits = []
  trashed.length = 0
  // 有的用例会把回收站换成会失败的；换回来，别影响后面的用例
  const electron = await import("electron")
  ;(electron.shell as { trashItem: (p: string) => Promise<void> }).trashItem = async (p: string) => { trashed.push(p) }
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* 空体 */ }
      hits.push({ url: req.url ?? "", body })
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
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(folder, { recursive: true, force: true })
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
  const create = await import("../electron/project-create")
  const commands = await import("../electron/project-commands")
  return { store, create, commands }
}

const hit = (url: string) => hits.filter((h) => h.url === url)
const portOf = (): number => (server.address() as { port: number }).port

describe("应用内建项目", () => {
  it("建好的项目：记着所选的模板（不复制内容）、项目信息、应用内会话键、目录和成果目录", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, {
      name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT", 截止时间: "周五" },
    })
    expect(r).toMatchObject({ ok: true })
    expect(r.warning).toBeUndefined()
    const p = store.getProject(r.projectId!)!
    for (const k of ["repoPath", "baseBranch", "featureBranch", "repos", "workspaceType"]) expect(p).not.toHaveProperty(k)
    expect(p.externalWorkspace).toBeUndefined()
    expect(p.groupId).toBe("research")
    expect(p.groupIds).toEqual(["research"])
    expect(p).not.toHaveProperty("groupSnapshot")
    expect(p.metadata).toEqual({ 交付形式: "PPT", 截止时间: "周五" })
    // 默认只接应用内对话通道的主聊天，会话键记在这个入口上
    const sessionKey = `${APP_CHAT}::project_${p.id}`
    expect(p.bindings).toEqual([{ kind: "main", channelId: APP, sessionKey }])
    expect(r.sessionKey).toBe(sessionKey)
    // 目录在应用数据目录下，成果目录已建好
    expect(path.resolve(p.worktreePath).startsWith(path.resolve(userData))).toBe(true)
    expect(fs.existsSync(path.join(p.worktreePath, ".lk-harness", "artifacts"))).toBe(true)
    // 进入项目会话：daemon 的当前会话切到项目会话
    expect(hit("/api/active-session")).toEqual([
      { url: "/api/active-session", body: { chatId: APP_CHAT, sessionKey } },
    ])
  })

  it("同名项目各有各的目录，不会互相覆盖", async () => {
    const { store, create } = await boot()
    const a = await create.createProjectFromApp(APP, { name: "周报", templateId: "general" })
    const b = await create.createProjectFromApp(APP, { name: "周报", templateId: "general" })
    expect(a.ok && b.ok).toBe(true)
    expect(store.getProject(a.projectId!)!.worktreePath).not.toBe(store.getProject(b.projectId!)!.worktreePath)
  })

  it("不动飞书私聊用的「当前项目」指针（指针按通道记，应用内建项目只动应用内通道的）", async () => {
    const { store, create } = await boot()
    const FS_CHAT = makeChatKey(FEISHU, "ou_main")
    const first = store.createProject({
      name: "飞书那边的项目", goal: "",
      worktreePath: path.join(userData, "fs-proj", "workspace"), groupIds: ["develop"], groupId: "develop",
      bindings: [{ kind: "main", channelId: FEISHU }],
    })
    store.setCurrentProjectId(first.id, FS_CHAT)
    const r = await create.createProjectFromApp(APP, { name: "应用里建的", templateId: "general" })
    expect(r.ok).toBe(true)
    expect(store.getCurrentProjectId(FS_CHAT)).toBe(first.id)
  })

  it("不是应用内通道不能建；校验不过不留项目", async () => {
    const { store, create } = await boot()
    expect(await create.createProjectFromApp(FEISHU, { name: "x", templateId: "general" })).toEqual({ ok: false, error: "不是应用内对话的通道" })
    expect((await create.createProjectFromApp(APP, { name: "", templateId: "general" })).ok).toBe(false)
    // 选了仓库但路径不是完整路径 / 没填基线分支：拦下，同样不留项目（仓库本身是可选的，不选不算错）
    const rel = await create.createProjectFromApp(APP, { name: "x", templateId: "develop", repos: [{ repoPath: "relative/shop", baseBranch: "main" }] })
    expect(rel.ok).toBe(false)
    const noBase = await create.createProjectFromApp(APP, { name: "x", templateId: "develop", repos: [{ repoPath: path.join(folder, "shop"), baseBranch: " " }] })
    expect(noBase.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    expect(hit("/api/active-session")).toHaveLength(0)
  })

  it("选已有文件夹：项目直接用它，原有文件不动，只多一个成果目录", async () => {
    const { store, create } = await boot()
    fs.writeFileSync(path.join(folder, "资料.md"), "我的资料")
    const r = await create.createProjectFromApp(APP, { name: "整理资料", templateId: "writing", folder })
    expect(r.ok).toBe(true)
    const p = store.getProject(r.projectId!)!
    expect(p.externalWorkspace).toBe(true)
    expect(p.worktreePath).toBe(path.resolve(folder))
    expect(fs.readFileSync(path.join(folder, "资料.md"), "utf8")).toBe("我的资料")
    expect(fs.existsSync(path.join(folder, ".lk-harness", "artifacts"))).toBe(true)
  })

  it("文件夹不存在、是个文件、已被别的项目用着：拒绝", async () => {
    const { create } = await boot()
    expect((await create.createProjectFromApp(APP, { name: "a", templateId: "general", folder: path.join(folder, "nope") })).ok).toBe(false)
    const file = path.join(folder, "a.txt")
    fs.writeFileSync(file, "x")
    expect((await create.createProjectFromApp(APP, { name: "a", templateId: "general", folder: file })).ok).toBe(false)

    expect((await create.createProjectFromApp(APP, { name: "第一个", templateId: "general", folder })).ok).toBe(true)
    const dup = await create.createProjectFromApp(APP, { name: "第二个", templateId: "general", folder })
    expect(dup.ok).toBe(false)
    expect(dup.error).toContain("第一个")
  })

  it("daemon 没启动：项目建好，带提示，不报失败", async () => {
    const { store, create } = await boot()
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    const r = await create.createProjectFromApp(APP, { name: "离线建", templateId: "general" })
    expect(r.ok).toBe(true)
    expect(r.warning).toContain("服务未运行")
    const p = store.getProject(r.projectId!)!
    // 项目接入了应用内对话通道的主聊天，会话键已记下：后面 daemon 起来、步骤产出通知时按它回到应用内对话
    expect(p.bindings).toEqual([{ kind: "main", channelId: APP, sessionKey: `${APP_CHAT}::project_${r.projectId}` }])
    expect(r.sessionKey).toBe(`${APP_CHAT}::project_${r.projectId}`)
  })
})

describe("点步骤", () => {
  it("步骤提示词投进项目会话；不动全局指针；不另写「开始」通知（记录由 daemon 在投递时补）", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "写作", templateId: "writing" })
    const before = store.getCurrentProjectId(APP_CHAT)
    hits.length = 0

    const run = await create.runProjectStepFromApp(APP, r.projectId!, "outline")
    expect(run).toEqual({ ok: true })
    const enq = hit("/enqueue")
    expect(enq).toHaveLength(1)
    expect(enq[0].body.sessionKey).toBe(r.sessionKey)
    expect(String(enq[0].body.content)).toContain("[PROJECT_ACTION]")
    expect(String(enq[0].body.content)).not.toMatch(/分支与红线|飞书|GitLab/)
    expect(store.getCurrentProjectId(APP_CHAT)).toBe(before)
    // 投递时 daemon 已经会给这条提示词记一条提示条，这里再写一条「开始」就重复了
    expect(hit("/cmd/result")).toHaveLength(0)
  })

  it("项目里没有的步骤、不存在的项目、非应用内通道：都拒绝，且什么都不投", async () => {
    const { create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "写作", templateId: "writing" })
    hits.length = 0
    expect((await create.runProjectStepFromApp(APP, r.projectId!, "scope")).ok).toBe(false)
    expect((await create.runProjectStepFromApp(APP, "000000000000", "outline")).ok).toBe(false)
    expect((await create.runProjectStepFromApp(FEISHU, r.projectId!, "outline")).ok).toBe(false)
    expect(hit("/enqueue")).toHaveLength(0)
  })

  it("用户自己选的文件夹被移走后，点步骤会提示而不是悄悄建个空文件夹", async () => {
    const { create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "整理", templateId: "general", folder })
    fs.rmSync(folder, { recursive: true, force: true })
    hits.length = 0
    const run = await create.runProjectStepFromApp(APP, r.projectId!, "clarify")
    expect(run.ok).toBe(false)
    expect(run.error).toContain("项目文件夹不见了")
    expect(fs.existsSync(folder)).toBe(false)
    expect(hit("/enqueue")).toHaveLength(0)
  })
})

describe("删项目", () => {
  it("应用自己管的目录：整个项目目录进回收站，路由登记和聊天记录一并清掉", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "临时调研", templateId: "research" })
    const p = store.getProject(r.projectId!)!
    hits.length = 0

    expect(await create.deleteProjectByUser(p.id)).toEqual({ ok: true, name: "临时调研" })
    expect(store.getProject(p.id)).toBeUndefined()
    expect(trashed).toEqual([path.dirname(p.worktreePath)])
    const sessionKey = `${APP_CHAT}::project_${p.id}`
    expect(hit("/api/purge-session-routing").map((h) => h.body.sessionKey)).toEqual([sessionKey])
    expect(hits.some((h) => h.url.includes("app-chat") && JSON.stringify(h.body).includes(sessionKey))).toBe(true)
  })

  it("在飞书里删项目：应用内留着的那条项目会话（找不到项目的幽灵会话）一起清掉，飞书这条也清", async () => {
    const { store, create, commands } = await boot()
    const FS_CHAT = makeChatKey(FEISHU, "ou_main")
    // 项目同时接了应用内对话和飞书主聊天：删它的时候两边的会话都要收拾
    const created = await create.createProjectFromApp(APP, {
      name: "两边都有", templateId: "general",
      bindings: [{ channelId: APP, mode: "inline" }, { channelId: FEISHU, mode: "inline" }],
    })
    expect(created.ok).toBe(true)
    const p = store.getProject(created.projectId!)!
    const appKey = `${APP_CHAT}::project_${p.id}`
    const fsKey = `${FS_CHAT}::project_${p.id}`
    store.setCurrentProjectId(p.id, FS_CHAT)
    hits.length = 0

    await commands.handleFeishuProjectCommand(portOf(), "m1", `/p del ${p.id} --yes`, FS_CHAT)

    expect(store.getProject(p.id)).toBeUndefined()
    expect(hit("/api/purge-session-routing").map((h) => h.body.sessionKey).sort()).toEqual([appKey, fsKey].sort())
    // 应用内的聊天记录也清了
    expect(hits.some((h) => h.url.includes("app-chat") && JSON.stringify(h.body).includes(appKey))).toBe(true)
    // 停在这个项目上的飞书私聊，活跃会话被挪回主会话；指针清掉
    expect(hit("/api/active-session").some((h) => h.body.chatId === FS_CHAT && !String(h.body.sessionKey).includes("::project_"))).toBe(true)
    expect(store.getCurrentProjectId(FS_CHAT)).toBeNull()
  })

  it("项目只接了飞书（还没进过会话）：在设置页删，应用内通道上按通道推出来的会话（可能留着的幽灵会话）也清", async () => {
    const { store, create } = await boot()
    const p = store.createProject({
      name: "飞书的项目", goal: "", worktreePath: path.join(userData, "fs-only", "workspace"), groupIds: ["general"], groupId: "general",
      bindings: [{ kind: "main", channelId: FEISHU }],
    })
    hits.length = 0
    expect((await create.deleteProjectByUser(p.id)).ok).toBe(true)
    // 飞书那个入口没记过会话（没进去过），不用清；应用内的会话键只由通道推出来，照清
    expect(hit("/api/purge-session-routing").map((h) => h.body.sessionKey)).toEqual([`${APP_CHAT}::project_${p.id}`])
  })

  it("用户自己选的文件夹：只解绑，文件夹和里面的东西原样保留，不进回收站", async () => {
    const { store, create } = await boot()
    fs.writeFileSync(path.join(folder, "资料.md"), "我的资料")
    const r = await create.createProjectFromApp(APP, { name: "整理资料", templateId: "writing", folder })
    expect(r.ok).toBe(true)

    expect((await create.deleteProjectByUser(r.projectId!)).ok).toBe(true)
    expect(store.getProject(r.projectId!)).toBeUndefined()
    expect(trashed).toEqual([])
    expect(fs.readFileSync(path.join(folder, "资料.md"), "utf8")).toBe("我的资料")
  })

  it("回收站失败时也不能强删用户自己选的文件夹", async () => {
    const { create } = await boot()
    fs.writeFileSync(path.join(folder, "资料.md"), "我的资料")
    const r = await create.createProjectFromApp(APP, { name: "整理资料", templateId: "writing", folder })
    const electron = await import("electron")
    ;(electron.shell as { trashItem: (p: string) => Promise<void> }).trashItem = async () => { throw new Error("回收站不可用") }
    await create.deleteProjectByUser(r.projectId!)
    expect(fs.readFileSync(path.join(folder, "资料.md"), "utf8")).toBe("我的资料")
  })

  it("不存在的项目：报错而不是假装成功", async () => {
    const { create } = await boot()
    expect(await create.deleteProjectByUser("000000000000")).toEqual({ ok: false, error: "项目不存在" })
  })
})

describe("归档项目", () => {
  it("归档 → 成果和会话都留着，只是标成已归档；取消归档能恢复；视图和列表都带这个标记", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "做完了", templateId: "research" })
    const id = r.projectId!
    expect(create.getProjectView(id, APP)?.archived).toBe(false)

    expect(create.setProjectArchivedByUser(id, true)).toEqual({ ok: true, name: "做完了" })
    expect(store.getProject(id)?.archivedAt).toBeGreaterThan(0)
    expect(store.getProject(id)?.bindings?.[0]?.sessionKey).toBeTruthy()
    expect(trashed).toEqual([]) // 不删任何东西
    expect(create.getProjectView(id, APP)?.archived).toBe(true)
    expect(create.listProjectItems().find((x) => x.id === id)?.archived).toBe(true)

    expect(create.setProjectArchivedByUser(id, false)).toEqual({ ok: true, name: "做完了" })
    expect(store.getProject(id)?.archivedAt).toBeUndefined()
    expect(create.getProjectView(id, APP)?.archived).toBe(false)
  })

  it("设置页的项目列表：已归档的排在最后，其余保持原来的顺序", async () => {
    const { create } = await boot()
    const a = await create.createProjectFromApp(APP, { name: "甲", templateId: "general" })
    await create.createProjectFromApp(APP, { name: "乙", templateId: "general" })
    await create.createProjectFromApp(APP, { name: "丙", templateId: "general" })
    const before = create.listProjectItems().map((x) => x.id)
    create.setProjectArchivedByUser(a.projectId!, true)
    const after = create.listProjectItems()
    expect(after.map((x) => x.archived)).toEqual([false, false, true])
    expect(after[2].id).toBe(a.projectId)
    expect(after.slice(0, 2).map((x) => x.id)).toEqual(before.filter((id) => id !== a.projectId))
  })

  it("不存在的项目：报错", async () => {
    const { create } = await boot()
    expect(create.setProjectArchivedByUser("000000000000", true)).toEqual({ ok: false, error: "项目不存在" })
  })
})

describe("项目信息面板和模板列表", () => {
  it("全局模板改了，已建项目的步骤立即跟上，不用同步", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "周报", templateId: "report" })
    expect(create.getProjectView(r.projectId!, APP)!.steps.map((s) => s.id)).not.toContain("extra")

    const groups = store.getNodeGroups()
    store.saveNodeGroups(groups.map((g) => g.id === "report"
      ? { ...g, nodes: [...g.nodes, { id: "extra", label: "多一步" }] }
      : g))

    const view = create.getProjectView(r.projectId!, APP)!
    expect(view.steps.map((s) => s.id)).toContain("extra")
    expect(view).not.toHaveProperty("canSyncSteps")
  })

  it("项目不存在：看不到信息面板", async () => {
    const { create } = await boot()
    expect(create.getProjectView("000000000000", APP)).toBeNull()
  })

  it("模板列表：开发、测试模板接代码仓库，通用类不用；带出各自默认的工作分支", async () => {
    const { create } = await boot()
    const list = create.listProjectTemplates()
    expect(list.find((t) => t.id === "general")?.needsRepo).toBe(false)
    expect(list.find((t) => t.id === "develop")).toMatchObject({ needsRepo: true, workBranchMode: "new" })
    expect(list.find((t) => t.id === "test")).toMatchObject({ needsRepo: true, workBranchMode: "test" })
  })
})

// ── 接代码仓库的项目（开发模板）：真 git 仓库，真克隆 ──────────────────────────

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
  return (r.stdout || "").trim()
}

/** 建一个有 main 和 develop 两个分支的本地仓库；返回仓库根目录 */
function makeRepo(parent: string, name: string): string {
  const repo = path.join(parent, name)
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ["init"])
  git(repo, ["config", "user.email", "t@t.com"])
  git(repo, ["config", "user.name", "t"])
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", "init"])
  git(repo, ["branch", "-M", "main"])
  git(repo, ["branch", "develop"])
  return repo
}

describe("应用内建开发项目（接代码仓库）", () => {
  let repoParent = ""
  beforeEach(() => { repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-repos-")) })
  afterEach(() => { fs.rmSync(repoParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as fs.RmOptions) })

  /** 项目信息里「代码仓库」那几行 */
  const repoRows = (p: { metadata?: Record<string, string> }) =>
    Object.fromEntries(Object.entries(p.metadata ?? {}).filter(([k]) => k === "代码仓库" || k.startsWith("代码仓库 · ")))

  it("克隆出独立的副本并检出新分支，副本就是项目目录；仓库、分支记在项目信息里；用户自己的仓库原样不动", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, {
      name: "改版", goal: "首页改版", templateId: "develop",
      repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/redesign",
      storyUrl: "https://t.example.com/1", relatedDocs: "见 wiki",
    })
    expect(r).toMatchObject({ ok: true })
    expect(r.warning).toBeUndefined()
    const p = store.getProject(r.projectId!)!
    expect(p).toMatchObject({
      groupId: "develop", storyUrl: "https://t.example.com/1", relatedDocs: "见 wiki",
      bindings: [{ kind: "main", channelId: APP, sessionKey: `${APP_CHAT}::project_${p.id}` }],
    })
    // 仓库、分支不再有专门的字段
    for (const k of ["repoPath", "baseBranch", "featureBranch", "repos", "workspaceType"]) expect(p).not.toHaveProperty(k)
    expect(p.externalWorkspace).toBeUndefined()
    expect(p.groupIds).toEqual(["develop"])
    const wt = p.worktreePath
    // 项目目录在应用数据目录下，只克隆了一个仓库：副本就是项目目录，停在新分支上
    expect(path.resolve(wt).startsWith(path.resolve(userData))).toBe(true)
    expect(path.basename(wt)).toBe("shop")
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/redesign")
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(wt, ".lk-harness", "artifacts"))).toBe(true)
    expect(fs.readFileSync(path.join(wt, ".git", "info", "exclude"), "utf8")).toContain(".lk-harness/")
    expect(repoRows(p)).toEqual({ 代码仓库: `${wt}（工作分支 feature/redesign；基线分支 main）` })
    // 用户的仓库：还在 main、没多分支、没脏文件
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main")
    expect(git(repo, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["develop", "main"])
    expect(git(repo, ["status", "--porcelain"])).toBe("")
    // 进入项目会话
    expect(hit("/api/active-session")).toEqual([
      { url: "/api/active-session", body: { chatId: APP_CHAT, sessionKey: `${APP_CHAT}::project_${p.id}` } },
    ])
  })

  it("新建分支不填名字：按「feature/日期-项目名」生成；基线可以是别的分支", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "api")
    const r = await create.createProjectFromApp(APP, { name: "login", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "develop" }] })
    expect(r.ok).toBe(true)
    const p = store.getProject(r.projectId!)!
    const head = git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
    expect(head).toMatch(/^feature\/\d{6}-login$/)
    expect(repoRows(p).代码仓库).toBe(`${p.worktreePath}（工作分支 ${head}；基线分支 develop）`)
  })

  it("仓库是可选的：接代码仓库的模板一个仓库也不选，照样建成普通项目（没有代码仓库信息）", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "先聊聊", templateId: "develop" })
    expect(r.ok).toBe(true)
    const p = store.getProject(r.projectId!)!
    expect(repoRows(p)).toEqual({})
    expect(path.basename(p.worktreePath)).toBe("workspace")
    expect(fs.existsSync(path.join(p.worktreePath, ".lk-harness", "artifacts"))).toBe(true)
    expect(fs.existsSync(path.join(p.worktreePath, ".git"))).toBe(false)
  })

  it("用到的仓库自动记进常用仓库；记过的原样不动（测试/开发分支保留、基线不被这次顶掉），并带进项目信息", async () => {
    const { store, create } = await boot()
    const config = await import("../electron/config-store")
    const fresh = makeRepo(repoParent, "fresh")
    const known = makeRepo(repoParent, "known")
    config.saveConfig({ repoProfiles: [{ path: known, baseBranch: "main", testBranch: "test", developBranch: "dev" }], repoRoots: [known] })

    const r = await create.createProjectFromApp(APP, {
      name: "两仓", templateId: "develop",
      repos: [{ repoPath: fresh, baseBranch: "main" }, { repoPath: known, baseBranch: "develop" }],
      featureBranch: "feature/two",
    })
    expect(r.ok).toBe(true)
    const profiles = config.getRepoProfiles()
    expect(profiles.find((x) => x.path === fresh)).toMatchObject({ baseBranch: "main" })
    expect(profiles.find((x) => x.path === known)).toEqual({ path: known, baseBranch: "main", testBranch: "test", developBranch: "dev" })
    const p = store.getProject(r.projectId!)!
    // 两个仓库都克隆了：项目目录是放它们的上一层的 workspace，两个副本各一个子目录
    const slugDir = path.dirname(p.worktreePath)
    expect(path.basename(p.worktreePath)).toBe("workspace")
    expect(fs.readdirSync(slugDir).sort()).toEqual(["fresh", "known", "workspace"])
    expect(repoRows(p)).toEqual({
      "代码仓库 · fresh": `${path.join(slugDir, "fresh")}（工作分支 feature/two；基线分支 main）`,
      "代码仓库 · known": `${path.join(slugDir, "known")}（工作分支 feature/two；基线分支 develop；测试分支 test；开发分支 dev）`,
    })
    // 常用仓库列表给建项界面用
    expect(create.listProjectRepoOptions().map((o) => o.name).sort()).toEqual(["fresh", "known"])
  })

  it("两个同名仓库（不同位置）：副本目录名自动加序号，互不覆盖，项目信息里也是同样的名字", async () => {
    const { store, create } = await boot()
    const a = makeRepo(path.join(repoParent, "a"), "foo")
    const b = makeRepo(path.join(repoParent, "b"), "foo")
    const r = await create.createProjectFromApp(APP, {
      name: "同名", templateId: "develop",
      repos: [{ repoPath: a, baseBranch: "main" }, { repoPath: b, baseBranch: "main" }],
    })
    expect(r.ok).toBe(true)
    const p = store.getProject(r.projectId!)!
    const slugDir = path.dirname(p.worktreePath)
    expect(fs.readdirSync(slugDir).sort()).toEqual(["foo", "foo-2", "workspace"])
    expect(Object.keys(repoRows(p)).sort()).toEqual(["代码仓库 · foo", "代码仓库 · foo-2"])
  })

  it("设置里配了项目存放位置：克隆到那里", async () => {
    const { store, create } = await boot()
    const config = await import("../electron/config-store")
    const root = path.join(repoParent, "my-projects")
    config.saveConfig({ worktreeRoot: root })
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }] })
    expect(r.ok).toBe(true)
    expect(path.resolve(store.getProject(r.projectId!)!.worktreePath).startsWith(path.resolve(root))).toBe(true)
  })

  describe("克隆副本 / 不克隆", () => {
    /** 把仓库 .git 里所有文件的路径、大小、修改时间拍个照：应用要是对这个仓库做过任何 git 操作，照片就会变 */
    function snapshotGitDir(repo: string): string[] {
      const out: string[] = []
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const full = path.join(dir, name)
          const st = fs.statSync(full)
          if (st.isDirectory()) walk(full)
          else out.push(`${path.relative(repo, full)}|${st.size}|${st.mtimeMs}`)
        }
      }
      walk(path.join(repo, ".git"))
      return out
    }

    it("设置里取消了「克隆副本」：不克隆、不碰这个仓库，项目目录是空的工作目录，项目信息里记的是用户本机那个目录", async () => {
      const { store, create } = await boot()
      const config = await import("../electron/config-store")
      const repo = makeRepo(repoParent, "mine")
      config.saveConfig({ repoProfiles: [{ path: repo, baseBranch: "main", testBranch: "develop", clone: false }], repoRoots: [repo] })
      const before = snapshotGitDir(repo)
      const head = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8")

      const r = await create.createProjectFromApp(APP, {
        name: "直接用我的", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/never",
      })
      expect(r.ok).toBe(true)
      const p = store.getProject(r.projectId!)!
      expect(path.basename(p.worktreePath)).toBe("workspace")
      expect(fs.readdirSync(path.dirname(p.worktreePath)).sort()).toEqual(["workspace"])
      expect(fs.existsSync(path.join(p.worktreePath, ".git"))).toBe(false)
      expect(fs.existsSync(path.join(p.worktreePath, ".lk-harness", "artifacts"))).toBe(true)
      // 项目信息里是用户本机的目录和配好的分支；没有「工作分支」（应用没有切任何分支）
      expect(repoRows(p)).toEqual({ 代码仓库: `${repo}（基线分支 main；测试分支 develop）` })
      // 一个 git 操作都没有：.git 里的文件和修改时间原样，没建分支，HEAD 没动
      expect(snapshotGitDir(repo)).toEqual(before)
      expect(fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8")).toBe(head)
      expect(git(repo, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["develop", "main"])
      // 常用仓库里它的「不克隆」设置没被这次建项冲掉
      expect(config.getRepoProfiles().find((x) => x.path === repo)).toMatchObject({ clone: false, testBranch: "develop" })
    })

    it("不克隆的仓库应用不检查：不是 git 仓库、甚至不存在的目录也照样记进项目，分支名也不校验", async () => {
      const { store, create } = await boot()
      const config = await import("../electron/config-store")
      const plain = path.join(repoParent, "just-a-folder")
      fs.mkdirSync(plain)
      const gone = path.join(repoParent, "moved-away")
      config.saveConfig({
        repoProfiles: [{ path: plain, baseBranch: "main", clone: false }, { path: gone, baseBranch: "main", clone: false }],
        repoRoots: [plain, gone],
      })
      const r = await create.createProjectFromApp(APP, {
        name: "随便", templateId: "develop",
        repos: [{ repoPath: plain, baseBranch: "any branch" }, { repoPath: gone, baseBranch: "main" }], featureBranch: "bad name",
      })
      expect(r.ok).toBe(true)
      const p = store.getProject(r.projectId!)!
      expect(Object.values(repoRows(p))).toEqual([`${plain}（基线分支 any branch）`, `${gone}（基线分支 main）`])
      expect(fs.readdirSync(plain)).toEqual([])
    })

    it("一个克隆、一个不克隆：克隆的那份副本是项目目录，不克隆的只是项目信息里的一行", async () => {
      const { store, create } = await boot()
      const config = await import("../electron/config-store")
      const cloned = makeRepo(repoParent, "cloned")
      const mine = makeRepo(repoParent, "mine")
      config.saveConfig({ repoProfiles: [{ path: mine, baseBranch: "main", clone: false }], repoRoots: [mine] })
      const r = await create.createProjectFromApp(APP, {
        name: "混合", templateId: "develop",
        repos: [{ repoPath: cloned, baseBranch: "main" }, { repoPath: mine, baseBranch: "main" }], featureBranch: "feature/mix",
      })
      expect(r.ok).toBe(true)
      const p = store.getProject(r.projectId!)!
      expect(path.basename(p.worktreePath)).toBe("cloned")
      expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/mix")
      expect(repoRows(p)).toEqual({
        "代码仓库 · cloned": `${p.worktreePath}（工作分支 feature/mix；基线分支 main）`,
        "代码仓库 · mine": `${mine}（基线分支 main）`,
      })
      expect(git(mine, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["develop", "main"])
    })

    it("常用仓库列表带着每个仓库的克隆设置：没设过=克隆，取消了=不克隆", async () => {
      const { create } = await boot()
      const config = await import("../electron/config-store")
      const a = makeRepo(repoParent, "a")
      const b = makeRepo(repoParent, "b")
      config.saveConfig({ repoProfiles: [{ path: a, baseBranch: "main" }, { path: b, baseBranch: "main", clone: false }], repoRoots: [a, b] })
      const opts = create.listProjectRepoOptions()
      expect(opts.find((o) => o.path === a)?.clone).toBe(true)
      expect(opts.find((o) => o.path === b)?.clone).toBe(false)
    })
  })

  describe("工作分支", () => {
    function setup(repoParent: string) {
      const repo = makeRepo(repoParent, "shop")
      git(repo, ["branch", "test"])
      return repo
    }

    it("测试分支：克隆的副本直接停在测试分支上，不新建任何分支，用户的仓库不动", async () => {
      const { store, create } = await boot()
      const config = await import("../electron/config-store")
      const repo = setup(repoParent)
      config.saveConfig({ repoProfiles: [{ path: repo, baseBranch: "main", testBranch: "test" }], repoRoots: [repo] })
      const r = await create.createProjectFromApp(APP, {
        name: "测试看代码", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], workBranch: "test", featureBranch: "feature/ignored",
      })
      expect(r.ok).toBe(true)
      const p = store.getProject(r.projectId!)!
      expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("test")
      expect(git(p.worktreePath, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["main", "test"])
      expect(repoRows(p).代码仓库).toBe(`${p.worktreePath}（工作分支 test；基线分支 main；测试分支 test）`)
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main")
    })

    it("默认的「测试」模板：不用选就是停在测试分支上；建项时可以临时改成新建分支", async () => {
      const { store, create } = await boot()
      const config = await import("../electron/config-store")
      const repo = setup(repoParent)
      config.saveConfig({ repoProfiles: [{ path: repo, baseBranch: "main", testBranch: "test" }], repoRoots: [repo] })
      const byTemplate = await create.createProjectFromApp(APP, { name: "测试A", templateId: "test", repos: [{ repoPath: repo, baseBranch: "main" }] })
      expect(byTemplate.ok).toBe(true)
      expect(git(store.getProject(byTemplate.projectId!)!.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("test")

      const overridden = await create.createProjectFromApp(APP, {
        name: "测试B", templateId: "test", repos: [{ repoPath: repo, baseBranch: "main" }], workBranch: "new", featureBranch: "feature/own",
      })
      expect(overridden.ok).toBe(true)
      expect(git(store.getProject(overridden.projectId!)!.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/own")
    })

    it("没配测试分支的仓库：退到基线分支；基线分支 / 开发分支同理", async () => {
      const { store, create } = await boot()
      const repo = makeRepo(repoParent, "plainrepo")
      const mk = async (workBranch: "test" | "develop" | "base", baseBranch: string) => {
        const r = await create.createProjectFromApp(APP, { name: `p-${workBranch}-${baseBranch}`, templateId: "develop", repos: [{ repoPath: repo, baseBranch }], workBranch })
        expect(r.ok, `${workBranch}/${baseBranch}`).toBe(true)
        return store.getProject(r.projectId!)!
      }
      expect(git((await mk("test", "develop")).worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop")
      expect(git((await mk("base", "main")).worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main")
      const dev = await mk("develop", "develop")
      expect(git(dev.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop")
      expect(repoRows(dev).代码仓库).toContain("工作分支 develop")
    })

    it("配的分支在仓库里不存在：报错说清是哪个分支，不悄悄换成别的，不留项目和半成品目录", async () => {
      const { store, create } = await boot()
      const config = await import("../electron/config-store")
      const repo = makeRepo(repoParent, "shop")
      config.saveConfig({ repoProfiles: [{ path: repo, baseBranch: "main", testBranch: "tset" }], repoRoots: [repo] })
      const r = await create.createProjectFromApp(APP, { name: "写错了", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], workBranch: "test" })
      expect(r.ok).toBe(false)
      expect(r.error).toContain("shop")
      expect(r.error).toContain("tset")
      expect(store.listProjects()).toHaveLength(0)
      const root = path.join(userData, "claw-projects")
      expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
    })
  })

  it("基线分支不存在：报错、不留项目、不留半成品目录，用户的仓库不动", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such" }] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("shop")
    expect(r.error).toContain("no-such")
    expect(store.listProjects()).toHaveLength(0)
    expect(hit("/api/active-session")).toHaveLength(0)
    const root = path.join(userData, "claw-projects")
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
    expect(git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("第二个仓库克隆失败：第一个已经克隆好的也要清掉", async () => {
    const { store, create } = await boot()
    const good = makeRepo(repoParent, "good")
    const bad = makeRepo(repoParent, "bad")
    const r = await create.createProjectFromApp(APP, {
      name: "半拉子", templateId: "develop",
      repos: [{ repoPath: good, baseBranch: "main" }, { repoPath: bad, baseBranch: "no-such" }],
    })
    expect(r.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    const root = path.join(userData, "claw-projects")
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
  })

  it("要克隆的仓库：不是 git 仓库根目录、不存在、分支名不合法，都拒绝，且都不克隆", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const plain = path.join(repoParent, "plain")
    fs.mkdirSync(plain)
    const sub = path.join(repo, "sub")
    fs.mkdirSync(sub)
    const base = { name: "x", templateId: "develop" }
    for (const dir of [plain, sub, path.join(repoParent, "nope")]) {
      const r = await create.createProjectFromApp(APP, { ...base, repos: [{ repoPath: dir, baseBranch: "main" }] })
      expect(r.ok, dir).toBe(false)
      expect(r.error, dir).toContain("不是可用的仓库")
    }
    for (const feature of ["bad name", "-x", "a..b", "x~1"]) {
      const r = await create.createProjectFromApp(APP, { ...base, repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: feature })
      expect(r.ok, feature).toBe(false)
      expect(r.error, feature).toContain("新建的分支名不合法")
    }
    const badBase = await create.createProjectFromApp(APP, { ...base, repos: [{ repoPath: repo, baseBranch: "--upload-pack=x" }] })
    expect(badBase.ok).toBe(false)
    expect(badBase.error).toContain("基线分支名不合法")
    expect(store.listProjects()).toHaveLength(0)
    expect(fs.existsSync(path.join(userData, "claw-projects"))).toBe(false)
  })

  it("磁盘上有没人认领的同名目录：换个目录名建，不撞上", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const orphan = path.join(userData, "claw-projects", "改版")
    fs.mkdirSync(path.join(orphan, "shop"), { recursive: true })
    fs.writeFileSync(path.join(orphan, "shop", "旧.txt"), "上次留下的")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }] })
    expect(r.ok).toBe(true)
    const wt = store.getProject(r.projectId!)!.worktreePath
    expect(path.dirname(wt)).not.toBe(orphan)
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toMatch(/^feature\//)
    expect(fs.readFileSync(path.join(orphan, "shop", "旧.txt"), "utf8")).toBe("上次留下的")
  })

  it("两个同名项目同时建：各占各的目录，其中一个失败清理时不会动另一个的克隆", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const [good, bad] = await Promise.all([
      create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }] }),
      // 基线分支不存在：克隆完、检出新分支时才失败，失败后清理的只能是它自己占的目录
      create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such-branch" }] }),
    ])
    expect(good.ok).toBe(true)
    expect(bad.ok).toBe(false)
    const wt = store.getProject(good.projectId!)!.worktreePath
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toMatch(/^feature\//)
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    // 失败的那个没留下半成品目录
    expect(fs.readdirSync(path.join(userData, "claw-projects"))).toEqual([path.basename(path.dirname(wt))])
  })

  it("daemon 没启动：项目照样建好，带提示", async () => {
    const { store, create } = await boot()
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "离线", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }] })
    expect(r.ok).toBe(true)
    expect(r.warning).toContain("服务未运行")
    expect(Object.keys(repoRows(store.getProject(r.projectId!)!))).toEqual(["代码仓库"])
  })

  it("点快捷操作：提示词里只多一句遵守 Git 基本原则（项目里没记仓库的没有），投进项目会话", async () => {
    const { create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/x" })
    hits.length = 0
    expect(await create.runProjectStepFromApp(APP, r.projectId!, "plan")).toEqual({ ok: true })
    const enq = hit("/enqueue")
    expect(enq).toHaveLength(1)
    expect(enq[0].body.sessionKey).toBe(r.sessionKey)
    const content = String(enq[0].body.content)
    expect(content).toContain("[PROJECT_ACTION]")
    expect(content).toContain("Git 基本原则")
    for (const old of ["分支与红线", "AI 工作目录", "本机仓库", "主仓"]) expect(content).not.toContain(old)

    // 同一个模板、没选仓库的项目：没有这句话
    const bare = await create.createProjectFromApp(APP, { name: "没仓库", templateId: "develop" })
    hits.length = 0
    expect(await create.runProjectStepFromApp(APP, bare.projectId!, "plan")).toEqual({ ok: true })
    expect(String(hit("/enqueue")[0].body.content)).not.toContain("Git 基本原则")
  })

  it("项目信息：标成接了代码仓库；删除时整个项目目录进回收站，用户自己的仓库不动", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/x" })
    const view = create.getProjectView(r.projectId!, APP)!
    expect(view).toMatchObject({ isCode: true, ownedHere: true })
    expect(view).not.toHaveProperty("featureBranch")
    const p = store.getProject(r.projectId!)!
    expect((await create.deleteProjectByUser(p.id, { channelId: APP })).ok).toBe(true)
    expect(trashed).toEqual([path.dirname(p.worktreePath)])
    expect(git(repo, ["status", "--porcelain"])).toBe("")
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true)
  })

  it("删项目只动项目目录：不克隆的仓库（用户自己的目录）原样保留，连里面的文件都不碰", async () => {
    const { store, create } = await boot()
    const config = await import("../electron/config-store")
    const mine = makeRepo(repoParent, "mine")
    fs.writeFileSync(path.join(mine, "wip.txt"), "没提交的东西")
    config.saveConfig({ repoProfiles: [{ path: mine, baseBranch: "main", clone: false }], repoRoots: [mine] })
    const r = await create.createProjectFromApp(APP, { name: "直接用", templateId: "develop", repos: [{ repoPath: mine, baseBranch: "main" }] })
    expect(r.ok).toBe(true)
    const p = store.getProject(r.projectId!)!
    expect((await create.deleteProjectByUser(p.id)).ok).toBe(true)
    expect(trashed).toEqual([path.dirname(p.worktreePath)])
    expect(trashed).not.toContain(mine)
    expect(fs.readFileSync(path.join(mine, "wip.txt"), "utf8")).toBe("没提交的东西")
  })
})

describe("看一个本地仓库（添加仓库时用）", () => {
  let repoParent = ""
  beforeEach(() => { repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-inspect-")) })
  afterEach(() => { fs.rmSync(repoParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as fs.RmOptions) })

  it("是仓库根目录：给出显示名、当前分支做默认基线、分支提示", async () => {
    const { create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.inspectProjectRepo(repo)
    expect(r).toMatchObject({ ok: true, path: path.resolve(repo), name: "shop", baseBranch: "main" })
    if (r.ok) expect(r.branches).toEqual(["develop", "main"])
  })

  it("有 origin 就用 origin 的默认分支，分支提示里不带 origin/ 前缀也不重复", async () => {
    const { create } = await boot()
    const origin = makeRepo(repoParent, "origin-repo")
    git(origin, ["checkout", "-b", "trunk"])
    const clone = path.join(repoParent, "mine")
    git(repoParent, ["clone", origin, clone])
    git(clone, ["checkout", "-b", "work"])
    const r = await create.inspectProjectRepo(clone)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.baseBranch).toBe("trunk")
      expect(r.branches).toEqual([...new Set(r.branches)].sort())
      expect(r.branches).toEqual(expect.arrayContaining(["main", "trunk", "work"]))
      expect(r.branches.some((b) => b.startsWith("origin/") || b === "HEAD")).toBe(false)
    }
  })

  it("子目录、普通文件夹、不存在、相对路径：都说清楚为什么不行", async () => {
    const { create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const sub = path.join(repo, "sub")
    fs.mkdirSync(sub)
    const plain = path.join(repoParent, "plain")
    fs.mkdirSync(plain)
    for (const dir of [sub, plain]) {
      const r = await create.inspectProjectRepo(dir)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("git 仓库的根目录")
    }
    const missing = await create.inspectProjectRepo(path.join(repoParent, "nope"))
    expect(!missing.ok && missing.error).toContain("不存在")
    expect((await create.inspectProjectRepo("shop")).ok).toBe(false)
    expect((await create.inspectProjectRepo("")).ok).toBe(false)
  })
})

describe("飞书里建的项目在应用内只读", () => {
  const FS_CHAT = makeChatKey(FEISHU, "ou_main")

  /** 飞书那边建好、已经进过会话的项目：只接入了飞书通道的主聊天，会话绑在飞书私聊上 */
  async function feishuProject() {
    const booted = await boot()
    const dir = path.join(userData, "fs-proj", "workspace")
    fs.mkdirSync(dir, { recursive: true })
    const p = booted.store.createProject({
      name: "飞书项目", goal: "",
      worktreePath: dir, groupIds: ["writing"], groupId: "writing",
      bindings: [{ kind: "main", channelId: FEISHU }],
    })
    p.bindings = [{ kind: "main", channelId: FEISHU, sessionKey: `${FS_CHAT}::project_${p.id}` }]
    booted.store.saveProject(p)
    hits.length = 0
    return { ...booted, p }
  }

  it("在应用里点它的步骤会被拒绝，它的会话绑定原样不动，也不投任何提示词（项目没接入应用内通道，应用内看不到它）", async () => {
    const { store, create, p } = await feishuProject()
    const run = await create.runProjectStepFromApp(APP, p.id, "outline")
    expect(run.ok).toBe(false)
    expect(run.error).toContain("没有接入当前通道")
    expect(store.getProject(p.id)?.bindings).toEqual([{ kind: "main", channelId: FEISHU, sessionKey: `${FS_CHAT}::project_${p.id}` }])
    expect(hit("/enqueue")).toHaveLength(0)
  })

  it("应用内删除（带通道）被拒绝；设置页的删除（不带通道）照常能删", async () => {
    const { store, create, p } = await feishuProject()
    const denied = await create.deleteProjectByUser(p.id, { channelId: APP })
    expect(denied.ok).toBe(false)
    expect(store.getProject(p.id)).toBeDefined()
    expect(trashed).toEqual([])

    expect(await create.deleteProjectByUser(p.id)).toEqual({ ok: true, name: "飞书项目" })
    expect(store.getProject(p.id)).toBeUndefined()
  })

  it("带通道删除只认应用内通道：飞书通道自己也不行", async () => {
    const { create, p } = await feishuProject()
    expect((await create.deleteProjectByUser(p.id, { channelId: FEISHU })).ok).toBe(false)
  })

  it("项目信息标出归属：自己建的归自己，飞书的不归", async () => {
    const { create, p } = await feishuProject()
    expect(create.getProjectView(p.id, APP)?.ownedHere).toBe(false)
    const mine = await create.createProjectFromApp(APP, { name: "我的", templateId: "general" })
    expect(create.getProjectView(mine.projectId!, APP)?.ownedHere).toBe(true)
  })

  it("应用内归档（带通道）：飞书建的项目同样被拒绝，状态不动；设置页（不带通道）能归档", async () => {
    const { store, create, p } = await feishuProject()
    const denied = create.setProjectArchivedByUser(p.id, true, { channelId: APP })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain("归档可以在设置的项目管理里做")
    expect(store.getProject(p.id)?.archivedAt).toBeUndefined()
    expect(create.setProjectArchivedByUser(p.id, true, { channelId: FEISHU }).ok).toBe(false)

    expect(create.setProjectArchivedByUser(p.id, true)).toEqual({ ok: true, name: "飞书项目" })
    expect(store.getProject(p.id)?.archivedAt).toBeGreaterThan(0)
  })

  it("自己建的项目：应用内归档 / 取消归档（带通道）可以", async () => {
    const { store, create } = await boot()
    const mine = await create.createProjectFromApp(APP, { name: "我的", templateId: "general" })
    expect(create.setProjectArchivedByUser(mine.projectId!, true, { channelId: APP }).ok).toBe(true)
    expect(store.getProject(mine.projectId!)?.archivedAt).toBeGreaterThan(0)
    expect(create.setProjectArchivedByUser(mine.projectId!, false, { channelId: APP }).ok).toBe(true)
    expect(store.getProject(mine.projectId!)?.archivedAt).toBeUndefined()
  })

  it("自己建的项目：应用内删除（带通道）可以", async () => {
    const { store, create } = await boot()
    const mine = await create.createProjectFromApp(APP, { name: "我的", templateId: "general" })
    expect((await create.deleteProjectByUser(mine.projectId!, { channelId: APP })).ok).toBe(true)
    expect(store.getProject(mine.projectId!)).toBeUndefined()
  })
})

describe("飞书里建项目（/p new 表单提交）：和应用内共用同一套项目目录准备", () => {
  const FS_CHAT = makeChatKey(FEISHU, "ou_main")
  let repoParent = ""
  beforeEach(() => { repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-fs-repos-")) })
  afterEach(() => { fs.rmSync(repoParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as fs.RmOptions) })

  type Submit = Parameters<Awaited<ReturnType<typeof boot>>["commands"]["handleProjectNewSubmit"]>[3]
  async function submit(commands: Awaited<ReturnType<typeof boot>>["commands"], fields: Partial<Submit> & { name: string }) {
    const lock = JSON.parse(fs.readFileSync(path.join(userData, LOCK_FILE_NAME), "utf8")) as { port: number }
    hits.length = 0
    await commands.handleProjectNewSubmit(lock.port, "om_1", FS_CHAT, { goal: "", worktreeRoot: "", chatMode: "inline", ...fields })
    const results = hit("/cmd/result")
    return results[results.length - 1]?.body as { ok?: boolean; message?: string } | undefined
  }
  const repoRows = (p: { metadata?: Record<string, string> }) =>
    Object.fromEntries(Object.entries(p.metadata ?? {}).filter(([k]) => k === "代码仓库" || k.startsWith("代码仓库 · ")))

  it("不接代码仓库的模板：只建项目目录；表单里多传的仓库一概不理（不克隆、不记进常用仓库）", async () => {
    const { store, commands } = await boot()
    const config = await import("../electron/config-store")
    const repo = makeRepo(repoParent, "shop")
    const res = await submit(commands, {
      name: "周报", groupId: "general", groupIds: ["general"], workspaceType: "plain", repos: [{ repoPath: repo, baseBranch: "main" }],
    })
    expect(res?.ok).toBe(true)
    const p = store.listProjects()[0]
    expect(p.name).toBe("周报")
    expect(path.basename(p.worktreePath)).toBe("workspace")
    expect(p.metadata).toBeUndefined()
    // 在飞书私聊里建：接入这个通道的主聊天，会话键记在这个入口上
    expect(p.bindings).toEqual([{ kind: "main", channelId: FEISHU, sessionKey: `${FS_CHAT}::project_${p.id}` }])
    expect(fs.readdirSync(path.dirname(p.worktreePath))).toEqual(["workspace"])
    expect(config.getRepoProfiles()).toEqual([])
    expect(git(repo, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["develop", "main"])
  })

  it("开发模板：克隆副本并检出新分支，副本就是项目目录；仓库、分支记在项目信息里；仓库记进常用仓库", async () => {
    const { store, commands } = await boot()
    const config = await import("../electron/config-store")
    const repo = makeRepo(repoParent, "shop")
    const res = await submit(commands, {
      name: "改版", groupId: "develop", groupIds: ["develop"], featureBranch: "feature/fs-redesign",
      repos: [{ repoPath: repo, baseBranch: "main", testBranch: "develop" }],
    })
    expect(res?.ok).toBe(true)
    const p = store.listProjects()[0]
    for (const k of ["repoPath", "baseBranch", "featureBranch", "repos", "workspaceType"]) expect(p).not.toHaveProperty(k)
    expect(path.basename(p.worktreePath)).toBe("shop")
    expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/fs-redesign")
    expect(repoRows(p)).toEqual({ 代码仓库: `${p.worktreePath}（工作分支 feature/fs-redesign；基线分支 main；测试分支 develop）` })
    expect(config.getRepoProfiles().find((x) => x.path === repo)).toMatchObject({ baseBranch: "main", testBranch: "develop" })
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main")
  })

  it("工作分支由模板定：默认的「测试」模板直接停在测试分支上，不新建分支", async () => {
    const { store, commands } = await boot()
    const repo = makeRepo(repoParent, "shop")
    git(repo, ["branch", "test"])
    const res = await submit(commands, {
      name: "测试看代码", groupId: "test", groupIds: ["test"], featureBranch: "feature/ignored",
      repos: [{ repoPath: repo, baseBranch: "main", testBranch: "test" }],
    })
    expect(res?.ok).toBe(true)
    const p = store.listProjects()[0]
    expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("test")
    expect(git(p.worktreePath, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["main", "test"])
    expect(repoRows(p).代码仓库).toContain("工作分支 test")
  })

  it("设置里取消了「克隆副本」的仓库：不克隆、不碰，项目信息里记的是用户本机的目录", async () => {
    const { store, commands } = await boot()
    const config = await import("../electron/config-store")
    const repo = makeRepo(repoParent, "mine")
    config.saveConfig({ repoProfiles: [{ path: repo, baseBranch: "main", clone: false }], repoRoots: [repo] })
    const head = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8")
    const res = await submit(commands, {
      name: "直接用", groupId: "develop", groupIds: ["develop"], repos: [{ repoPath: repo, baseBranch: "main" }],
    })
    expect(res?.ok).toBe(true)
    const p = store.listProjects()[0]
    expect(path.basename(p.worktreePath)).toBe("workspace")
    expect(fs.readdirSync(path.dirname(p.worktreePath))).toEqual(["workspace"])
    expect(repoRows(p)).toEqual({ 代码仓库: `${repo}（基线分支 main）` })
    expect(fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8")).toBe(head)
    expect(git(repo, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["develop", "main"])
    // 表单提交又走了一遍「记进常用仓库」：别把它的「不克隆」改回默认
    expect(config.getRepoProfiles().find((x) => x.path === repo)?.clone).toBe(false)
  })

  it("一个仓库都不选：照样建，成普通项目目录", async () => {
    const { store, commands } = await boot()
    const res = await submit(commands, { name: "先聊聊", groupId: "develop", groupIds: ["develop"] })
    expect(res?.ok).toBe(true)
    const p = store.listProjects()[0]
    expect(path.basename(p.worktreePath)).toBe("workspace")
    expect(repoRows(p)).toEqual({})
  })

  it("克隆失败：报「创建失败」，不留项目、不留半成品目录，用户的仓库不动", async () => {
    const { store, commands } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const res = await submit(commands, {
      name: "失败", groupId: "develop", groupIds: ["develop"], repos: [{ repoPath: repo, baseBranch: "no-such" }],
    })
    expect(res?.ok).toBe(false)
    expect(res?.message).toContain("创建失败")
    expect(res?.message).toContain("no-such")
    expect(store.listProjects()).toHaveLength(0)
    const root = path.join(userData, "claw-projects")
    expect(fs.existsSync(root) ? fs.readdirSync(root) : []).toEqual([])
    expect(git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("没写名称：拒绝", async () => {
    const { store, commands } = await boot()
    const res = await submit(commands, { name: "", groupId: "general", groupIds: ["general"], workspaceType: "plain" })
    expect(res?.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })
})
