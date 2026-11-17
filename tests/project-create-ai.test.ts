import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { APP_CHANNEL_CHAT_ID, makeChatKey } from "../src/shared/channel-types"
import { projectRootDir } from "../src/shared/project-types"

/**
 * AI 建项（管理 MCP 的 manage_project create 在宿主侧的落地）：真实的 config-store、project-store、project-create，
 * 只把落盘的 electron-store、electron 和假 daemon 顶掉。
 * 守住几件事：应用内 / 飞书 / 微信的主用户私聊都能建；建完不进入项目会话、不建群、不动全局「当前项目」指针；
 * 非主用户和认不出的通道一律拒绝；同名并发只放一个；建好的项目用户之后能用 /p use 进入。
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
const WECHAT = "ch_wx"
const APP_CHAT = makeChatKey(APP, APP_CHANNEL_CHAT_ID)
const FS_CHAT = makeChatKey(FEISHU, "ou_main")
const WX_CHAT = makeChatKey(WECHAT, "wx_main")

type Hit = { url: string; body: Record<string, unknown> }
let hits: Hit[] = []
let server: http.Server
let port = 0
let folder = ""
let repoParent = ""

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ai-"))
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ai-user-"))
  repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ai-repos-"))
  hits = []
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
  port = (server.address() as { port: number }).port
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify({ pid: 1, port, version: "test" }))
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(folder, { recursive: true, force: true })
  fs.rmSync(repoParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as fs.RmOptions)
})

function channel(id: string, type: "app" | "feishu" | "wechat", over: Record<string, unknown> = {}) {
  return {
    id, name: id, enabled: true, type, agentResourceId: "sdk_t", model: "auto", modelParams: "",
    othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
    mainUserEnabled: true,
    mainUserChatId: type === "app" ? APP_CHANNEL_CHAT_ID : type === "feishu" ? "ou_main" : "wx_main",
    ...over,
  }
}

async function boot(channelOverrides: Record<string, Record<string, unknown>> = {}) {
  vi.resetModules()
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [
      channel(APP, "app", channelOverrides[APP]),
      channel(FEISHU, "feishu", channelOverrides[FEISHU]),
      channel(WECHAT, "wechat", channelOverrides[WECHAT]),
    ] as never,
    agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
    favWorkspacesMigrated: true,
  })
  const store = await import("../src/shared/project-store")
  store.initProjectStore(userData)
  const create = await import("../electron/project-create")
  const commands = await import("../electron/project-commands")
  return { store, create, commands, config }
}

const hit = (url: string) => hits.filter((h) => h.url === url)

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
  return (r.stdout || "").trim()
}

/** 项目目录都建在这下面（不是项目库所在的 userData/projects） */
function projectDirs(create: { projectsRootDir: () => string }): string[] {
  const root = create.projectsRootDir()
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : []
}

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
  return repo
}

