import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { HostRpc } from "../src/shared/host-rpc"

/**
 * 「AI 用自然语言管理项目」从管理 MCP 的 manage_project 到宿主落盘的整条路：
 * 真实的 registerAdminTools（参数校验、snake_case → 驼峰）+ 真实的宿主处理函数 + 真实的 config-store / project-store，
 * 只把落盘的 electron-store、electron 顶掉（safeStorage 换成可逆的假加密，用来确认密钥真的是加密落盘的）。
 * 守住几件事：设置、常用仓库、模板、项目资料都能用对话改；规则和设置页同一套；密钥不回显、不进日志、加密落盘；
 * 改配置不会误伤已有项目；AI 配好的仓库 / 模板 / 目录，下一步建项目真的用得上。
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
    delete(key: string) { delete disk[key] }
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
  // 可逆的假加密：密文里看不到明文，用来确认密钥是经 saveConfig 加密落盘的
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...s].reverse().join("") + "#enc"),
    decryptString: (b: Buffer) => [...b.toString().replace(/#enc$/, "")].reverse().join(""),
  },
}))

const FEISHU = "ch_fs"
const FS_SK = `${FEISHU}|ou_main::${path.resolve("/work")}`
/** 项目接入调用者所在飞书通道的主聊天（建项必须明确指定接入哪里，没有默认值） */
const BIND = [{ channel_id: FEISHU, mode: "inline" }]
const TOKEN = "glpat-TOPSECRET9876543210"
const HUB_TOKEN = "hubtoken-TOPSECRET-abcdef"

let repoParent = ""
let rootParent = ""

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "proj-admin-"))
  repoParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-admin-repos-"))
  rootParent = fs.mkdtempSync(path.join(os.tmpdir(), "proj-admin-root-"))
  // 不写 daemon 锁文件：归档会通知 daemon 挪会话（best-effort），没有 daemon 也不该影响结果
})

afterEach(() => {
  for (const d of [userData, repoParent, rootParent]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as fs.RmOptions)
})

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
  return (r.stdout || "").trim()
}

function makeRepo(name: string): string {
  const repo = path.join(repoParent, name)
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ["init"])
  git(repo, ["config", "user.email", "t@t.com"])
  git(repo, ["config", "user.name", "t"])
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", "init"])
  git(repo, ["branch", "-M", "main"])
  git(repo, ["branch", "release"])
  return repo
}

async function boot() {
  vi.resetModules()
  const config = await import("../electron/config-store")
  config.saveConfig({
    channels: [{
      id: FEISHU, name: FEISHU, enabled: true, type: "feishu", agentResourceId: "sdk_t", model: "auto", modelParams: "",
      othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: "",
      mainUserEnabled: true, mainUserChatId: "ou_main",
    }] as never,
    agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
    favWorkspacesMigrated: true,
  })
  const store = await import("../src/shared/project-store")
  store.initProjectStore(userData)
  const create = await import("../electron/project-create")
  const logger = await import("../electron/ui-logger")
  const { registerAdminTools } = await import("../src/server-admin")
  const { runWithMcpInvokerSessionKey } = await import("../src/shared/mcp-invoker-context")

  // 管理 MCP 发出的宿主请求，直接交给真实的宿主处理函数（省掉标准输出那一段，它有自己的测试）
  const requests: { kind: string; payload: unknown }[] = []
  const hostRpc: HostRpc = {
    request: async (kind, payload) => {
      requests.push({ kind, payload })
      const handler = create.projectHostRpcHandlers[kind]
      if (!handler) return { ok: false, error: `不认识 ${kind}` } as never
      try {
        return { ok: true, result: await handler(payload) } as never
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) } as never
      }
    },
    settle: () => false,
    pendingCount: () => 0,
  }
  const s = new McpServer({ name: "t", version: "0" })
  registerAdminTools(s, { hostRpc })
  const tool = (s as any)._registeredTools.manage_project as {
    inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: any; error?: unknown } }
    handler: (args: any, extra: unknown) => Promise<{ content: { text: string }[] }>
  }
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const parsed = tool.inputSchema.safeParse(args)
    if (!parsed.success) throw new Error(`参数没过校验：${JSON.stringify(parsed.error)}`)
    const res = await runWithMcpInvokerSessionKey(FS_SK, () => tool.handler(parsed.data, {}))
    return res.content[0].text
  }
  return { config, store, create, logger, call, requests }
}

const whole = (o: unknown) => JSON.stringify(o)

