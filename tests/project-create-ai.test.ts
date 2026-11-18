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
 * 守住几件事：应用内 / 飞书 / 微信的主用户私聊都能建；建完不进入项目会话、不动全局「当前项目」指针；
 * 会话落点（chat_mode）必须明确指定、没有默认值：inline 不建群，group 建飞书独立群，bind 绑定已有群，
 * 后两种只有飞书私聊能用，建群 / 绑群失败项目保留并带回原因；
 * 非主用户和认不出的通道一律拒绝；同名并发只放一个；inline 建好的项目用户之后能用 /p use 进入。
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

const INLINE = { mode: "inline" } as const
const MAIN_OPEN_ID = "ou_main_open"
const NEW_GROUP_ID = "oc_newgroup0001"
const EXISTING_GROUP_ID = "oc_aa2192cfececee92d57dccd0b59980fd"

type Hit = { url: string; body: Record<string, unknown> }
let hits: Hit[] = []
/** 假 daemon 对各个接口的应答；默认都回 { ok: true }。 */
let reply: (url: string, body: Record<string, unknown>) => unknown = () => ({ ok: true })
let server: http.Server
let port = 0
let folder = ""
let repoParent = ""

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ai-"))
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ai-user-"))
  repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ai-repos-"))
  hits = []
  reply = () => ({ ok: true })
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c as Buffer))
    req.on("end", () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}") } catch { /* 空体 */ }
      hits.push({ url: req.url ?? "", body })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(reply(req.url ?? "", body)))
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

    const r = await create.createProjectForAi(chatKey, { name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT" } }, INLINE)
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
    const r = await create.createProjectForAi(makeChatKey(APP, "app_whatever"), { name: "n", templateId: "general" }, INLINE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(store.getProject(r.projectId)!.notifyChatId).toBe(APP_CHAT)
  })

  it("建好的项目，用户在原聊天里发 /p use <ID> 就能进入；绑定不用纠正", async () => {
    const { store, create, commands } = await boot()
    for (const chat of [FS_CHAT, WX_CHAT, APP_CHAT]) {
      hits.length = 0
      const r = await create.createProjectForAi(chat, { name: `p-${chat}`, templateId: "general" }, INLINE)
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
    }, INLINE)
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
      const r = await create.createProjectForAi(chat, { name: "x", templateId: "general" }, INLINE)
      expect(r.ok, chat).toBe(false)
      expect(!r.ok && r.error, chat).toContain(hint)
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])

    const off = await boot({ [FEISHU]: { mainUserEnabled: false } })
    const r = await off.create.createProjectForAi(FS_CHAT, { name: "x", templateId: "general" }, INLINE)
    expect(r.ok).toBe(false)
    expect(off.store.listProjects()).toHaveLength(0)
  })

  it("校验不过：必填没填、模板不存在、仓库路径不是完整路径、名字空——原因带回来，不留目录和项目", async () => {
    const { store, create } = await boot()
    store.saveNodeGroups(store.getNodeGroups().map((g) => g.id === "research"
      ? { ...g, fields: [{ label: "交付形式", required: true }, { label: "截止时间" }] }
      : g))
    const before = projectDirs(create)
    const miss = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "research", fields: { 截止时间: "周五" } }, INLINE)
    expect(miss).toEqual({ ok: false, error: "请填写：交付形式" })
    const noTpl = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "nope" }, INLINE)
    expect(!noTpl.ok && noTpl.error).toContain("模板不存在")
    const rel = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "develop", repos: [{ repoPath: "relative/shop", baseBranch: "main" }] }, INLINE)
    expect(!rel.ok && rel.error).toContain("完整路径")
    const noName = await create.createProjectForAi(FS_CHAT, { name: "  ", templateId: "general" }, INLINE)
    expect(!noName.ok && noName.error).toContain("项目名称")
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
  })

  it("克隆失败（基线分支不存在）：整个项目目录收掉，不留半成品", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const before = projectDirs(create)
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such" }] }, INLINE)
    expect(r.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
  })

  it("建成功的会多出一个项目目录（上面「不留目录」的检查不是空转）", async () => {
    const { create } = await boot()
    const before = projectDirs(create)
    expect((await create.createProjectForAi(FS_CHAT, { name: "有目录", templateId: "general" }, INLINE)).ok).toBe(true)
    expect(projectDirs(create)).toHaveLength(before.length + 1)
  })
})