describe("AI 建项：各通道的主用户私聊", () => {
  it.each([
    ["应用内对话", APP_CHAT, APP_CHAT],
    ["飞书", FS_CHAT, FS_CHAT],
    ["微信", WX_CHAT, WX_CHAT],
  ])("%s：项目建好，绑在调用者的聊天上；不进入会话、不建群、不碰全局当前项目", async (_name, chatKey, boundTo) => {
    const { store, create } = await boot()
    const other = store.createProject({
      name: "飞书私聊正在用的", goal: "",
      worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
    })
    store.setCurrentProjectId(other.id)

    const r = await create.createProjectForAi(chatKey, { name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT" } })
    expect(r).toMatchObject({ ok: true, name: "Q4 调研", templateName: expect.any(String) })
    if (!r.ok) return
    expect(r.projectId).toMatch(/\S+/)

    const p = store.getProject(r.projectId)!
    expect(p).toMatchObject({ name: "Q4 调研", goal: "看清竞品", groupId: "research" })
    expect(p.metadata).toEqual({ 交付形式: "PPT" })
    expect(p.notifyChatId).toBe(boundTo)
    expect(p.sessionKey).toBe(`${boundTo}::project_${p.id}`)
    expect(p.groupChatId).toBeUndefined()
    expect(path.resolve(p.worktreePath).startsWith(path.resolve(userData))).toBe(true)
    // 告诉 AI 的是项目目录（设置页项目列表里显示的那个），工作目录在它下面
    expect(r.dir).toBe(projectRootDir(p))
    expect(path.resolve(p.worktreePath).startsWith(path.resolve(r.dir))).toBe(true)
    expect(fs.existsSync(path.join(p.worktreePath, ".lk-harness", "artifacts"))).toBe(true)

    // 建完什么都没发给 daemon：没有切会话，也没有建群
    expect(hits).toEqual([])
    expect(store.getCurrentProjectId()).toBe(other.id)
    expect(store.listProjects().map((x) => x.id)).toContain(r.projectId)
  })

  it("应用内对话：不管调用者的聊天键写成什么，都绑到该通道固定的主用户聊天", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectForAi(makeChatKey(APP, "app_whatever"), { name: "n", templateId: "general" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(store.getProject(r.projectId)!.notifyChatId).toBe(APP_CHAT)
  })

  it("建好的项目，用户在原聊天里发 /p use <ID> 就能进入；绑定不用纠正", async () => {
    const { store, create, commands } = await boot()
    for (const chat of [FS_CHAT, WX_CHAT, APP_CHAT]) {
      hits.length = 0
      const r = await create.createProjectForAi(chat, { name: `p-${chat}`, templateId: "general" })
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const p = store.getProject(r.projectId)!
      const before = p.sessionKey
      await commands.handleFeishuProjectCommand(port, "m1", `/p use ${r.projectId}`, chat)
      expect(hit("/api/active-session")).toEqual([{ url: "/api/active-session", body: { chatId: chat, sessionKey: before } }])
      expect(store.getProject(r.projectId)!.sessionKey).toBe(before)
    }
  })

  it("接代码仓库的模板：真克隆；仓库记进常用仓库，下次 repos 能列出来", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectForAi(FS_CHAT, {
      name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/redesign",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = store.getProject(r.projectId)!
    expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/redesign")
    expect(p.metadata?.代码仓库).toContain("feature/redesign")
    expect(git(repo, ["status", "--porcelain"])).toBe("")
    expect(hits).toEqual([])
    const options = create.listProjectRepoOptions()
    expect(options.map((o) => o.path)).toContain(path.resolve(repo))
  })
})

describe("AI 建项：拒绝的情况，一律不留项目", () => {
  it("不是主用户的聊天（其他人私聊、群聊）、主用户没开、认不出的通道：拒绝", async () => {
    const { store, create } = await boot()
    const cases: [string, string][] = [
      [makeChatKey(FEISHU, "ou_other"), "只有主用户"],
      [makeChatKey(FEISHU, "oc_group_1"), "只有主用户"],
      [makeChatKey(WECHAT, "wx_other"), "只有主用户"],
      [makeChatKey("ch_nope", "x"), "找不到你所在的消息通道"],
      ["oc_legacy_without_channel", "找不到你所在的消息通道"],
      ["", "找不到你所在的消息通道"],
    ]
    for (const [chat, hint] of cases) {
      const r = await create.createProjectForAi(chat, { name: "x", templateId: "general" })
      expect(r.ok, chat).toBe(false)
      expect(!r.ok && r.error, chat).toContain(hint)
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])

    const off = await boot({ [FEISHU]: { mainUserEnabled: false } })
    const r = await off.create.createProjectForAi(FS_CHAT, { name: "x", templateId: "general" })
    expect(r.ok).toBe(false)
    expect(off.store.listProjects()).toHaveLength(0)
  })

  it("校验不过：必填没填、模板不存在、仓库路径不是完整路径、名字空——原因带回来，不留目录和项目", async () => {
    const { store, create } = await boot()
    store.saveNodeGroups(store.getNodeGroups().map((g) => g.id === "research"
      ? { ...g, fields: [{ label: "交付形式", required: true }, { label: "截止时间" }] }
      : g))
    const before = projectDirs(create)
    const miss = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "research", fields: { 截止时间: "周五" } })
    expect(miss).toEqual({ ok: false, error: "请填写：交付形式" })
    const noTpl = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "nope" })
    expect(!noTpl.ok && noTpl.error).toContain("模板不存在")
    const rel = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "develop", repos: [{ repoPath: "relative/shop", baseBranch: "main" }] })
    expect(!rel.ok && rel.error).toContain("完整路径")
    const noName = await create.createProjectForAi(FS_CHAT, { name: "  ", templateId: "general" })
    expect(!noName.ok && noName.error).toContain("项目名称")
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
  })

  it("克隆失败（基线分支不存在）：整个项目目录收掉，不留半成品", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const before = projectDirs(create)
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such" }] })
    expect(r.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
  })

  it("建成功的会多出一个项目目录（上面「不留目录」的检查不是空转）", async () => {
    const { create } = await boot()
    const before = projectDirs(create)
    expect((await create.createProjectForAi(FS_CHAT, { name: "有目录", templateId: "general" })).ok).toBe(true)
    expect(projectDirs(create)).toHaveLength(before.length + 1)
  })
})