describe("设置：看现状、改项目存放位置", () => {
  it("settings：默认位置、仓库 / 模板 / 项目数、Git 原则默认、GitLab 未配置", async () => {
    const { call, create } = await boot()
    const t = await call({ action: "settings" })
    expect(t).toContain(`${create.projectsRootDir()}（默认位置，没改过）`)
    expect(t).toContain("常用代码仓库：0 个")
    expect(t).toContain("项目模板：7 个")
    expect(t).toContain("Git 基本原则：默认")
    expect(t).toContain("GitLab Token：（未设置）")
  })

  it("worktree_root：目录被建出来、配置写入，之后建的项目就落在那里；已有项目不搬家", async () => {
    const { call, config, store, create } = await boot()
    const before = await call({
      action: "create", name: "旧项目", template_id: "general", bindings: BIND,
    })
    expect(before).toContain("✅ 已创建项目")
    const oldDir = store.listProjects()[0].worktreePath

    const root = path.join(rootParent, "my", "claw-projects")
    const out = await call({ action: "settings_set", settings: { worktree_root: root } })
    expect(out).toContain("✅ 已更新设置")
    expect(out).toContain("只影响之后新建的项目")
    expect(fs.existsSync(root)).toBe(true)
    expect(config.getConfig().worktreeRoot).toBe(path.normalize(root))
    expect(create.projectsRootDir()).toBe(path.normalize(root))

    const after = await call({ action: "create", name: "新项目", template_id: "general", bindings: BIND })
    expect(after).toContain(path.normalize(root))
    const created = store.listProjects().find((p) => p.name === "新项目")!
    expect(path.resolve(created.worktreePath).startsWith(path.resolve(root))).toBe(true)
    expect(store.listProjects().find((p) => p.name === "旧项目")!.worktreePath).toBe(oldDir)
  })

  it("路径不合法：整次不生效、配置不变、不建目录；空串改回默认", async () => {
    const { call, config, create } = await boot()
    const def = create.projectsRootDir()
    expect(await call({ action: "settings_set", settings: { worktree_root: "relative/dir" } })).toContain("❌")
    expect(await call({ action: "settings_set", settings: { worktree_root: path.parse(rootParent).root } })).toContain("整个盘")
    expect(config.getConfig().worktreeRoot).toBe("")
    const root = path.join(rootParent, "ws")
    await call({ action: "settings_set", settings: { worktree_root: root } })
    expect(create.projectsRootDir()).toBe(path.normalize(root))
    expect(await call({ action: "settings_set", settings: { worktree_root: "" } })).toContain("改回默认位置")
    expect(create.projectsRootDir()).toBe(def)
  })

  it("什么都没给 / settings 参数缺失：报错并指路", async () => {
    const { call, requests } = await boot()
    expect(await call({ action: "settings_set", settings: {} })).toContain("没有要改的设置")
    expect(await call({ action: "settings_set" })).toContain("需要 settings")
    expect(requests.filter((r) => r.kind === "project.settings.set")).toHaveLength(1)
  })
})

describe("设置：GitLab Token 等密钥", () => {
  it("写进配置、加密落盘；回给 AI 的文字、日志、help 里都只有打码的样子", async () => {
    const { call, config, logger } = await boot()
    const out = await call({ action: "settings_set", settings: { gitlab_token: TOKEN, gitlab_host: "gitlab.example.com" } })
    expect(config.getConfig().gitlabToken).toBe(TOKEN)
    expect(config.getConfig().gitlabHost).toBe("https://gitlab.example.com")
    expect(whole(disk)).not.toContain("TOPSECRET")
    expect(String(disk.gitlabToken)).toMatch(/^enc:v1:/)

    expect(out).toContain("GitLab Token：已更新")
    expect(out).toContain("glpat-***210")
    expect(out).not.toContain("TOPSECRET")

    const view = await call({ action: "settings" })
    const help = await call({ action: "help" })
    for (const text of [view, help, logger.getLogBuffer().join("\n")]) expect(text).not.toContain("TOPSECRET")
    expect(view).toContain("glpat-***210")
    expect(help).toContain("GitLab Token glpat-***210")
    // 日志只记改了哪几项，不记值
    expect(logger.getLogBuffer().join("\n")).toContain("修改了项目设置：gitlabHost、gitlabToken")
  })

  it("空串清除；地址带路径被拒，同一次里合法的 Token 也不会写进去（不会改一半）", async () => {
    const { call, config } = await boot()
    await call({ action: "settings_set", settings: { gitlab_token: TOKEN } })
    const bad = await call({ action: "settings_set", settings: { gitlab_token: "glpat-another", gitlab_host: "https://gitlab.example.com/group/repo" } })
    expect(bad).toContain("域名部分")
    expect(config.getConfig().gitlabToken).toBe(TOKEN)
    expect(await call({ action: "settings_set", settings: { gitlab_token: "" } })).toContain("已清除")
    expect(config.getConfig().gitlabToken).toBe("")
    expect(await call({ action: "settings" })).toContain("GitLab Token：（未设置）")
  })

  it("共享空间：地址、Token、署名一起配；Token 同样加密、不回显；地址不对被拒", async () => {
    const { call, config } = await boot()
    const out = await call({
      action: "settings_set",
      settings: { flow_hub_url: "https://gitlab.example.com/team/flow-hub", flow_hub_token: HUB_TOKEN, flow_hub_author: "小王" },
    })
    expect(out).toContain("共享空间地址：https://gitlab.example.com/team/flow-hub")
    expect(out).not.toContain("TOPSECRET")
    expect(config.getConfig()).toMatchObject({ flowHubUrl: "https://gitlab.example.com/team/flow-hub", flowHubToken: HUB_TOKEN, flowHubAuthor: "小王" })
    expect(String(disk.flowHubToken)).toMatch(/^enc:v1:/)
    expect(await call({ action: "settings_set", settings: { flow_hub_url: "不是地址" } })).toContain("共享空间地址无效")
  })
})

