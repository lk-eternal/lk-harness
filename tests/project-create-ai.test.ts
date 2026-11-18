import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { APP_CHANNEL_CHAT_ID, makeChatKey } from "../src/shared/channel-types"
import { projectBoundToChannel, projectRootDir } from "../src/shared/project-types"

/**
 * AI 建项（管理 MCP 的 manage_project create 在宿主侧的落地）：真实的 config-store、project-store、project-create，
 * 只把落盘的 electron-store、electron 和假 daemon 顶掉。
 * 守住几件事：应用内 / 飞书 / 微信的主用户私聊都能建；建完不进入项目会话、不动「当前项目」指针；
 * 项目接入哪些通道（bindings）必须明确指定、没有默认值：每个通道 inline 接主聊天、group 建飞书独立群、bind 绑定已有群，
 * 可以同时接多个（每个入口一条独立会话）；应用内对话里的 AI 能接任何通道，飞书 / 微信里只能接自己所在的通道；
 * 建群 / 绑群失败项目保留并带回原因，一个都没接成就退回调用者的主聊天；
 * 非主用户和认不出的通道一律拒绝；同名并发只放一个；建好的项目用户之后能用 /p use 进入；
 * 建好之后还能用 bind / unbind 增减接入。
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

/** 接入某个通道的主聊天 */
const inlineOn = (channelId: string) => ({ channelId, mode: "inline" as const })
/** 项目在某个通道的主聊天入口上记着的样子 */
const mainBinding = (channelId: string, chatKey: string, projectId: string) =>
  ({ kind: "main", channelId, sessionKey: `${chatKey}::project_${projectId}` })

describe("AI 建项：各通道的主用户私聊", () => {
  it.each([
    ["应用内对话", APP_CHAT, APP],
    ["飞书", FS_CHAT, FEISHU],
    ["微信", WX_CHAT, WECHAT],
  ])("%s：项目接入自己所在通道的主聊天；不进入会话、不建群、不碰当前项目指针", async (_name, chatKey, channelId) => {
    const { store, create } = await boot()
    const other = store.createProject({
      name: "私聊正在用的", goal: "",
      worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
      bindings: [{ kind: "main", channelId }],
    })
    store.setCurrentProjectId(other.id, chatKey)

    const r = await create.createProjectForAi(chatKey, { name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT" } }, [inlineOn(channelId)])
    expect(r).toMatchObject({
      ok: true, name: "Q4 调研", templateName: expect.any(String),
      bindings: [{ channelId, channelName: channelId, mode: "inline", ok: true }],
    })
    if (!r.ok) return
    expect(r.warning).toBeUndefined()
    expect(r.projectId).toMatch(/\S+/)

    const p = store.getProject(r.projectId)!
    expect(p).toMatchObject({ name: "Q4 调研", goal: "看清竞品", groupId: "research" })
    expect(p.metadata).toEqual({ 交付形式: "PPT" })
    // 只接了这个通道的主聊天，会话键已经记下
    expect(p.bindings).toEqual([mainBinding(channelId, chatKey, p.id)])
    expect(path.resolve(p.worktreePath).startsWith(path.resolve(userData))).toBe(true)
    // 告诉 AI 的是项目目录（设置页项目列表里显示的那个），工作目录在它下面
    expect(r.dir).toBe(projectRootDir(p))
    expect(path.resolve(p.worktreePath).startsWith(path.resolve(r.dir))).toBe(true)
    expect(fs.existsSync(path.join(p.worktreePath, ".lk-harness", "artifacts"))).toBe(true)

    // 建完什么都没发给 daemon：没有切会话，也没有建群
    expect(hits).toEqual([])
    expect(store.getCurrentProjectId(chatKey)).toBe(other.id)
    expect(store.listProjects().map((x) => x.id)).toContain(r.projectId)
  })

  it("应用内对话：不管调用者的聊天键写成什么，都接到该通道固定的主聊天", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectForAi(makeChatKey(APP, "app_whatever"), { name: "n", templateId: "general" }, [inlineOn(APP)])
    expect(r.ok).toBe(true)
    if (r.ok) expect(store.getProject(r.projectId)!.bindings).toEqual([mainBinding(APP, APP_CHAT, r.projectId)])
  })

  it("建好的项目，用户在原聊天里发 /p use <ID> 就能进入；会话键不用纠正", async () => {
    const { store, create, commands } = await boot()
    for (const [chat, channelId] of [[FS_CHAT, FEISHU], [WX_CHAT, WECHAT], [APP_CHAT, APP]]) {
      hits.length = 0
      const r = await create.createProjectForAi(chat, { name: `p-${chat}`, templateId: "general" }, [inlineOn(channelId)])
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const before = store.getProject(r.projectId)!.bindings?.[0]?.sessionKey
      expect(before).toBe(`${chat}::project_${r.projectId}`)
      await commands.handleFeishuProjectCommand(port, "m1", `/p use ${r.projectId}`, chat)
      expect(hit("/api/active-session")).toEqual([{ url: "/api/active-session", body: { chatId: chat, sessionKey: before } }])
      expect(store.getProject(r.projectId)!.bindings?.[0]?.sessionKey).toBe(before)
    }
  })

  it("接代码仓库的模板：真克隆；仓库记进常用仓库，下次 repos 能列出来", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const r = await create.createProjectForAi(FS_CHAT, {
      name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/redesign",
    }, [inlineOn(FEISHU)])
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
      const r = await create.createProjectForAi(chat, { name: "x", templateId: "general" }, [inlineOn(FEISHU)])
      expect(r.ok, chat).toBe(false)
      expect(!r.ok && r.error, chat).toContain(hint)
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])

    const off = await boot({ [FEISHU]: { mainUserEnabled: false } })
    const r = await off.create.createProjectForAi(FS_CHAT, { name: "x", templateId: "general" }, [inlineOn(FEISHU)])
    expect(r.ok).toBe(false)
    expect(off.store.listProjects()).toHaveLength(0)
  })

  it("校验不过：必填没填、模板不存在、仓库路径不是完整路径、名字空——原因带回来，不留目录和项目", async () => {
    const { store, create } = await boot()
    store.saveNodeGroups(store.getNodeGroups().map((g) => g.id === "research"
      ? { ...g, fields: [{ label: "交付形式", required: true }, { label: "截止时间" }] }
      : g))
    const before = projectDirs(create)
    const on = [inlineOn(FEISHU)]
    const miss = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "research", fields: { 截止时间: "周五" } }, on)
    expect(miss).toEqual({ ok: false, error: "请填写：交付形式" })
    const noTpl = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "nope" }, on)
    expect(!noTpl.ok && noTpl.error).toContain("模板不存在")
    const rel = await create.createProjectForAi(FS_CHAT, { name: "a", templateId: "develop", repos: [{ repoPath: "relative/shop", baseBranch: "main" }] }, on)
    expect(!rel.ok && rel.error).toContain("完整路径")
    const noName = await create.createProjectForAi(FS_CHAT, { name: "  ", templateId: "general" }, on)
    expect(!noName.ok && noName.error).toContain("项目名称")
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
  })

  it("克隆失败（基线分支不存在）：整个项目目录收掉，不留半成品", async () => {
    const { store, create } = await boot()
    const repo = makeRepo(repoParent, "shop")
    const before = projectDirs(create)
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such" }] }, [inlineOn(FEISHU)])
    expect(r.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
  })

  it("建成功的会多出一个项目目录（上面「不留目录」的检查不是空转）", async () => {
    const { create } = await boot()
    const before = projectDirs(create)
    expect((await create.createProjectForAi(FS_CHAT, { name: "有目录", templateId: "general" }, [inlineOn(FEISHU)])).ok).toBe(true)
    expect(projectDirs(create)).toHaveLength(before.length + 1)
  })
})

