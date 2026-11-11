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

describe("应用内建项目", () => {
  it("建好的项目：通用模板的步骤副本、项目信息、应用内会话键、目录和成果目录", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, {
      name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT", 截止时间: "周五" },
    })
    expect(r).toMatchObject({ ok: true })
    expect(r.warning).toBeUndefined()
    const p = store.getProject(r.projectId!)!
    expect(p.workspaceType).toBe("plain")
    expect(p.externalWorkspace).toBeUndefined()
    expect(p.groupId).toBe("research")
    expect(p.groupSnapshot?.map((g) => g.id)).toEqual(["research"])
    expect(p.metadata).toEqual({ 交付形式: "PPT", 截止时间: "周五" })
    expect(p.notifyChatId).toBe(APP_CHAT)
    expect(p.sessionKey).toBe(`${APP_CHAT}::project_${p.id}`)
    expect(r.sessionKey).toBe(p.sessionKey)
    // 目录在应用数据目录下，成果目录已建好
    expect(path.resolve(p.worktreePath).startsWith(path.resolve(userData))).toBe(true)
    expect(fs.existsSync(path.join(p.worktreePath, ".lk-harness", "artifacts"))).toBe(true)
    // 进入项目会话：daemon 的当前会话切到项目会话
    expect(hit("/api/active-session")).toEqual([
      { url: "/api/active-session", body: { chatId: APP_CHAT, sessionKey: p.sessionKey } },
    ])
  })

  it("同名项目各有各的目录，不会互相覆盖", async () => {
    const { store, create } = await boot()
    const a = await create.createProjectFromApp(APP, { name: "周报", templateId: "general" })
    const b = await create.createProjectFromApp(APP, { name: "周报", templateId: "general" })
    expect(a.ok && b.ok).toBe(true)
    expect(store.getProject(a.projectId!)!.worktreePath).not.toBe(store.getProject(b.projectId!)!.worktreePath)
  })

  it("不动飞书私聊用的全局「当前项目」指针", async () => {
    const { store, create } = await boot()
    const first = store.createProject({
      name: "飞书那边的项目", goal: "", repoPath: "", baseBranch: "", featureBranch: "",
      worktreePath: path.join(userData, "fs-proj", "workspace"), groupIds: ["develop"], groupId: "develop",
    })
    store.setCurrentProjectId(first.id)
    const r = await create.createProjectFromApp(APP, { name: "应用里建的", templateId: "general" })
    expect(r.ok).toBe(true)
    expect(store.getCurrentProjectId()).toBe(first.id)
  })

  it("不是应用内通道不能建；校验不过不留项目", async () => {
    const { store, create } = await boot()
    expect(await create.createProjectFromApp(FEISHU, { name: "x", templateId: "general" })).toEqual({ ok: false, error: "不是应用内对话的通道" })
    expect((await create.createProjectFromApp(APP, { name: "", templateId: "general" })).ok).toBe(false)
    // 开发模板没选仓库：同样不留项目
    const dev = await create.createProjectFromApp(APP, { name: "x", templateId: "develop" })
    expect(dev).toEqual({ ok: false, error: "请至少选一个代码仓库" })
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
    expect(p.sessionKey).toBe(`${APP_CHAT}::project_${r.projectId}`)
    // 项目归应用内通道：后面 daemon 起来、步骤产出通知时按它回到应用内对话
    expect(p.notifyChatId).toBe(APP_CHAT)
  })
})