describe("设置：Git 基本原则", () => {
  it("自定义 → 关闭 → 恢复默认；每一步现状和存储都对得上", async () => {
    const { call, config } = await boot()
    const custom = "1. 只用 main\n2. 不要 force push"
    await call({ action: "settings_set", settings: { git_principles: custom } })
    expect(config.getConfig().gitPrinciples).toBe(custom)
    expect(await call({ action: "settings" })).toContain("Git 基本原则：已自定义")

    await call({ action: "settings_set", settings: { git_principles: "" } })
    expect(config.getConfig().gitPrinciples).toBe("")
    expect(await call({ action: "settings" })).toContain("已关闭")

    await call({ action: "settings_set", settings: { reset_git_principles: true } })
    expect("gitPrinciples" in disk).toBe(false)
    expect(await call({ action: "settings" })).toContain("Git 基本原则：默认")
  })
})

describe("常用代码仓库：登记、修改、移除", () => {
  it("登记本地仓库：自动识别默认分支，repos 立刻能看到，也提醒用户确认分支", async () => {
    const { call, create } = await boot()
    const repo = makeRepo("shop")
    const out = await call({ action: "repo_save", repo: { repo_path: repo } })
    expect(out).toContain("✅ 已登记常用代码仓库")
    expect(out).toContain("基线分支 main")
    expect(out).toContain("自动识别的默认分支")
    const list = await call({ action: "repos" })
    expect(list).toContain(path.resolve(repo))
    expect(list).toContain("基线分支 main｜建项时克隆一份副本")
    expect(create.listProjectRepoOptions()[0]).toMatchObject({ path: path.resolve(repo), baseBranch: "main", clone: true })
  })

  it("不是 git 根目录 / 不存在 / 相对路径：拒绝，什么都不记", async () => {
    const { call, config } = await boot()
    const plain = path.join(repoParent, "plain")
    fs.mkdirSync(plain)
    expect(await call({ action: "repo_save", repo: { repo_path: plain } })).toContain("不是 git 仓库的根目录")
    expect(await call({ action: "repo_save", repo: { repo_path: path.join(repoParent, "nope") } })).toContain("不存在")
    expect(await call({ action: "repo_save", repo: { repo_path: "shop" } })).toContain("绝对路径")
    expect(await call({ action: "repo_save", repo: { repo_path: "  " } })).toContain("repo.repo_path")
    expect(config.getRepoProfiles()).toEqual([])
  })

  it("测试 / 开发分支、不克隆：登记后 repos 都显示；再改只动给了的项，空串清掉分支，clone=true 改回克隆", async () => {
    const { call, config } = await boot()
    const repo = makeRepo("shop")
    await call({ action: "repo_save", repo: { repo_path: repo, base_branch: "main", test_branch: "release", develop_branch: "dev", clone: false } })
    let list = await call({ action: "repos" })
    expect(list).toContain("测试分支 release，开发分支 dev｜不克隆，只记录仓库信息")
    expect(config.getRepoProfiles()[0]).toMatchObject({ baseBranch: "main", testBranch: "release", developBranch: "dev", clone: false })

    const edit = await call({ action: "repo_save", repo: { repo_path: repo, test_branch: "" } })
    expect(edit).toContain("✅ 已更新常用代码仓库")
    expect(edit).toContain("测试分支 → （清空）")
    const p1 = config.getRepoProfiles()[0]
    expect(p1.testBranch).toBeUndefined()
    expect(p1).toMatchObject({ baseBranch: "main", developBranch: "dev", clone: false })

    await call({ action: "repo_save", repo: { repo_path: repo, clone: true } })
    const p2 = config.getRepoProfiles()
    expect(p2).toHaveLength(1)
    expect(p2[0].clone).toBeUndefined()
    list = await call({ action: "repos" })
    expect(list).toContain("建项时克隆一份副本")
    expect(list).not.toContain("不克隆")
    expect(await call({ action: "repo_save", repo: { repo_path: repo } })).toContain("没有变化")
  })

  it("同一个仓库换个写法（大小写、末尾斜杠）再登记，是改不是重复", async () => {
    const { call, config } = await boot()
    const repo = makeRepo("shop")
    await call({ action: "repo_save", repo: { repo_path: repo } })
    const out = await call({ action: "repo_save", repo: { repo_path: `${repo}${path.sep}`, base_branch: "release" } })
    expect(out).toContain("已更新")
    expect(config.getRepoProfiles()).toHaveLength(1)
    expect(config.getRepoProfiles()[0].baseBranch).toBe("release")
  })

  it("分支名不合法拒绝；本地仓库里找不到的分支只提醒（可能没 fetch），仍然登记", async () => {
    const { call, config } = await boot()
    const repo = makeRepo("shop")
    expect(await call({ action: "repo_save", repo: { repo_path: repo, base_branch: "bad name" } })).toContain("不是合法的分支名")
    expect(await call({ action: "repo_save", repo: { repo_path: repo, develop_branch: "-x" } })).toContain("不是合法的分支名")
    expect(config.getRepoProfiles()).toEqual([])
    const out = await call({ action: "repo_save", repo: { repo_path: repo, base_branch: "main", develop_branch: "not-fetched-yet" } })
    expect(out).toContain("⚠️ 开发分支「not-fetched-yet」在这个本地仓库里没找到")
    expect(config.getRepoProfiles()[0].developBranch).toBe("not-fetched-yet")
  })

  it("远程仓库：必须给基线分支（没法自动识别）、一定克隆；登记后 repos 照常列出", async () => {
    const { call, config } = await boot()
    const url = "https://gitlab.example.com/team/shop.git"
    expect(await call({ action: "repo_save", repo: { repo_path: url } })).toContain("问用户")
    expect(await call({ action: "repo_save", repo: { repo_path: url, base_branch: "main", clone: false } })).toContain("一定会克隆")
    expect(config.getRepoProfiles()).toEqual([])
    expect(await call({ action: "repo_save", repo: { repo_path: url, base_branch: "main" } })).toContain("✅ 已登记")
    expect(config.getRepoProfiles()[0]).toMatchObject({ path: url, baseBranch: "main" })
    expect(await call({ action: "repos" })).toContain("shop")
  })

  it("移除：只从常用列表去掉，磁盘上的仓库还在；没登记过的报错；写法差一点也认得", async () => {
    const { call, config } = await boot()
    const repo = makeRepo("shop")
    await call({ action: "repo_save", repo: { repo_path: repo } })
    expect(await call({ action: "repo_remove", repo: { repo_path: path.join(repoParent, "other") } })).toContain("没有")
    const out = await call({ action: "repo_remove", repo: { repo_path: `${repo}${path.sep}` } })
    expect(out).toContain("✅ 已从常用代码仓库里移除")
    expect(config.getRepoProfiles()).toEqual([])
    expect(fs.existsSync(path.join(repo, ".git"))).toBe(true)
    expect(await call({ action: "repo_remove", repo: { repo_path: repo } })).toContain("没有")
  })

  it("AI 登记的仓库，下一步建项目真的用得上：克隆副本、记进项目信息、基线分支沿用登记的", async () => {
    const { call, store } = await boot()
    const repo = makeRepo("shop")
    await call({ action: "repo_save", repo: { repo_path: repo, base_branch: "main", test_branch: "release" } })
    const out = await call({
      action: "create", name: "改版", template_id: "develop", bindings: BIND, feature_branch: "feature/x",
      repos: [{ repo_path: repo, base_branch: "main" }],
    })
    expect(out).toContain("✅ 已创建项目「改版」")
    const p = store.listProjects().find((x) => x.name === "改版")!
    expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/x")
    expect(p.metadata?.代码仓库).toContain("release")
    expect(git(repo, ["status", "--porcelain"])).toBe("")
  })
})

