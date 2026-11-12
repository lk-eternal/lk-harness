/**
 * 端到端（真实 daemon 进程 + 真实主进程项目代码）：应用内建项目、点步骤、删项目。
 *
 * 主进程这头是真的 config-store / project-store / project-commands / project-create / session-dispatcher
 * （只把 electron 和落盘的 electron-store 顶掉），daemon 是真的隔离 daemon，走真实 HTTP：
 * - 建项目后，daemon 里应用内聊天的当前会话真的切到了项目会话，会话树里它是 project 标签
 * - 点步骤：步骤提示词真的进了项目会话的队列，聊天记录里真的多了一条「▶ 开始」的通知（这条是 daemon 生成的，单测看不到）
 * - 删项目：路由登记、聊天记录真的清了，当前会话回到默认
 *
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startIsolatedDaemon, waitFor, type IsolatedDaemon } from "../helpers/isolated-daemon"

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
vi.mock("../../electron/agent-engine/factory", async (orig) => {
  const actual = await orig<typeof import("../../electron/agent-engine/factory")>()
  const engine = { listSessions: () => [], isRunning: () => false, setIdleHandler: () => {}, launch: async () => ({ ok: true }), stop: async () => {} }
  return { ...actual, getAllAgentEngines: () => [engine] as never, getAgentEngine: () => engine as never }
})

const CH = "ch_test"
const APP_CHAT = `${CH}|app_main`

let d: IsolatedDaemon
let folder = ""

beforeEach(async () => {
  d = await startIsolatedDaemon()
  userData = d.dataDir
  trashed.length = 0
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-proj-folder-"))
})
afterEach(async () => {
  await d?.stop()
  fs.rmSync(folder, { recursive: true, force: true })
})

async function boot() {
  vi.resetModules()
  const overrides = await import("../../src/shared/session-overrides-store")
  overrides.initSessionOverridesStore(userData)
  const config = await import("../../electron/config-store")
  config.saveConfig({
    channels: [{
      id: CH, name: "测试", type: "app", enabled: true, agentResourceId: "sdk_t", model: "auto", modelParams: "",
      othersModel: "", othersModelParams: "", allowOthers: false, digitalIdentity: "", workspaceDir: d.wsDir,
      mainUserEnabled: true, mainUserChatId: "app_main",
    }] as never,
    agentResources: [{ id: "sdk_t", type: "sdk", name: "t", apiKey: "k" }] as never,
    favWorkspacesMigrated: true,
  })
  const store = await import("../../src/shared/project-store")
  store.initProjectStore(userData)
  const create = await import("../../electron/project-create")
  const dispatcher = await import("../../electron/session-dispatcher")
  dispatcher.initSessionDispatcher()
  const tabs = async () => {
    const tree = await dispatcher.listDashboardTree()
    expect(tree.error, "会话树报错").toBeUndefined()
    return tree.channels.find((c) => c.channelId === CH)!.mainTabs
  }
  return { store, create, tabs }
}

const history = async (sessionKey: string): Promise<Array<{ kind: string; text?: string }>> =>
  (await d.post("/api/app-chat/history", { sessionKey })).items ?? []
const pollKey = async (key: string): Promise<string[]> => {
  const r = await (await fetch(`${d.base}/api/poll-message?sessionKey=${encodeURIComponent(key)}&wait=false`)).json() as { messages?: Array<{ text: string }> }
  return (r.messages ?? []).map((m) => m.text)
}

describe("应用内项目：真实 daemon", () => {
  it("建项目：daemon 的当前会话切到项目会话，会话树里是项目标签", async () => {
    const { create, tabs } = await boot()
    const r = await create.createProjectFromApp(CH, { name: "Q4 调研", goal: "看清竞品", templateId: "research", fields: { 交付形式: "PPT" } })
    expect(r.ok).toBe(true)
    expect(r.warning).toBeUndefined()
    expect(r.sessionKey).toBe(`${APP_CHAT}::project_${r.projectId}`)

    const active = await d.get("/api/active-sessions")
    expect(active.sessions[APP_CHAT]).toBe(r.sessionKey)

    const tab = (await tabs()).find((t) => t.sessionKey === r.sessionKey)
    expect(tab).toMatchObject({ kind: "project", label: "Q4 调研", current: true })
    expect(tab).not.toHaveProperty("archived") // 没归档的会话不带这个字段
  })

  it("归档：会话还在列表里，只是标上 archived（侧栏据此收进「已归档」分组）；取消归档就恢复；别的会话不受影响", async () => {
    const { create, tabs } = await boot()
    const a = await create.createProjectFromApp(CH, { name: "做完的", templateId: "general" })
    const b = await create.createProjectFromApp(CH, { name: "还在做的", templateId: "general" })
    const find = async (key: string | undefined) => (await tabs()).find((t) => t.sessionKey === key)

    expect(create.setProjectArchivedByUser(a.projectId!, true, { channelId: CH }).ok).toBe(true)
    expect(await find(a.sessionKey)).toMatchObject({ kind: "project", label: "做完的", archived: true })
    expect(await find(b.sessionKey)).toMatchObject({ kind: "project", label: "还在做的" })
    expect(await find(b.sessionKey)).not.toHaveProperty("archived")

    expect(create.setProjectArchivedByUser(a.projectId!, false, { channelId: CH }).ok).toBe(true)
    expect(await find(a.sessionKey)).not.toHaveProperty("archived")
  })

  it("点步骤：提示词进了项目会话的队列，聊天记录里有「开始」的通知；全局当前项目指针不动", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(CH, { name: "写周报", templateId: "report" })
    const before = store.getCurrentProjectId()

    expect(await create.runProjectStepFromApp(CH, r.projectId!, "draft-report")).toEqual({ ok: true })
    const texts = await pollKey(r.sessionKey!)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("[PROJECT_ACTION]")
    expect(texts[0]).not.toMatch(/分支与红线|GitLab/)
    expect(store.getCurrentProjectId()).toBe(before)

    expect(await waitFor(async () => (await history(r.sessionKey!)).some((i) => i.kind === "notice" && i.text?.includes("▶ 开始：")))).toBe(true)
    // 项目会话以外的会话里不会有这条通知
    expect((await history(d.sessionKey)).some((i) => i.kind === "notice" && i.text?.includes("▶ 开始："))).toBe(false)
  })

  it("项目会话里直接发消息也能到 Agent（和普通会话一样），项目目录是它的工作目录", async () => {
    const { store, create } = await boot()
    const r = await create.createProjectFromApp(CH, { name: "随便聊", templateId: "general" })
    const send = await d.post("/api/app-chat/send", { sessionKey: r.sessionKey, text: "先帮我理一下思路" })
    expect(send.ok).toBe(true)
    expect(await pollKey(r.sessionKey!)).toEqual(["先帮我理一下思路"])
    const p = store.getProject(r.projectId!)!
    expect(fs.existsSync(p.worktreePath)).toBe(true)
  })

  it("删项目（应用自己管的目录）：目录进回收站，聊天记录和路由登记清掉，当前会话回到默认", async () => {
    const { store, create, tabs } = await boot()
    const r = await create.createProjectFromApp(CH, { name: "临时调研", templateId: "research" })
    await create.runProjectStepFromApp(CH, r.projectId!, "scope")
    const p = store.getProject(r.projectId!)!
    expect((await history(r.sessionKey!)).length).toBeGreaterThan(0)

    expect((await create.deleteProjectByUser(r.projectId!, { channelId: CH })).ok).toBe(true)
    expect(store.getProject(r.projectId!)).toBeUndefined()
    expect(trashed).toEqual([path.dirname(p.worktreePath)])
    expect(await history(r.sessionKey!)).toEqual([])
    const active = await d.get("/api/active-sessions")
    expect(active.sessions?.[APP_CHAT]).not.toBe(r.sessionKey)
    expect((await tabs()).some((t) => t.sessionKey === r.sessionKey)).toBe(false)
  })

  it("研发类项目：克隆仓库、会话切过去、点快捷操作带研发红线；删项目只移工作目录，用户自己的仓库原样", async () => {
    const { store, create, tabs } = await boot()
    const git = (cwd: string, args: string[]) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true })
      if (r.status !== 0) throw new Error(r.stderr || r.stdout || "git failed")
      return (r.stdout || "").trim()
    }
    const repo = path.join(folder, "shop")
    fs.mkdirSync(repo)
    git(repo, ["init"]); git(repo, ["config", "user.email", "t@t.com"]); git(repo, ["config", "user.name", "t"])
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n")
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "init"]); git(repo, ["branch", "-M", "main"])
    const repoHead = git(repo, ["rev-parse", "HEAD"])

    const r = await create.createProjectFromApp(CH, {
      name: "订单页改版", templateId: "develop", repos: [{ repoPath: repo, baseBranch: "main" }], featureBranch: "feature/order",
    })
    expect(r.ok, r.error).toBe(true)
    expect(r.sessionKey).toBe(`${APP_CHAT}::project_${r.projectId}`)
    const p = store.getProject(r.projectId!)!
    expect(p.workspaceType).toBe("worktree")
    expect(git(p.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/order")
    expect((await d.get("/api/active-sessions")).sessions[APP_CHAT]).toBe(r.sessionKey)
    expect((await tabs()).find((t) => t.sessionKey === r.sessionKey)).toMatchObject({ kind: "project", label: "订单页改版", current: true })

    expect(await create.runProjectStepFromApp(CH, r.projectId!, "plan")).toEqual({ ok: true })
    const texts = await pollKey(r.sessionKey!)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("[PROJECT_ACTION]")
    expect(texts[0]).toContain("分支与红线")

    expect((await create.deleteProjectByUser(r.projectId!, { channelId: CH })).ok).toBe(true)
    expect(trashed).toEqual([path.dirname(p.worktreePath)])
    expect(store.getProject(r.projectId!)).toBeUndefined()
    // 用户自己的仓库：提交、分支、文件都没动，也没多出分支
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(repoHead)
    expect(git(repo, ["branch", "--format=%(refname:short)"]).split(/\r?\n/)).toEqual(["main"])
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hi\n")
  })

  it("用自己选的文件夹建项目、删项目：文件夹和里面的文件始终原样", async () => {
    const { store, create } = await boot()
    fs.writeFileSync(path.join(folder, "资料.md"), "我的资料")
    const r = await create.createProjectFromApp(CH, { name: "整理资料", templateId: "writing", folder })
    expect(r.ok).toBe(true)
    expect(store.getProject(r.projectId!)?.worktreePath).toBe(path.resolve(folder))

    expect((await create.deleteProjectByUser(r.projectId!, { channelId: CH })).ok).toBe(true)
    expect(trashed).toEqual([])
    expect(fs.readFileSync(path.join(folder, "资料.md"), "utf8")).toBe("我的资料")
  })
})