describe("AI 建项：同名并发防重", () => {
  it("同一个聊天里同名的两个请求同时到：只建一个，另一个被告知正在创建；做完后可以再建", async () => {
    const { store, create } = await boot()
    const [a, b] = await Promise.all([
      create.createProjectForAi(FS_CHAT, { name: "周报", templateId: "general" }, INLINE),
      create.createProjectForAi(FS_CHAT, { name: " 周报 ", templateId: "general" }, INLINE),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(!loser.ok && loser.error).toContain("正在创建中")
    expect(!loser.ok && loser.error).toContain("list")
    expect(store.listProjects()).toHaveLength(1)
    expect((await create.createProjectForAi(FS_CHAT, { name: "周报", templateId: "general" }, INLINE)).ok).toBe(true)
    expect(store.listProjects()).toHaveLength(2)
  })

  it("名字不同、或聊天不同：互不影响；失败后占位也会释放", async () => {
    const { store, create } = await boot()
    const rs = await Promise.all([
      create.createProjectForAi(FS_CHAT, { name: "甲", templateId: "general" }, INLINE),
      create.createProjectForAi(FS_CHAT, { name: "乙", templateId: "general" }, INLINE),
      create.createProjectForAi(APP_CHAT, { name: "甲", templateId: "general" }, INLINE),
      create.createProjectForAi(WX_CHAT, { name: "甲", templateId: "general" }, INLINE),
    ])
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(store.listProjects()).toHaveLength(4)

    const bad = await create.createProjectForAi(FS_CHAT, { name: "丙", templateId: "nope" }, INLINE)
    expect(bad.ok).toBe(false)
    expect((await create.createProjectForAi(FS_CHAT, { name: "丙", templateId: "general" }, INLINE)).ok).toBe(true)
  })
})

describe("宿主请求处理函数（project.templates / project.repos / project.create）", () => {
  it("templates / repos：就是应用里「新建项目」界面用的那两份数据", async () => {
    const { create } = await boot()
    const h = create.projectHostRpcHandlers
    // 创建 / 选项两类在这里测；其余是项目管理类（行为见 project-admin-host.test.ts）
    expect(Object.keys(h).sort()).toEqual([
      "project.archive", "project.create", "project.get", "project.repo.remove", "project.repo.save", "project.repos",
      "project.settings.get", "project.settings.set", "project.sync-steps", "project.template.delete", "project.template.detail",
      "project.template.save", "project.templates", "project.update",
    ])
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
      chatMode: "inline",
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
    expect((await run({ input: { name: "x", templateId: "general" }, chatMode: "inline" })).error).toContain("找不到你所在的消息通道")
    expect((await run({ chatKey: FS_CHAT, chatMode: "inline" })).ok).toBe(false)
    expect((await run({ chatKey: FS_CHAT, chatMode: "inline", input: { name: 5, templateId: "general" } })).error).toContain("项目名称")
    expect((await run(undefined)).ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })

  it("create：chatMode / existingGroupChatId 从入参里取，只认字符串；没给 chatMode 就报错", async () => {
    const { store, create } = await boot()
    const run = (payload: unknown) => create.projectHostRpcHandlers["project.create"](payload) as Promise<{ ok: boolean; error?: string; chatMode?: string; groupChatId?: string }>
    const input = { name: "x", templateId: "general" }
    expect((await run({ chatKey: FS_CHAT, input })).error).toContain("chat_mode")
    expect((await run({ chatKey: FS_CHAT, input, chatMode: 5 })).error).toContain("chat_mode")
    expect((await run({ chatKey: FS_CHAT, input, chatMode: "bind", existingGroupChatId: 9 })).error).toContain("existing_group_chat_id")
    expect(store.listProjects()).toHaveLength(0)
    const bound = await run({ chatKey: FS_CHAT, input, chatMode: "bind", existingGroupChatId: EXISTING_GROUP_ID })
    expect(bound).toMatchObject({ ok: true, chatMode: "bind", groupChatId: EXISTING_GROUP_ID })
    expect(store.listProjects()).toHaveLength(1)
  })
})

describe("AI 建项：chat_mode 必须明确指定，没有默认值", () => {
  it.each([
    ["没给", {}],
    ["空白", { mode: "  " }],
    ["不认识的值", { mode: "dedicated" }],
  ])("%s：报错并让 AI 去问用户；不建项目、不建目录、不碰 daemon（各通道一样）", async (_name, chat) => {
    const { store, create } = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    const before = projectDirs(create)
    for (const where of [APP_CHAT, FS_CHAT, WX_CHAT]) {
      const r = await create.createProjectForAi(where, { name: "x", templateId: "general" }, chat)
      expect(r.ok, where).toBe(false)
      expect(!r.ok && r.error, where).toContain("chat_mode")
      expect(!r.ok && r.error, where).toContain("send_question")
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
    expect(hits).toEqual([])
  })

  it("bind 没给群号：报错，不建项目", async () => {
    const { store, create } = await boot()
    for (const id of [undefined, "", "  "]) {
      const r = await create.createProjectForAi(FS_CHAT, { name: "x", templateId: "general" }, { mode: "bind", existingGroupChatId: id })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain("existing_group_chat_id")
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })

  it("不是主用户 / 认不出通道时，先报这个，而不是 chat_mode（先认人，再谈怎么建）", async () => {
    const { create } = await boot()
    const r = await create.createProjectForAi(makeChatKey(FEISHU, "ou_other"), { name: "x", templateId: "general" }, {})
    expect(!r.ok && r.error).toContain("只有主用户")
    const r2 = await create.createProjectForAi("", { name: "x", templateId: "general" }, {})
    expect(!r2.ok && r2.error).toContain("找不到你所在的消息通道")
  })

  it.each([
    ["应用内对话", APP_CHAT],
    ["微信", WX_CHAT],
  ])("%s：group / bind 都不能用，让 AI 改用 inline；不建项目、不碰 daemon", async (_name, chat) => {
    const { store, create } = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    for (const choice of [{ mode: "group" }, { mode: "bind", existingGroupChatId: EXISTING_GROUP_ID }]) {
      const r = await create.createProjectForAi(chat, { name: "x", templateId: "general" }, choice)
      expect(r.ok, choice.mode).toBe(false)
      expect(!r.ok && r.error, choice.mode).toContain("inline")
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })
})

describe("AI 建项：chat_mode=group（建飞书独立群）", () => {
  const GROUP_KEY = makeChatKey(FEISHU, NEW_GROUP_ID)
  const daemonCreatesGroup = () => {
    reply = (url) => (url === "/create-project-group" ? { ok: true, chatKey: GROUP_KEY } : { ok: true })
  }
  const bootFeishu = () => boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })

  it("群主是主用户，项目绑到新群，项目卡发进群；不离开当前会话、不动全局当前项目", async () => {
    const { store, create } = await bootFeishu()
    daemonCreatesGroup()
    const other = store.createProject({
      name: "正在用的", goal: "", worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
    })
    store.setCurrentProjectId(other.id)

    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", goal: "把首页改掉", templateId: "general" }, { mode: "group" })
    expect(r).toMatchObject({ ok: true, name: "改版", chatMode: "group", groupName: "📦 改版", groupChatId: NEW_GROUP_ID })
    if (!r.ok) return
    expect(r.warning).toBeUndefined()

    expect(hit("/create-project-group")).toEqual([{
      url: "/create-project-group",
      body: { name: "📦 改版", description: "把首页改掉", channelId: FEISHU, ownerOpenId: MAIN_OPEN_ID },
    }])
    // 项目卡只发往新群，不回私聊；没有切会话
    const cards = hit("/cmd/result")
    expect(cards).toHaveLength(1)
    expect(cards[0].body).toMatchObject({ ok: true, messageId: "", message: "", chatId: GROUP_KEY, sessionKey: `${GROUP_KEY}::project_${r.projectId}` })
    expect(hit("/api/active-session")).toEqual([])

    const p = store.getProject(r.projectId)!
    expect(p.groupChatId).toBe(GROUP_KEY)
    expect(p.notifyChatId).toBe(GROUP_KEY)
    expect(p.sessionKey).toBe(`${GROUP_KEY}::project_${p.id}`)
    expect(store.findProjectByGroupChat(GROUP_KEY)?.id).toBe(r.projectId)
    expect(store.getCurrentProjectId()).toBe(other.id)
  })

  it("没有记录主用户的 open_id：建项前就报错，不建项目、不建群，提示改用 inline", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, { mode: "group" })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("open_id")
    expect(!r.ok && r.error).toContain("inline")
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })

  it("建群接口失败：项目保留并绑在调用者的聊天上，warning 写明原因；不发项目卡、不动全局当前项目", async () => {
    const { store, create } = await bootFeishu()
    reply = (url) => (url === "/create-project-group" ? { ok: false, error: "建群失败: 无权限" } : { ok: true })
    const other = store.createProject({
      name: "正在用的", goal: "", worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
    })
    store.setCurrentProjectId(other.id)

    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, { mode: "group" })
    expect(r).toMatchObject({ ok: true, chatMode: "inline" })
    if (!r.ok) return
    expect(r.warning).toContain("建独立群没成功")
    expect(r.warning).toContain("无权限")
    expect(r.groupName).toBeUndefined()
    expect(r.groupChatId).toBeUndefined()

    const p = store.getProject(r.projectId)!
    expect(p.groupChatId).toBeUndefined()
    expect(p.notifyChatId).toBe(FS_CHAT)
    expect(p.sessionKey).toBe(`${FS_CHAT}::project_${p.id}`)
    expect(hit("/cmd/result")).toEqual([])
    expect(store.getCurrentProjectId()).toBe(other.id)
  })

  it("后台服务没在运行（没有端口）：同样保留项目、带 warning，不抛异常", async () => {
    const { store, create } = await bootFeishu()
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, { mode: "group" })
    expect(r).toMatchObject({ ok: true, chatMode: "inline" })
    expect(r.ok && r.warning).toContain("没有在运行")
    expect(store.listProjects()).toHaveLength(1)
    expect(hits).toEqual([])
  })

  it("项目没建成（校验没过、克隆失败）：不建群", async () => {
    const { store, create } = await bootFeishu()
    daemonCreatesGroup()
    const bad = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "nope" }, { mode: "group" })
    expect(bad.ok).toBe(false)
    const repo = makeRepo(repoParent, "shop")
    const clone = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such" }] }, { mode: "group" })
    expect(clone.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    expect(hit("/create-project-group")).toEqual([])
    expect(hit("/cmd/result")).toEqual([])
  })
})