describe("项目模板：看、新建、修改、删除", () => {
  it("templates 列出每个模板的快捷操作；带 template_id 看详情，再带 action_id 看提示词全文", async () => {
    const { call } = await boot()
    const list = await call({ action: "templates" })
    expect(list).toContain("快捷操作：规划、实现、审查")
    const detail = await call({ action: "templates", template_id: "develop" })
    expect(detail).toContain("模板 id=develop「开发」")
    expect(detail).toContain("id=plan「规划」｜内置默认提示词")
    const full = await call({ action: "templates", template_id: "develop", action_id: "plan" })
    expect(full).toContain("内置默认，没自定义过")
    expect(full.length).toBeGreaterThan(detail.length / 4)
    expect(await call({ action: "templates", template_id: "nope" })).toContain("没有 id 为「nope」")
    expect(await call({ action: "templates", template_id: "develop", action_id: "nope" })).toContain("没有 id 为「nope」的快捷操作")
  })

  it("新建模板 → 立刻能 templates 看到、能用它建项目（必填项照样被要求）；快捷操作带着写好的提示词", async () => {
    const { call, store } = await boot()
    const out = await call({
      action: "template_save",
      template: {
        name: "客户拜访", description: "拜访前准备、拜访后跟进", needs_repo: false,
        fields: [{ label: "客户名称", required: true, placeholder: "某某公司" }, { label: "拜访目的", multiline: true }],
        actions: [{ label: "拜访准备", prompt: "整理客户背景和上次沟通要点" }, { label: "会后跟进", prompt: "整理纪要和待办" }],
      },
    })
    expect(out).toContain("✅ 已新建项目模板")
    expect(out).toContain("拜访准备(action-1)")
    const g = store.getNodeGroups().find((x) => x.name === "客户拜访")!
    expect(g.nodes.map((n) => n.prompt)).toEqual(["整理客户背景和上次沟通要点", "整理纪要和待办"])
    expect(await call({ action: "templates" })).toContain("客户名称（必填，例：某某公司）")

    const missing = await call({ action: "create", name: "拜访A公司", template_id: g.id, bindings: BIND })
    expect(missing).toContain("请填写：客户名称")
    const created = await call({ action: "create", name: "拜访A公司", template_id: g.id, fields: { 客户名称: "A 公司" }, bindings: BIND })
    expect(created).toContain("✅ 已创建项目")
    const p = store.listProjects().find((x) => x.name === "拜访A公司")!
    expect(p.metadata).toEqual({ 客户名称: "A 公司" })
    expect(p.groupSnapshot?.[0].nodes.map((n) => n.label)).toEqual(["拜访准备", "会后跟进"])
  })

  it("不合规的模板整个不保存：新增操作没写提示词 / 重名 / 删光操作，原来的模板一点没变", async () => {
    const { call, store } = await boot()
    const before = structuredClone(store.getNodeGroups())
    expect(await call({ action: "template_save", template: { name: "新模板", actions: [{ label: "做事" }] } })).toContain("要写 prompt")
    expect(await call({ action: "template_save", template: { name: "开发" } })).toContain("已经有叫「开发」的模板")
    expect(await call({ action: "template_save", template_id: "test", template: { actions: [] } })).toContain("至少")
    expect(await call({ action: "template_save", template_id: "nope", template: { name: "x" } })).toContain("没有 id 为「nope」")
    expect(store.getNodeGroups()).toEqual(before)
  })

  it("修改模板：已建项目有自己的副本不受影响；sync_steps 才让它用上新版", async () => {
    const { call, store } = await boot()
    const g0 = store.getNodeGroups().find((x) => x.id === "research")!
    expect(g0.nodes.length).toBeGreaterThan(1)
    const created = await call({ action: "create", name: "调研A", template_id: "research", bindings: BIND })
    expect(created).toContain("✅")
    const id = store.listProjects().find((x) => x.name === "调研A")!.id
    const snapBefore = whole(store.getProject(id)!.groupSnapshot)

    const keep = g0.nodes[0]
    const out = await call({
      action: "template_save", template_id: "research",
      template: { actions: [{ id: keep.id, label: "新版第一步", prompt: "按新流程做第一步" }, { label: "收尾", prompt: "做总结" }] },
    })
    expect(out).toContain("✅ 已更新项目模板")
    expect(out).toContain(`删掉的操作：${g0.nodes.slice(1).map((n) => n.label).join("、")}`)
    expect(store.getNodeGroups().find((x) => x.id === "research")!.nodes.map((n) => n.label)).toEqual(["新版第一步", "收尾"])
    expect(whole(store.getProject(id)!.groupSnapshot)).toBe(snapBefore)

    expect(await call({ action: "sync_steps", project_id: id })).toContain("✅ 已把项目「调研A」的快捷操作同步成模板最新版")
    expect(store.getProject(id)!.groupSnapshot![0].nodes.map((n) => n.label)).toEqual(["新版第一步", "收尾"])
    expect(await call({ action: "sync_steps" })).toContain("需要 project_id")
    expect(await call({ action: "sync_steps", project_id: "nope" })).toContain("未找到项目")
  })

  it("删除模板：自定义的能删；还有老项目（没有自己的副本）在用的不能删；有副本的项目不拦；至少留一个", async () => {
    const { call, store } = await boot()
    await call({ action: "template_save", template: { name: "临时模板" } })
    const tmp = store.getNodeGroups().find((x) => x.name === "临时模板")!
    expect(await call({ action: "template_delete", template_id: tmp.id })).toContain("✅ 已删除项目模板「临时模板」")
    expect(store.getNodeGroups().some((x) => x.id === tmp.id)).toBe(false)
    expect(await call({ action: "template_delete", template_id: tmp.id })).toContain("没有 id 为")
    expect(await call({ action: "template_delete" })).toContain("需要 template_id")

    // 老项目：没有模板副本，直接跟着全局模板走
    store.createProject({ name: "老项目", goal: "", worktreePath: path.join(userData, "old"), groupIds: ["event"], groupId: "event" })
    const blocked = await call({ action: "template_delete", template_id: "event" })
    expect(blocked).toContain("还有 1 个老项目在用")
    expect(store.getNodeGroups().some((x) => x.id === "event")).toBe(true)
    // 用 AI 建的项目（有副本）不拦
    await call({ action: "create", name: "新项目", template_id: "report", bindings: BIND })
    expect(await call({ action: "template_delete", template_id: "report" })).toContain("✅ 已删除")

    store.saveNodeGroups(store.getNodeGroups().filter((x) => x.id === "general"))
    expect(await call({ action: "template_delete", template_id: "general" })).toContain("至少要保留")
  })
})