describe("AI 建项：同名并发防重", () => {
  it("同一个聊天里同名的两个请求同时到：只建一个，另一个被告知正在创建；做完后可以再建", async () => {
    const { store, create } = await boot()
    const [a, b] = await Promise.all([
      create.createProjectForAi(FS_CHAT, { name: "周报", templateId: "general" }),
      create.createProjectForAi(FS_CHAT, { name: " 周报 ", templateId: "general" }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(!loser.ok && loser.error).toContain("正在创建中")
    expect(!loser.ok && loser.error).toContain("list")
    expect(store.listProjects()).toHaveLength(1)
    expect((await create.createProjectForAi(FS_CHAT, { name: "周报", templateId: "general" })).ok).toBe(true)
    expect(store.listProjects()).toHaveLength(2)
  })

  it("名字不同、或聊天不同：互不影响；失败后占位也会释放", async () => {
    const { store, create } = await boot()
    const rs = await Promise.all([
      create.createProjectForAi(FS_CHAT, { name: "甲", templateId: "general" }),
      create.createProjectForAi(FS_CHAT, { name: "乙", templateId: "general" }),
      create.createProjectForAi(APP_CHAT, { name: "甲", templateId: "general" }),
      create.createProjectForAi(WX_CHAT, { name: "甲", templateId: "general" }),
    ])
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(store.listProjects()).toHaveLength(4)

    const bad = await create.createProjectForAi(FS_CHAT, { name: "丙", templateId: "nope" })
    expect(bad.ok).toBe(false)
    expect((await create.createProjectForAi(FS_CHAT, { name: "丙", templateId: "general" })).ok).toBe(true)
  })
})

describe("宿主请求处理函数（project.templates / project.repos / project.create）", () => {
  it("templates / repos：就是应用里「新建项目」界面用的那两份数据", async () => {
    const { create } = await boot()
    const h = create.projectHostRpcHandlers
    expect(Object.keys(h).sort()).toEqual(["project.create", "project.repos", "project.templates"])
    const templates = (await h["project.templates"]({})) as { id: string; needsRepo: boolean }[]
    expect(templates.map((t) => t.id)).toEqual(expect.arrayContaining(["general", "develop", "research"]))
    expect(templates.find((t) => t.id === "develop")?.needsRepo).toBe(true)
    expect(templates.find((t) => t.id === "general")?.needsRepo).toBe(false)
    expect(await h["project.repos"]({})).toEqual(create.listProjectRepoOptions())
  })

  it("create：入参只认字符串；folder 认（不接代码仓库的模板可以用已有文件夹，里面的文件不动）", async () => {
    const { store, create } = await boot()
    fs.writeFileSync(path.join(folder, "资料.md"), "我的资料")
    const r = (await create.projectHostRpcHandlers["project.create"]({
      chatKey: FS_CHAT,
      input: { name: "整理资料", templateId: "writing", folder, fields: { 交付形式: 5, 备注: "好" }, goal: 123, repos: "坏的" },
    })) as Awaited<ReturnType<typeof create.createProjectForAi>>
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = store.getProject(r.projectId)!
    expect(p.externalWorkspace).toBe(true)
    expect(p.worktreePath).toBe(path.resolve(folder))
    expect(p.goal).toBe("")
    expect(fs.readFileSync(path.join(folder, "资料.md"), "utf8")).toBe("我的资料")
    expect(hits).toEqual([])
  })

  it("create：没给聊天 / 没给 input / 名字不是字符串：报错，不抛异常", async () => {
    const { store, create } = await boot()
    const run = (payload: unknown) => create.projectHostRpcHandlers["project.create"](payload) as Promise<{ ok: boolean; error?: string }>
    expect((await run({ input: { name: "x", templateId: "general" } })).error).toContain("找不到你所在的消息通道")
    expect((await run({ chatKey: FS_CHAT })).ok).toBe(false)
    expect((await run({ chatKey: FS_CHAT, input: { name: 5, templateId: "general" } })).error).toContain("项目名称")
    expect((await run(undefined)).ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })
})