describe("AI 建项：同名并发防重", () => {
  it("同一个聊天里同名的两个请求同时到：只建一个，另一个被告知正在创建；做完后可以再建", async () => {
    const { store, create } = await boot()
    const on = [inlineOn(FEISHU)]
    const [a, b] = await Promise.all([
      create.createProjectForAi(FS_CHAT, { name: "周报", templateId: "general" }, on),
      create.createProjectForAi(FS_CHAT, { name: " 周报 ", templateId: "general" }, on),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(!loser.ok && loser.error).toContain("正在创建中")
    expect(!loser.ok && loser.error).toContain("list")
    expect(store.listProjects()).toHaveLength(1)
    expect((await create.createProjectForAi(FS_CHAT, { name: "周报", templateId: "general" }, on)).ok).toBe(true)
    expect(store.listProjects()).toHaveLength(2)
  })

  it("名字不同、或聊天不同：互不影响；失败后占位也会释放", async () => {
    const { store, create } = await boot()
    const rs = await Promise.all([
      create.createProjectForAi(FS_CHAT, { name: "甲", templateId: "general" }, [inlineOn(FEISHU)]),
      create.createProjectForAi(FS_CHAT, { name: "乙", templateId: "general" }, [inlineOn(FEISHU)]),
      create.createProjectForAi(APP_CHAT, { name: "甲", templateId: "general" }, [inlineOn(APP)]),
      create.createProjectForAi(WX_CHAT, { name: "甲", templateId: "general" }, [inlineOn(WECHAT)]),
    ])
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(store.listProjects()).toHaveLength(4)

    const bad = await create.createProjectForAi(FS_CHAT, { name: "丙", templateId: "nope" }, [inlineOn(FEISHU)])
    expect(bad.ok).toBe(false)
    expect((await create.createProjectForAi(FS_CHAT, { name: "丙", templateId: "general" }, [inlineOn(FEISHU)])).ok).toBe(true)
  })
})

describe("宿主请求处理函数（project.templates / repos / channels / create / bind / unbind）", () => {
  it("templates / repos：就是应用里「新建项目」界面用的那两份数据", async () => {
    const { create } = await boot()
    const h = create.projectHostRpcHandlers
    // 创建 / 选项 / 接入三类在这里测；其余是项目管理类（行为见 project-admin-host.test.ts）
    expect(Object.keys(h).sort()).toEqual([
      "project.archive", "project.bind", "project.channels", "project.create", "project.get", "project.repo.remove", "project.repo.save",
      "project.repos", "project.settings.get", "project.settings.set", "project.sync-steps", "project.template.delete",
      "project.template.detail", "project.template.save", "project.templates", "project.unbind", "project.update",
    ])
    const templates = (await h["project.templates"]({})) as { id: string; needsRepo: boolean }[]
    expect(templates.map((t) => t.id)).toEqual(expect.arrayContaining(["general", "develop", "research"]))
    expect(templates.find((t) => t.id === "develop")?.needsRepo).toBe(true)
    expect(templates.find((t) => t.id === "general")?.needsRepo).toBe(false)
    expect(await h["project.repos"]({})).toEqual(create.listProjectRepoOptions())
  })

  it("channels：应用内对话里看到全部通道（标出当前所在）；飞书里只看到自己所在的通道，并带上受限的原因", async () => {
    const { create } = await boot()
    const run = (chatKey: string) => create.projectHostRpcHandlers["project.channels"]({ chatKey }) as { ok: boolean; current?: string; channels?: Record<string, unknown>[]; error?: string }

    const fromApp = run(APP_CHAT)
    expect(fromApp.ok).toBe(true)
    expect(fromApp.current).toBe(APP)
    expect(fromApp.channels?.map((c) => [c.id, c.current, c.modes])).toEqual([
      [APP, true, ["inline"]],
      [FEISHU, false, ["inline", "bind"]],
      [WECHAT, false, ["inline"]],
    ])

    const fromFeishu = run(FS_CHAT)
    expect(fromFeishu.current).toBe(FEISHU)
    expect(fromFeishu.channels).toHaveLength(1)
    expect(fromFeishu.channels?.[0]).toMatchObject({ id: FEISHU, type: "feishu", current: true, modes: ["inline", "bind"] })
    // 没记到主用户的 open_id：建不了独立群，原因写在 note 里让 AI 能告诉用户
    expect(String(fromFeishu.channels?.[0].note)).toContain("open_id")

    const withOpenId = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    const full = withOpenId.create.projectHostRpcHandlers["project.channels"]({ chatKey: FS_CHAT }) as { channels: { modes: string[] }[] }
    expect(full.channels[0].modes).toEqual(["inline", "group", "bind"])

    // 不是主用户 / 认不出通道：拒绝，不泄露通道清单
    expect(run(makeChatKey(FEISHU, "ou_other"))).toMatchObject({ ok: false, error: expect.stringContaining("只有主用户") })
    expect(run("")).toMatchObject({ ok: false, error: expect.stringContaining("找不到你所在的消息通道") })
    expect(hits).toEqual([])
  })

  it("create：入参只认字符串；folder 认（不接代码仓库的模板可以用已有文件夹，里面的文件不动）", async () => {
    const { store, create } = await boot()
    fs.writeFileSync(path.join(folder, "资料.md"), "我的资料")
    const r = (await create.projectHostRpcHandlers["project.create"]({
      chatKey: FS_CHAT,
      bindings: [{ channelId: FEISHU, mode: "inline" }],
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
    const bindings = [{ channelId: FEISHU, mode: "inline" }]
    expect((await run({ input: { name: "x", templateId: "general" }, bindings })).error).toContain("找不到你所在的消息通道")
    expect((await run({ chatKey: FS_CHAT, bindings })).ok).toBe(false)
    expect((await run({ chatKey: FS_CHAT, bindings, input: { name: 5, templateId: "general" } })).error).toContain("项目名称")
    expect((await run(undefined)).ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })

  it("create：bindings 从入参里取，只认字符串；没给 / 写错就报错，让 AI 去问用户", async () => {
    const { store, create } = await boot()
    const run = (payload: unknown) => create.projectHostRpcHandlers["project.create"](payload) as Promise<{ ok: boolean; error?: string; bindings?: Record<string, unknown>[] }>
    const input = { name: "x", templateId: "general" }
    expect((await run({ chatKey: FS_CHAT, input })).error).toContain("bindings")
    expect((await run({ chatKey: FS_CHAT, input, bindings: "inline" })).error).toContain("bindings")
    expect((await run({ chatKey: FS_CHAT, input, bindings: [{ channelId: 5, mode: "inline" }] })).error).toContain("channel_id")
    expect((await run({ chatKey: FS_CHAT, input, bindings: [{ channelId: FEISHU, mode: 5 }] })).error).toContain("inline / group / bind")
    expect((await run({ chatKey: FS_CHAT, input, bindings: [{ channelId: FEISHU, mode: "bind", groupChatId: 9 }] })).error).toContain("chat_id")
    expect(store.listProjects()).toHaveLength(0)
    const bound = await run({ chatKey: FS_CHAT, input, bindings: [{ channelId: FEISHU, mode: "bind", groupChatId: EXISTING_GROUP_ID }] })
    expect(bound).toMatchObject({ ok: true, bindings: [{ channelId: FEISHU, mode: "bind", ok: true, groupChatId: EXISTING_GROUP_ID }] })
    expect(store.listProjects()).toHaveLength(1)
  })
})

describe("AI 建项：bindings 必须明确指定，没有默认值", () => {
  const whereIs: [string, string][] = [[APP_CHAT, APP], [FS_CHAT, FEISHU], [WX_CHAT, WECHAT]]

  it.each([
    ["没给", () => [], "问用户"],
    ["mode 空白", (ch: string) => [{ channelId: ch, mode: "  " }], "inline / group / bind"],
    ["mode 不认识", (ch: string) => [{ channelId: ch, mode: "dedicated" }], "inline / group / bind"],
    ["没写 channel_id", () => [{ channelId: "", mode: "inline" }], "channel_id"],
  ])("%s：报错并让 AI 去问用户；不建项目、不建目录、不碰 daemon（各通道一样）", async (_name, makeChoices, hint) => {
    const { store, create } = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    const before = projectDirs(create)
    for (const [where, channelId] of whereIs) {
      const r = await create.createProjectForAi(where, { name: "x", templateId: "general" }, makeChoices(channelId) as never)
      expect(r.ok, where).toBe(false)
      expect(!r.ok && r.error, where).toContain(hint)
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(projectDirs(create)).toEqual(before)
    expect(hits).toEqual([])
  })

  it("bind 没给群号 / 群号格式不对：报错，不建项目", async () => {
    const { store, create } = await boot()
    for (const id of [undefined, "", "  ", "not-a-group"]) {
      const r = await create.createProjectForAi(FS_CHAT, { name: "x", templateId: "general" }, [{ channelId: FEISHU, mode: "bind", groupChatId: id }])
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain("chat_id")
    }
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })

  it("不是主用户 / 认不出通道时，先报这个，而不是 bindings（先认人，再谈怎么建）", async () => {
    const { create } = await boot()
    const r = await create.createProjectForAi(makeChatKey(FEISHU, "ou_other"), { name: "x", templateId: "general" }, [])
    expect(!r.ok && r.error).toContain("只有主用户")
    const r2 = await create.createProjectForAi("", { name: "x", templateId: "general" }, [])
    expect(!r2.ok && r2.error).toContain("找不到你所在的消息通道")
  })

  it("飞书 / 微信里的 AI 只能接自己所在的通道：别的通道、不存在的通道都拒绝（集中部署时通道之间不互通）", async () => {
    const { store, create } = await boot()
    const task = { name: "x", templateId: "general" }
    for (const [chat, other] of [[FS_CHAT, APP], [FS_CHAT, WECHAT], [WX_CHAT, FEISHU], [WX_CHAT, APP]]) {
      const r = await create.createProjectForAi(chat, task, [inlineOn(other)])
      expect(r.ok, `${chat} → ${other}`).toBe(false)
      expect(!r.ok && r.error).toContain("只能接入自己所在的通道")
    }
    // 自己的通道 + 别的通道一起选：整体拒绝，不会一半建一半不建
    const mixed = await create.createProjectForAi(FS_CHAT, task, [inlineOn(FEISHU), inlineOn(APP)])
    expect(mixed.ok).toBe(false)
    const unknown = await create.createProjectForAi(FS_CHAT, task, [inlineOn("ch_nope")])
    expect(!unknown.ok && unknown.error).toContain("找不到通道")
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })

  it("通道不支持的方式：应用内 / 微信不能 group / bind；没记 open_id 不能 group；没绑主用户不能 inline；同一项选重了拒绝", async () => {
    const { store, create } = await boot()
    const task = { name: "x", templateId: "general" }
    const deny = async (chat: string, choices: unknown, hint: string) => {
      const r = await create.createProjectForAi(chat, task, choices as never)
      expect(r.ok, hint).toBe(false)
      expect(!r.ok && r.error, hint).toContain(hint)
    }
    await deny(APP_CHAT, [{ channelId: APP, mode: "group" }], "不能用 group")
    await deny(APP_CHAT, [{ channelId: WECHAT, mode: "bind", groupChatId: EXISTING_GROUP_ID }], "不能用 bind")
    await deny(WX_CHAT, [{ channelId: WECHAT, mode: "group" }], "微信不能建群")
    await deny(FS_CHAT, [{ channelId: FEISHU, mode: "group" }], "open_id")
    await deny(APP_CHAT, [inlineOn(APP), inlineOn(APP)], "选重了")

    const noMain = await boot({ [FEISHU]: { mainUserChatId: "" } })
    const r = await noMain.create.createProjectForAi(APP_CHAT, task, [inlineOn(FEISHU)])
    expect(!r.ok && r.error).toContain("还没绑定主用户")
    expect(store.listProjects()).toHaveLength(0)
    expect(noMain.store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })
})

describe("AI 建项：新建飞书独立群（mode=group）", () => {
  const GROUP_KEY = makeChatKey(FEISHU, NEW_GROUP_ID)
  const daemonCreatesGroup = () => {
    reply = (url) => (url === "/create-project-group" ? { ok: true, chatKey: GROUP_KEY } : { ok: true })
  }
  const bootFeishu = () => boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
  const group = { channelId: FEISHU, mode: "group" as const }

  it("群主是主用户，项目接到新群，项目卡发进群；不离开当前会话、不动当前项目指针", async () => {
    const { store, create } = await bootFeishu()
    daemonCreatesGroup()
    const other = store.createProject({
      name: "正在用的", goal: "", worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
      bindings: [{ kind: "main", channelId: FEISHU }],
    })
    store.setCurrentProjectId(other.id, FS_CHAT)

    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", goal: "把首页改掉", templateId: "general" }, [group])
    expect(r).toMatchObject({
      ok: true, name: "改版",
      bindings: [{ channelId: FEISHU, mode: "group", ok: true, groupName: "📦 改版", groupChatId: NEW_GROUP_ID }],
    })
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
    expect(p.bindings).toEqual([{ kind: "group", channelId: FEISHU, chatKey: GROUP_KEY, sessionKey: `${GROUP_KEY}::project_${p.id}` }])
    expect(store.findProjectByGroupChat(GROUP_KEY)?.id).toBe(r.projectId)
    expect(store.getCurrentProjectId(FS_CHAT)).toBe(other.id)
  })

  it("主聊天和独立群一起选：两个入口各一条会话，互不合并", async () => {
    const { store, create } = await bootFeishu()
    daemonCreatesGroup()
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, [inlineOn(FEISHU), group])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bindings.map((o) => [o.mode, o.ok])).toEqual([["inline", true], ["group", true]])
    const p = store.getProject(r.projectId)!
    expect(p.bindings).toEqual([
      mainBinding(FEISHU, FS_CHAT, p.id),
      { kind: "group", channelId: FEISHU, chatKey: GROUP_KEY, sessionKey: `${GROUP_KEY}::project_${p.id}` },
    ])
    expect(p.bindings?.[0].sessionKey).not.toBe(p.bindings?.[1].sessionKey)
  })

  it("没有记录主用户的 open_id：建项前就报错，不建项目、不建群，提示可以改用别的方式", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, [group])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("open_id")
    expect(store.listProjects()).toHaveLength(0)
    expect(hits).toEqual([])
  })

  it("建群接口失败、同时选了主聊天：项目保留，主聊天照常接上，warning 写明原因；不发项目卡", async () => {
    const { store, create } = await bootFeishu()
    reply = (url) => (url === "/create-project-group" ? { ok: false, error: "建群失败: 无权限" } : { ok: true })
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, [inlineOn(FEISHU), group])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bindings.map((o) => [o.mode, o.ok])).toEqual([["inline", true], ["group", false]])
    expect(r.warning).toContain("建独立群没成功")
    expect(r.warning).toContain("无权限")
    expect(r.warning).toContain("其余接入照常")
    expect(store.getProject(r.projectId)!.bindings).toEqual([mainBinding(FEISHU, FS_CHAT, r.projectId)])
    expect(hit("/cmd/result")).toEqual([])
  })

  it("建群接口失败、只选了独立群：项目退回调用者所在通道的主聊天，不会没有入口；warning 写明原因", async () => {
    const { store, create } = await bootFeishu()
    reply = (url) => (url === "/create-project-group" ? { ok: false, error: "建群失败: 无权限" } : { ok: true })
    const other = store.createProject({
      name: "正在用的", goal: "", worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
      bindings: [{ kind: "main", channelId: FEISHU }],
    })
    store.setCurrentProjectId(other.id, FS_CHAT)

    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, [group])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warning).toContain("建独立群没成功")
    expect(r.warning).toContain("无权限")
    expect(r.warning).toContain("退回绑在你当前所在的")
    expect(r.bindings.map((o) => [o.mode, o.ok])).toEqual([["group", false], ["inline", true]])
    expect(store.getProject(r.projectId)!.bindings).toEqual([mainBinding(FEISHU, FS_CHAT, r.projectId)])
    expect(hit("/cmd/result")).toEqual([])
    expect(store.getCurrentProjectId(FS_CHAT)).toBe(other.id)
  })

  it("后台服务没在运行（没有端口）：同样保留项目、退回主聊天、带 warning，不抛异常", async () => {
    const { store, create } = await bootFeishu()
    fs.rmSync(path.join(userData, LOCK_FILE_NAME))
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, [group])
    expect(r.ok).toBe(true)
    expect(r.ok && r.warning).toContain("没有在运行")
    expect(store.listProjects()).toHaveLength(1)
    expect(hits).toEqual([])
  })

  it("项目没建成（校验没过、克隆失败）：不建群", async () => {
    const { store, create } = await bootFeishu()
    daemonCreatesGroup()
    const bad = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "nope" }, [group])
    expect(bad.ok).toBe(false)
    const repo = makeRepo(repoParent, "shop")
    const clone = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "no-such" }] }, [group])
    expect(clone.ok).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
    expect(hit("/create-project-group")).toEqual([])
    expect(hit("/cmd/result")).toEqual([])
  })
})