describe("已有项目：看、改、归档", () => {
  async function newProject(call: (a: Record<string, unknown>) => Promise<string>, store: typeof import("../src/shared/project-store"), name = "改版") {
    await call({ action: "create", name, goal: "旧目标", template_id: "general", bindings: BIND, story_url: "https://t/1" })
    return store.listProjects().find((p) => p.name === name)!
  }

  it("get：目标、模板、目录、项目信息、快捷操作；不存在的 id 报错", async () => {
    const { call, store } = await boot()
    const p = await newProject(call, store)
    const t = await call({ action: "get", project_id: p.id })
    for (const w of [`「改版」id=${p.id}`, "目标：旧目标", "模板：通用任务", "项目链接：https://t/1", "快捷操作："]) expect(t).toContain(w)
    expect(await call({ action: "get", project_id: "nope" })).toContain("未找到项目")
    expect(await call({ action: "get" })).toContain("需要 project_id")
  })

  it("update：改名字 / 目标 / 链接，项目信息合并写入（空值删除）；项目目录、模板、会话原样", async () => {
    const { call, store } = await boot()
    const p = await newProject(call, store)
    await call({ action: "update", project_id: p.id, fields: { 截止时间: "周五", 负责人: "小王" } })
    const out = await call({
      action: "update", project_id: p.id, name: "改版 v2", goal: "新目标", story_url: "",
      fields: { 截止时间: "", 优先级: "高" },
    })
    expect(out).toContain("✅ 已更新项目「改版 v2」")
    expect(out).toContain("项目目录名不会跟着改")
    const after = store.getProject(p.id)!
    expect(after).toMatchObject({ name: "改版 v2", goal: "新目标", worktreePath: p.worktreePath, bindings: p.bindings, groupId: p.groupId })
    expect(after.storyUrl).toBeUndefined()
    expect(after.metadata).toEqual({ 负责人: "小王", 优先级: "高" })
    expect(await call({ action: "update", project_id: p.id })).toContain("没有要改的内容")
    expect(await call({ action: "update", project_id: p.id, name: "  " })).toContain("不能为空")
    expect(await call({ action: "update", project_id: p.id, goal: "新目标" })).toContain("没有变化")
    expect(store.getProject(p.id)!.name).toBe("改版 v2")
  })

  it("archive：归档后 list 标出已归档，会话和目录都在；archived=false 取消；不给 archived 报错", async () => {
    const { call, store } = await boot()
    const p = await newProject(call, store)
    expect(await call({ action: "archive", project_id: p.id })).toContain("需要 archived")
    const out = await call({ action: "archive", project_id: p.id, archived: true })
    expect(out).toContain("✅ 已归档项目「改版」")
    expect(store.getProject(p.id)!.archivedAt).toBeGreaterThan(0)
    expect(fs.existsSync(p.worktreePath)).toBe(true)
    expect(await call({ action: "list" })).toContain("（已归档）")
    expect(await call({ action: "archive", project_id: p.id, archived: false })).toContain("已取消归档")
    expect(store.getProject(p.id)!.archivedAt).toBeUndefined()
  })
})