describe("点步骤", () => {
  it("步骤提示词投进项目会话；不动全局指针；聊天里留一条记录", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "写作", templateId: "writing" })
    const before = store.getCurrentProjectId()
    hits.length = 0

    const run = await create.runProjectStepFromApp(APP, r.projectId!, "outline")
    expect(run).toEqual({ ok: true })
    const enq = hit("/enqueue")
    expect(enq).toHaveLength(1)
    expect(enq[0].body.sessionKey).toBe(r.sessionKey)
    expect(String(enq[0].body.content)).toContain("[PROJECT_ACTION]")
    expect(String(enq[0].body.content)).not.toMatch(/分支与红线|飞书|GitLab/)
    expect(store.getCurrentProjectId()).toBe(before)
    const notice = hit("/cmd/result")
    expect(notice).toHaveLength(1)
    expect(notice[0].body).toMatchObject({ chatId: APP_CHAT, sessionKey: r.sessionKey, ok: true })
    expect(String(notice[0].body.message)).toContain("开始：")
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
    expect(hit("/api/purge-session-routing").map((h) => h.body.sessionKey)).toEqual([p.sessionKey])
    expect(hits.some((h) => h.url.includes("app-chat") && JSON.stringify(h.body).includes(p.sessionKey!))).toBe(true)
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

describe("同步步骤和项目信息", () => {
  it("全局模板改了，项目的步骤副本在同步前不变、同步后跟上", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(APP, { name: "周报", templateId: "report" })
    const groups = store.getNodeGroups()
    store.saveNodeGroups(groups.map((g) => g.id === "report"
      ? { ...g, nodes: [...g.nodes, { id: "extra", label: "多一步" }] }
      : g))

    const before = create.getProjectView(r.projectId!, APP)!
    expect(before.steps.map((s) => s.id)).not.toContain("extra")
    expect(before.canSyncSteps).toBe(true)

    expect(create.syncProjectSteps(r.projectId!)).toEqual({ ok: true })
    const after = create.getProjectView(r.projectId!, APP)!
    expect(after.steps.map((s) => s.id)).toContain("extra")
    expect(after.canSyncSteps).toBe(false)
  })

  it("没有步骤副本的老项目：不用同步；项目不存在：报错", async () => {
    const { store, create } = await boot()
    const old = store.createProject({
      name: "老项目", goal: "", repoPath: "", baseBranch: "", featureBranch: "",
      worktreePath: path.join(userData, "old", "workspace"), groupIds: ["develop"], groupId: "develop",
    })
    expect(create.syncProjectSteps(old.id).ok).toBe(false)
    expect(create.syncProjectSteps("000000000000").ok).toBe(false)
    expect(create.getProjectView("000000000000", APP)).toBeNull()
  })

  it("模板列表：开发模板标明要接代码仓库，通用类不用", async () => {
    const { create } = await boot()
    const list = create.listProjectTemplates()
    expect(list.find((t) => t.id === "general")?.needsRepo).toBe(false)
    expect(list.find((t) => t.id === "develop")?.needsRepo).toBe(true)
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

  it("克隆出独立的工作目录并检出 feature，用户自己的仓库原样不动", async () => {
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
      workspaceType: "worktree", repoPath: repo, baseBranch: "main", featureBranch: "feature/redesign",
      groupId: "develop", storyUrl: "https://t.example.com/1", relatedDocs: "见 wiki",
      notifyChatId: APP_CHAT, sessionKey: `${APP_CHAT}::project_${p.id}`,
    })
    expect(p.externalWorkspace).toBeUndefined()
    expect(p.groupSnapshot?.map((g) => g.id)).toEqual(["develop"])
    expect(p.repos).toHaveLength(1)
    const wt = p.repos![0].worktreePath
    expect(p.worktreePath).toBe(wt)
    // 工作目录在应用数据目录下的项目目录里，是独立克隆，停在 feature 分支
    expect(path.resolve(wt).startsWith(path.resolve(userData))).toBe(true)
    expect(path.basename(wt)).toBe("shop")
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/redesign")
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(wt, ".lk-harness", "artifacts"))).toBe(true)
    expect(fs.readFileSync(path.join(wt, ".git", "info", "exclude"), "utf8")).toContain(".lk-harness/")
    // 用户的仓库：还在 main、没多分支、没脏文件
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main")
    expect(git(repo, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).sort()).toEqual(["develop", "main"])
    expect(git(repo, ["status", "--porcelain"])).toBe("")
    // 进入项目会话
    expect(hit("/api/active-session")).toEqual([
      { url: "/api/active-session", body: { chatId: APP_CHAT, sessionKey: p.sessionKey } },
    ])
  })

  it("不填 feature 分支：按「feature/日期-项目名」生成；基线可以是别的分支", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "api")
    const r = await create.createProjectFromApp(APP, { name: "login", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "develop" }] })
    expect(r.ok).toBe(true)
    const p = store.getProject(r.projectId!)!
    expect(p.featureBranch).toMatch(/^feature\/\d{6}-login$/)
    expect(p.baseBranch).toBe("develop")
    expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(p.featureBranch)
  })

  it("用到的仓库自动记进常用仓库；记过的原样不动（测试/开发分支保留、基线不被这次顶掉），并带进项目", async () => {
    const { store, create } = await boot()
    const config = await import("../electron/config-store")
    const fresh = makeRepo(repoParent, "fresh")
    const known = makeRepo(repoParent, "known")
    config.saveConfig({ repoProfiles: [{ path: known, baseBranch: "main", testBranch: "test", developBranch: "dev" }], repoRoots: [known] })

    const r = await create.createProjectFromApp(APP, {
      name: "两仓", templateId: "develop",
      repos: [{ repoPath: fresh, baseBranch: "main" }, { repoPath: known, baseBranch: "develop" }],
    })
    expect(r.ok).toBe(true)
    const profiles = config.getRepoProfiles()
    expect(profiles.find((x) => x.path === fresh)).toMatchObject({ baseBranch: "main" })
    expect(profiles.find((x) => x.path === known)).toEqual({ path: known, baseBranch: "main", testBranch: "test", developBranch: "dev" })
    const p = store.getProject(r.projectId!)!
    expect(p.repos!.map((x) => path.basename(x.worktreePath))).toEqual(["fresh", "known"])
    expect(p.repos![1]).toMatchObject({ baseBranch: "develop", testBranch: "test", developBranch: "dev" })
    expect(p.repos![0].testBranch).toBeUndefined()
    // 常用仓库列表给建项界面用
    expect(create.listProjectRepoOptions().map((o) => o.name).sort()).toEqual(["fresh", "known"])
  })

  it("两个同名仓库（不同位置）：工作目录名自动加序号，互不覆盖", async () => {
    const { store, create } = await boot()
    const a = makeRepo(path.join(repoParent, "a"), "foo")
    const b = makeRepo(path.join(repoParent, "b"), "foo")
    const r = await create.createProjectFromApp(APP, {
      name: "同名", templateId: "develop",
      repos: [{ repoPath: a, baseBranch: "main" }, { repoPath: b, baseBranch: "main" }],
    })
    expect(r.ok).toBe(true)
    const names = store.getProject(r.projectId!)!.repos!.map((x) => path.basename(x.worktreePath))
    expect(names).toEqual(["foo", "foo-2"])
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

  it("不是 git 仓库根目录、不存在、分支名不合法：都拒绝，且都不克隆", async () => {
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
      expect(r.error, feature).toContain("feature 分支名不合法")
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

  it("daemon 没启动：项目照样建好，带提示", async () => {
    const { store, create } = await boot()
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "离线", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }] })
    expect(r.ok).toBe(true)
    expect(r.warning).toContain("服务未运行")
    expect(store.getProject(r.projectId!)!.workspaceType).toBe("worktree")
  })

  it("点快捷操作：提示词带研发的分支规则（通用项目没有），投进项目会话", async () => {
    const { create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/x" })
    hits.length = 0
    expect(await create.runProjectStepFromApp(APP, r.projectId!, "plan")).toEqual({ ok: true })
    const enq = hit("/enqueue")
    expect(enq).toHaveLength(1)
    expect(enq[0].body.sessionKey).toBe(r.sessionKey)
    expect(String(enq[0].body.content)).toContain("[PROJECT_ACTION]")
    expect(String(enq[0].body.content)).toContain("分支与红线")
  })

  it("项目信息：标成研发项目，带分支；删除时整个项目目录进回收站，用户自己的仓库不动", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectFromApp(APP, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/x" })
    const view = create.getProjectView(r.projectId!, APP)!
    expect(view).toMatchObject({ isCode: true, featureBranch: "feature/x", ownedHere: true })
    const p = store.getProject(r.projectId!)!
    expect((await create.deleteProjectByUser(p.id, { channelId: APP })).ok).toBe(true)
    expect(trashed).toEqual([path.dirname(p.worktreePath)])
    expect(git(repo, ["status", "--porcelain"])).toBe("")
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true)
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

  /** 飞书那边建好、已经进过会话的项目：它的会话和通知都绑在飞书私聊上 */
  async function feishuProject() {
    const booted = await boot()
    const dir = path.join(userData, "fs-proj", "workspace")
    fs.mkdirSync(dir, { recursive: true })
    const p = booted.store.createProject({
      name: "飞书项目", goal: "", repoPath: "", baseBranch: "", featureBranch: "",
      worktreePath: dir, groupIds: ["writing"], groupId: "writing", workspaceType: "plain",
      notifyChatId: FS_CHAT,
    })
    p.sessionKey = `${FS_CHAT}::project_${p.id}`
    booted.store.saveProject(p)
    hits.length = 0
    return { ...booted, p }
  }

  it("在应用里点它的步骤会被拒绝，它的会话绑定原样不动，也不投任何提示词", async () => {
    const { store, create, p } = await feishuProject()
    const run = await create.runProjectStepFromApp(APP, p.id, "outline")
    expect(run.ok).toBe(false)
    expect(run.error).toContain("其它通道")
    expect(store.getProject(p.id)).toMatchObject({ sessionKey: `${FS_CHAT}::project_${p.id}`, notifyChatId: FS_CHAT })
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

  it("自己建的项目：应用内删除（带通道）可以", async () => {
    const { store, create } = await boot()
    const mine = await create.createProjectFromApp(APP, { name: "我的", templateId: "general" })
    expect((await create.deleteProjectByUser(mine.projectId!, { channelId: APP })).ok).toBe(true)
    expect(store.getProject(mine.projectId!)).toBeUndefined()
  })
})