describe("AI 建项：绑定已有飞书群（mode=bind）", () => {
  const EXISTING_KEY = makeChatKey(FEISHU, EXISTING_GROUP_ID)
  const bindTo = (groupChatId: string) => [{ channelId: FEISHU, mode: "bind" as const, groupChatId }]

  it("项目接到该群，项目卡发进群；不建群、不离开当前会话、不动当前项目指针", async () => {
    const { store, create } = await boot()
    const other = store.createProject({
      name: "正在用的", goal: "", worktreePath: path.join(userData, "other", "workspace"), groupIds: ["develop"], groupId: "develop",
      bindings: [{ kind: "main", channelId: FEISHU }],
    })
    store.setCurrentProjectId(other.id, FS_CHAT)

    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, bindTo(EXISTING_GROUP_ID))
    expect(r).toMatchObject({ ok: true, bindings: [{ channelId: FEISHU, mode: "bind", ok: true, groupChatId: EXISTING_GROUP_ID }] })
    if (!r.ok) return
    expect(r.bindings[0].groupName).toBeUndefined()
    expect(r.warning).toBeUndefined()

    expect(hit("/create-project-group")).toEqual([])
    const cards = hit("/cmd/result")
    expect(cards).toHaveLength(1)
    expect(cards[0].body).toMatchObject({ ok: true, chatId: EXISTING_KEY, sessionKey: `${EXISTING_KEY}::project_${r.projectId}` })
    expect(hit("/api/active-session")).toEqual([])

    const p = store.getProject(r.projectId)!
    expect(p.bindings).toEqual([{ kind: "group", channelId: FEISHU, chatKey: EXISTING_KEY, sessionKey: `${EXISTING_KEY}::project_${p.id}` }])
    expect(store.getCurrentProjectId(FS_CHAT)).toBe(other.id)
  })

  it("群已绑给别的项目：这个群没接上，项目照建、退回主聊天并带原因；原来那个项目不受影响", async () => {
    const { store, create } = await boot()
    const first = await create.createProjectForAi(FS_CHAT, { name: "甲", templateId: "general" }, bindTo(EXISTING_GROUP_ID))
    expect(first.ok).toBe(true)
    hits.length = 0
    const dup = await create.createProjectForAi(FS_CHAT, { name: "乙", templateId: "general" }, bindTo(EXISTING_GROUP_ID))
    expect(dup.ok).toBe(true)
    if (!dup.ok) return
    expect(dup.warning).toContain("已绑定项目「甲」")
    expect(dup.bindings.map((o) => [o.mode, o.ok])).toEqual([["bind", false], ["inline", true]])
    expect(store.getProject(dup.projectId)!.bindings).toEqual([mainBinding(FEISHU, FS_CHAT, dup.projectId)])
    expect(store.findProjectByGroupChat(EXISTING_KEY)?.name).toBe("甲")
    expect(hit("/cmd/result")).toEqual([])
    if (first.ok) expect(store.getProject(first.projectId)!.bindings?.[0].chatKey).toBe(EXISTING_KEY)
  })

  it("带通道前缀（和首尾空白）的群号也认；只接了群的项目在私聊里 /p use 进不去（群项目只能在群里进入），不会切会话", async () => {
    const { store, create, commands } = await boot()
    const r = await create.createProjectForAi(FS_CHAT, { name: "改版", templateId: "general" }, bindTo(` ${EXISTING_KEY} `))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(store.getProject(r.projectId)!.bindings?.[0].chatKey).toBe(EXISTING_KEY)

    hits.length = 0
    await commands.handleFeishuProjectCommand(port, "m1", `/p use ${r.projectId}`, FS_CHAT)
    expect(hit("/api/active-session")).toEqual([])
    expect(hit("/cmd/result")[0]?.body.message).toContain("没有接入当前聊天")
  })
})