describe("项目按消息通道隔离：只管接入了自己所在通道的项目", () => {
  const mk = (store: typeof import("../src/shared/project-store"), name: string, channelId: string) =>
    store.createProject({
      name, goal: "", worktreePath: path.join(userData, name, "workspace"), groupIds: ["general"], groupId: "general",
      bindings: [{ kind: "main", channelId }],
    })

  it("list 只列接入了调用者通道的；别的通道的项目 get / update / archive / bind / unbind / delete 一律按「未找到」处理，宿主不会被打扰", async () => {
    const { call, store, requests } = await boot()
    const mine = mk(store, "我的", FEISHU)
    const theirs = mk(store, "别人的", "ch_other")
    const list = await call({ action: "list" })
    expect(list).toContain(mine.id)
    expect(list).not.toContain(theirs.id)
    expect(list).not.toContain("别人的")

    for (const args of [
      { action: "get" }, { action: "update", name: "x" }, { action: "archive", archived: true }, { action: "sync_steps" }, { action: "delete" },
      { action: "bind", bindings: BIND }, { action: "unbind", bindings: BIND },
    ]) {
      const text = await call({ ...args, project_id: theirs.id })
      expect(text, String(args.action)).toContain("未找到项目")
    }
    expect(requests).toEqual([])
    expect(store.getProject(theirs.id)?.name).toBe("别人的")
  })

  it("项目同时接了多个通道：每个通道的调用者都管得到它", async () => {
    const { call, store } = await boot()
    const p = mk(store, "两边都有", "ch_other")
    p.bindings = [{ kind: "main", channelId: "ch_other" }, { kind: "main", channelId: FEISHU }]
    store.saveProject(p)
    expect(await call({ action: "list" })).toContain(p.id)
    expect(await call({ action: "get", project_id: p.id })).toContain(p.id)
  })

  it("没有接入任何通道的项目（比如老数据）：谁的 list 里都没有，只能在设置页处理", async () => {
    const { call, store } = await boot()
    const p = store.createProject({ name: "无主", goal: "", worktreePath: path.join(userData, "无主", "workspace"), groupIds: ["general"], groupId: "general" })
    expect(await call({ action: "list" })).toContain("暂无项目")
    expect(await call({ action: "get", project_id: p.id })).toContain("未找到项目")
  })
})