describe("AI 建项：chat_mode=bind（绑定已有飞书群）", () => {
  const EXISTING_KEY = makeChatKey(FEISHU, EXISTING_GROUP_ID)

  it("项目绑到该群，项目卡发进群；不建群、不离开当前会话、不动全局当前项目", async () => {
    const { store, create } = await boot()
    const other = store.createProject({
      name: "正在用的", goal: "", worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
    })
    store.setCurrentProjectId(other.id)

    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, { mode: "bind", existingGroupChatId: EXISTING_GROUP_ID })
    expect(r).toMatchObject({ ok: true, chatMode: "bind", groupChatId: EXISTING_GROUP_ID })
    if (!r.ok) return
    expect(r.groupName).toBeUndefined()
    expect(r.warning).toBeUndefined()

    expect(hit("/create-project-group")).toEqual([])
    const cards = hit("/cmd/result")
    expect(cards).toHaveLength(1)
    expect(cards[0].body).toMatchObject({ ok: true, chatId: EXISTING_KEY, sessionKey: `${EXISTING_KEY}::project_${r.projectId}` })
    expect(hit("/api/active-session")).toEqual([])

    const p = store.getProject(r.projectId)!
    expect(p.groupChatId).toBe(EXISTING_KEY)
    expect(p.notifyChatId).toBe(EXISTING_KEY)
    expect(p.sessionKey).toBe(`${EXISTING_KEY}::project_${p.id}`)
    expect(store.getCurrentProjectId()).toBe(other.id)
  })

  it("群号格式不对 / 已绑给别的项目：建项前就拒绝，不建项目；原来那个项目不受影响", async () => {
    const { store, create } = await boot()
    const bad = await create.createProjectForAi(FS_CHAT, { name: "甲", templateId: "general" }, { mode: "bind", existingGroupChatId: "not-a-group" })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toContain("chat_id")
    expect(store.listProjects()).toHaveLength(0)

    const first = await create.createProjectForAi(FS_CHAT, { name: "甲", templateId: "general" }, { mode: "bind", existingGroupChatId: EXISTING_GROUP_ID })
    expect(first.ok).toBe(true)
    hits.length = 0
    const dup = await create.createProjectForAi(FS_CHAT, { name: "乙", templateId: "general" }, { mode: "bind", existingGroupChatId: EXISTING_GROUP_ID })
    expect(dup.ok).toBe(false)
    expect(!dup.ok && dup.error).toContain("已绑定项目「甲」")
    expect(store.listProjects()).toHaveLength(1)
    expect(hits).toEqual([])
    if (first.ok) expect(store.getProject(first.projectId)!.groupChatId).toBe(EXISTING_KEY)
  })

  it("带通道前缀（和首尾空白）的群号也认；绑定后在私聊里 /p use 进不去（群项目只能在群里进入），不会切会话", async () => {
    const { store, create, commands } = await boot()
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, { mode: "bind", existingGroupChatId: ` ${EXISTING_KEY} ` })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(store.getProject(r.projectId)!.groupChatId).toBe(EXISTING_KEY)

    hits.length = 0
    await commands.handleFeishuProjectCommand(port, "m1", `/p use ${r.projectId}`, FS_CHAT)
    expect(hit("/api/active-session")).toEqual([])
    expect(hit("/cmd/result")[0]?.body.message).toContain("独立群")
  })
})