describe("AI 建项：同时接入多个通道（应用内对话里的 AI 能接任何通道）", () => {
  it("应用内、飞书、微信各接一个主聊天：每个通道一条独立会话，各通道看得到", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectForAi(APP_CHAT, { name: "三处都用", templateId: "general" }, [inlineOn(APP), inlineOn(FEISHU), inlineOn(WECHAT)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bindings.map((o) => [o.channelId, o.ok])).toEqual([[APP, true], [FEISHU, true], [WECHAT, true]])
    const p = store.getProject(r.projectId)!
    expect(p.bindings).toEqual([
      mainBinding(APP, APP_CHAT, p.id),
      mainBinding(FEISHU, FS_CHAT, p.id),
      mainBinding(WECHAT, WX_CHAT, p.id),
    ])
    expect(new Set(p.bindings?.map((b) => b.sessionKey)).size).toBe(3)
    for (const ch of [APP, FEISHU, WECHAT]) expect(projectBoundToChannel(p, ch)).toBe(true)
    expect(hits).toEqual([])
  })

  it("只接飞书、不接应用内：项目只在飞书那边看得到，应用内通道看不到它", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectForAi(APP_CHAT, { name: "给飞书用", templateId: "general" }, [inlineOn(FEISHU)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = store.getProject(r.projectId)!
    expect(p.bindings?.map((b) => b.channelId)).toEqual([FEISHU])
    expect(projectBoundToChannel(p, FEISHU)).toBe(true)
    expect(projectBoundToChannel(p, APP)).toBe(false)
  })

  it("应用内对话里选新建飞书独立群：群主用的是飞书通道记着的主用户（调用者在应用里，没有 open_id）", async () => {
    const { store, create } = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    reply = (url) => (url === "/create-project-group" ? { ok: true, chatKey: makeChatKey(FEISHU, NEW_GROUP_ID) } : { ok: true })
    const r = await create.createProjectForAi(APP_CHAT, { name: "改版", templateId: "general" }, [inlineOn(APP), { channelId: FEISHU, mode: "group" }])
    expect(r.ok).toBe(true)
    expect(hit("/create-project-group")[0]?.body).toMatchObject({ channelId: FEISHU, ownerOpenId: MAIN_OPEN_ID })
    if (r.ok) expect(store.getProject(r.projectId)!.bindings?.map((b) => [b.kind, b.channelId])).toEqual([["main", APP], ["group", FEISHU]])
  })
})

describe("AI 补接入 / 取消接入（project.bind / project.unbind）", () => {
  const task = { name: "改版", templateId: "general" }
  const run = (create: { projectHostRpcHandlers: Record<string, (p: unknown) => unknown> }, name: string, payload: unknown) =>
    create.projectHostRpcHandlers[name](payload) as Promise<{ ok: boolean; error?: string; removed?: string; note?: string; warning?: string; bindings?: Record<string, unknown>[] }>

  it("bind：给已有项目补接别的通道；飞书里的 AI 只能补自己所在的通道", async () => {
    const { store, create } = await boot()
    // 项目接了应用内和飞书两个通道的主聊天，两边的 AI 都管得到它
    const made = await create.createProjectForAi(APP_CHAT, task, [inlineOn(APP), inlineOn(FEISHU)])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const id = made.projectId

    const denied = await run(create, "project.bind", { chatKey: FS_CHAT, projectId: id, bindings: [inlineOn(WECHAT)] })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain("只能接入自己所在的通道")
    expect(store.getProject(id)!.bindings).toHaveLength(2)

    const grp = await run(create, "project.bind", { chatKey: FS_CHAT, projectId: id, bindings: [{ channelId: FEISHU, mode: "bind", groupChatId: EXISTING_GROUP_ID }] })
    expect(grp).toMatchObject({ ok: true, bindings: [{ channelId: FEISHU, mode: "bind", ok: true }] })
    expect(store.getProject(id)!.bindings?.map((b) => b.kind)).toEqual(["main", "main", "group"])

    // 应用内对话里的 AI 可以补接任何通道
    const fromApp = await run(create, "project.bind", { chatKey: APP_CHAT, projectId: id, bindings: [inlineOn(WECHAT)] })
    expect(fromApp.ok).toBe(true)
    expect(store.getProject(id)!.bindings?.map((b) => b.channelId)).toEqual([APP, FEISHU, FEISHU, WECHAT])
  })

  it("bind：已经接着的主聊天不重复接；一个通道已经有专属群就不再新建第二个", async () => {
    const { store, create } = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    reply = (url) => (url === "/create-project-group" ? { ok: true, chatKey: makeChatKey(FEISHU, NEW_GROUP_ID) } : { ok: true })
    const made = await create.createProjectForAi(FS_CHAT, task, [inlineOn(FEISHU), { channelId: FEISHU, mode: "group" }])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    hits.length = 0

    const again = await run(create, "project.bind", { chatKey: FS_CHAT, projectId: made.projectId, bindings: [inlineOn(FEISHU)] })
    expect(again.ok).toBe(true)
    expect(store.getProject(made.projectId)!.bindings).toHaveLength(2)

    const second = await run(create, "project.bind", { chatKey: FS_CHAT, projectId: made.projectId, bindings: [{ channelId: FEISHU, mode: "group" }] })
    expect(second.ok).toBe(false)
    expect(second.error).toContain("已经接入了专属群")
    expect(hit("/create-project-group")).toEqual([])
    expect(store.getProject(made.projectId)!.bindings).toHaveLength(2)
  })

  it("项目没接入调用者所在的通道：看不到它，bind / unbind 都按「未找到」处理", async () => {
    const { store, create } = await boot()
    const made = await create.createProjectForAi(APP_CHAT, task, [inlineOn(APP)])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const bind = await run(create, "project.bind", { chatKey: FS_CHAT, projectId: made.projectId, bindings: [inlineOn(FEISHU)] })
    expect(bind).toMatchObject({ ok: false, error: expect.stringContaining("未找到项目") })
    const unbind = await run(create, "project.unbind", { chatKey: FS_CHAT, projectId: made.projectId, binding: inlineOn(APP) })
    expect(unbind).toMatchObject({ ok: false, error: expect.stringContaining("未找到项目") })
    const missing = await run(create, "project.bind", { chatKey: APP_CHAT, projectId: "nope", bindings: [inlineOn(APP)] })
    expect(missing.ok).toBe(false)
    expect(store.getProject(made.projectId)!.bindings).toHaveLength(1)
  })

  it("unbind：取消一个入口，那条会话一并清理；停在它上面的主聊天回到主会话；专属群只是不再接入", async () => {
    const { store, create } = await boot({ [FEISHU]: { mainUserOpenId: MAIN_OPEN_ID } })
    reply = (url) => (url === "/create-project-group" ? { ok: true, chatKey: makeChatKey(FEISHU, NEW_GROUP_ID) } : { ok: true })
    const made = await create.createProjectForAi(APP_CHAT, task, [inlineOn(APP), inlineOn(FEISHU), { channelId: FEISHU, mode: "group" }])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const id = made.projectId
    store.setCurrentProjectId(id, FS_CHAT)
    hits.length = 0

    // 取消飞书主聊天：指针清掉，那条会话的路由被清
    const mainOff = await run(create, "project.unbind", { chatKey: APP_CHAT, projectId: id, binding: inlineOn(FEISHU) })
    expect(mainOff).toMatchObject({ ok: true, removed: `${FEISHU} 的主聊天` })
    expect(store.getCurrentProjectId(FS_CHAT)).toBeNull()
    expect(hit("/api/purge-session-routing").map((h) => h.body.sessionKey)).toEqual([`${FS_CHAT}::project_${id}`])
    expect(store.getProject(id)!.bindings?.map((b) => b.kind)).toEqual(["main", "group"])

    // 取消专属群：不改名不解散，只是不再接入
    hits.length = 0
    const groupOff = await run(create, "project.unbind", { chatKey: APP_CHAT, projectId: id, binding: { channelId: FEISHU, mode: "group" } })
    expect(groupOff).toMatchObject({ ok: true, removed: `${FEISHU} 的专属群` })
    expect(groupOff.note).toContain("没有改名")
    expect(hit("/api/purge-session-routing").map((h) => h.body.sessionKey)).toEqual([`${makeChatKey(FEISHU, NEW_GROUP_ID)}::project_${id}`])
    expect(store.findProjectByGroupChat(makeChatKey(FEISHU, NEW_GROUP_ID))).toBeUndefined()
    expect(store.getProject(id)!.bindings).toEqual([mainBinding(APP, APP_CHAT, id)])
  })

  it("unbind：项目唯一的入口不能取消；没有的入口、没给通道 / 方式：报错", async () => {
    const { store, create } = await boot()
    const made = await create.createProjectForAi(APP_CHAT, task, [inlineOn(APP)])
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const id = made.projectId
    const last = await run(create, "project.unbind", { chatKey: APP_CHAT, projectId: id, binding: inlineOn(APP) })
    expect(last.ok).toBe(false)
    expect(last.error).toContain("唯一的接入")
    const none = await run(create, "project.unbind", { chatKey: APP_CHAT, projectId: id, binding: { channelId: APP, mode: "group" } })
    expect(none.ok).toBe(false)
    expect((await run(create, "project.unbind", { chatKey: APP_CHAT, projectId: id })).error).toContain("channel_id")
    expect((await run(create, "project.unbind", { chatKey: APP_CHAT, projectId: id, binding: { channelId: APP, mode: "x" } })).error).toContain("inline")
    expect(store.getProject(id)!.bindings).toHaveLength(1)
  })
})