describe("help 总览的「当前状态」跟着真实配置走", () => {
  it("没配时提示没仓库要登记；配好之后变成数量和已配置", async () => {
    const { call } = await boot()
    const first = await call({ action: "help" })
    expect(first).toContain("帮用户建项目：完整流程")
    expect(first).toContain("## 当前状态")
    expect(first).toContain("常用代码仓库：还没有")
    expect(first).toContain("项目模板：7 个")
    expect(first).toContain("没配。可选")

    await call({ action: "repo_save", repo: { repo_path: makeRepo("shop") } })
    await call({ action: "settings_set", settings: { worktree_root: path.join(rootParent, "ws"), gitlab_token: TOKEN } })
    const second = await call({ action: "help" })
    expect(second).toContain("常用代码仓库：1 个")
    expect(second).toContain("已自定义为")
    expect(second).toContain("GitLab / 共享空间：已配置")
    expect(second).not.toContain("TOPSECRET")
  })

  it("topic 细节篇不带当前状态；不认识的 topic 在参数校验就被拒", async () => {
    const { call, requests } = await boot()
    const t = await call({ action: "help", topic: "repos" })
    expect(t).toContain("常用代码仓库（repos / repo_save / repo_remove）")
    expect(t).not.toContain("## 当前状态")
    expect(requests).toEqual([])
    await expect(call({ action: "help", topic: "billing" })).rejects.toThrow("参数没过校验")
  })

  it("宿主没响应：手册照样给，只是没有当前状态", async () => {
    vi.resetModules()
    const { registerAdminTools } = await import("../src/server-admin")
    const s = new McpServer({ name: "t", version: "0" })
    registerAdminTools(s, { hostRpc: { request: async () => ({ ok: false, error: "主进程没有响应" }), settle: () => false, pendingCount: () => 0 } })
    const tool = (s as any)._registeredTools.manage_project
    const res = await tool.handler({ action: "help" }, {})
    expect(res.content[0].text).toContain("帮用户建项目：完整流程")
    expect(res.content[0].text).not.toContain("## 当前状态")
    const set = await tool.handler({ action: "settings" }, {})
    expect(set.content[0].text).toBe("❌ 主进程没有响应")
  })
})

describe("管理 MCP → 宿主：每个 action 发出的请求类型和参数形状", () => {
  it("snake_case 参数翻成驼峰；请求类型固定", async () => {
    const { call, requests, store } = await boot()
    // 管项目的 action 只认接入了调用者所在通道的项目：先建一个真的
    await call({ action: "create", name: "已有", template_id: "general", bindings: BIND })
    const pid = store.listProjects()[0].id
    const sent = async (args: Record<string, unknown>) => {
      requests.length = 0
      await call(args)
      expect(requests).toHaveLength(1)
      return requests[0]
    }
    expect(await sent({ action: "repo_save", repo: { repo_path: "/x", base_branch: "main", test_branch: "t", develop_branch: "d", clone: false } }))
      .toEqual({ kind: "project.repo.save", payload: { repo: { repoPath: "/x", baseBranch: "main", testBranch: "t", developBranch: "d", clone: false } } })
    expect((await sent({ action: "repo_remove", repo: { repo_path: "/x" } })).kind).toBe("project.repo.remove")
    expect(await sent({
      action: "template_save", template_id: "t1",
      template: { name: "n", description: "d", needs_repo: true, work_branch: "test", fields: [{ label: "f", required: true }], actions: [{ id: "a", label: "A", prompt: "p" }] },
    })).toEqual({
      kind: "project.template.save",
      payload: {
        templateId: "t1",
        template: { name: "n", description: "d", needsRepo: true, workBranch: "test", fields: [{ label: "f", required: true }], actions: [{ id: "a", label: "A", prompt: "p" }] },
      },
    })
    expect(await sent({ action: "template_delete", template_id: "t1" })).toEqual({ kind: "project.template.delete", payload: { templateId: "t1" } })
    expect(await sent({ action: "templates", template_id: "t1", action_id: "a" })).toEqual({ kind: "project.template.detail", payload: { templateId: "t1", actionId: "a" } })
    expect(await sent({ action: "templates" })).toEqual({ kind: "project.templates", payload: {} })
    expect(await sent({ action: "settings" })).toEqual({ kind: "project.settings.get", payload: {} })
    expect(await sent({
      action: "settings_set",
      settings: { worktree_root: "/w", git_principles: "g", reset_git_principles: false, gitlab_host: "h", gitlab_token: "t", flow_hub_url: "u", flow_hub_token: "ft", flow_hub_author: "a" },
    })).toEqual({
      kind: "project.settings.set",
      payload: { settings: { worktreeRoot: "/w", gitPrinciples: "g", resetGitPrinciples: false, gitlabHost: "h", gitlabToken: "t", flowHubUrl: "u", flowHubToken: "ft", flowHubAuthor: "a" } },
    })
    expect(await sent({ action: "update", project_id: pid, name: "n", goal: "g", story_url: "s", related_docs: "r", fields: { k: "v" } }))
      .toEqual({ kind: "project.update", payload: { projectId: pid, update: { name: "n", goal: "g", storyUrl: "s", relatedDocs: "r", info: { k: "v" } } } })
    expect(await sent({ action: "archive", project_id: pid, archived: true })).toEqual({ kind: "project.archive", payload: { projectId: pid, archived: true } })
    expect(await sent({ action: "get", project_id: pid })).toEqual({ kind: "project.get", payload: { projectId: pid } })
    expect(await sent({ action: "sync_steps", project_id: pid })).toEqual({ kind: "project.sync-steps", payload: { projectId: pid } })
    // 通道和接入：带上调用者所在的聊天；bindings 翻成驼峰，unbind 放一项
    const chatKey = `${FEISHU}|ou_main`
    expect(await sent({ action: "channels" })).toEqual({ kind: "project.channels", payload: { chatKey } })
    expect(await sent({ action: "bind", project_id: pid, bindings: [{ channel_id: FEISHU, mode: "bind", group_chat_id: "oc_aa2192cfececee92d57dccd0b59980fd" }] }))
      .toEqual({ kind: "project.bind", payload: { chatKey, projectId: pid, bindings: [{ channelId: FEISHU, mode: "bind", groupChatId: "oc_aa2192cfececee92d57dccd0b59980fd" }] } })
    expect(await sent({ action: "unbind", project_id: pid, bindings: [{ channel_id: FEISHU, mode: "bind" }] }))
      .toEqual({ kind: "project.unbind", payload: { chatKey, projectId: pid, binding: { channelId: FEISHU, mode: "bind" } } })
  })

  it("缺必要参数：在管理 MCP 这一层就报错，不打扰宿主", async () => {
    const { call, requests, store } = await boot()
    await call({ action: "create", name: "已有", template_id: "general", bindings: BIND })
    const pid = store.listProjects()[0].id
    requests.length = 0
    for (const [args, hint] of [
      [{ action: "get" }, "project_id"],
      [{ action: "update" }, "project_id"],
      [{ action: "archive", project_id: pid }, "archived"],
      [{ action: "bind" }, "project_id"],
      [{ action: "bind", project_id: pid }, "bindings"],
      [{ action: "unbind", project_id: pid }, "bindings"],
      [{ action: "unbind", project_id: pid, bindings: [{ channel_id: FEISHU, mode: "inline" }, { channel_id: FEISHU, mode: "bind" }] }, "只放一项"],
      [{ action: "create", name: "n", template_id: "general" }, "bindings"],
      [{ action: "repo_save" }, "repo.repo_path"],
      [{ action: "repo_remove", repo: { repo_path: " " } }, "repo.repo_path"],
      [{ action: "template_save" }, "template"],
      [{ action: "template_delete" }, "template_id"],
      [{ action: "settings_set" }, "settings"],
    ] as [Record<string, unknown>, string][]) {
      const text = await call(args)
      expect(text.startsWith("❌"), String(args.action)).toBe(true)
      expect(text, String(args.action)).toContain(hint)
    }
    expect(requests).toEqual([])
  })
})

describe("接线（读源码守住只有真实应用跑得到的部分）", () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n")

  it("宿主处理函数都注册进了 projectHostRpcHandlers；管理 MCP 用到的请求类型宿主都认得", () => {
    const create = read("electron", "project-create.ts")
    expect(create).toContain("...createProjectAdminHandlers({ setArchived: setProjectArchivedByUser, syncSteps: syncProjectSteps })")
    const kinds = [...read("src", "server-admin.ts").matchAll(/"(project\.[a-z.-]+)"/g)].map((m) => m[1])
    const admin = read("electron", "project-admin.ts")
    for (const k of new Set(kinds)) {
      expect(admin.includes(`"${k}"`) || create.includes(`"${k}"`), `宿主不认识 ${k}`).toBe(true)
    }
  })

  it("密钥不进日志：宿主里所有 pushUiLog 的内容都不拼入设置的值（设置那条只拼键名）", () => {
    const admin = read("electron", "project-admin.ts")
    const logs = admin.split("\n").filter((l) => l.includes("pushUiLog("))
    expect(logs.length).toBeGreaterThan(5)
    for (const l of logs) expect(l, l).not.toMatch(/[Tt]oken|plan\.patch\[|Object\.values\(/)
    expect(logs.find((l) => l.includes("修改了项目设置"))).toContain("Object.keys(plan.patch)")
  })
})
