/**
 * 端到端（真实 daemon 进程）：项目缺陷监控。
 *
 * 飞书项目 CLI 用假的（tests/helpers/fake-meegle.cjs，经 MEEGLE_CLI_PATH 接入，返回结构照真实的 moql 响应），
 * 其余——项目文件、去重记录、项目会话队列、项目群通知——都是真的。
 * 触发用 /api/bug-watch-run（立刻跑一轮），定时器间隔拉到 1 小时，不会在测试中途自己跑。
 *
 * 假 CLI 只接了 Windows 的调用方式（MEEGLE_CLI_PATH 指向 js 文件）；其它平台的 CLI 走 PATH，这里跳过。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configDir } from "../../src/shared/data-paths"
import { initProjectStore, saveProject } from "../../src/shared/project-store"
import { projectSessionKey, type Project } from "../../src/shared/project-types"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

const FAKE_CLI = path.resolve(__dirname, "../helpers/fake-meegle.cjs")
// 应用内通道只有一个固定的聊天（app_main），聊天记录接口也只认它：用它充当「项目群」，群通知才查得到
const GROUP = "ch_test|app_main"
const STORY_ID = "7141906911"
const STORY_NAME = "【满班率】组班"
const STORY_URL = `https://project.feishu.cn/wk-dm/story/detail/${STORY_ID}`

interface FakeBug { id: number; name: string; status?: string; assignee?: string; priority?: string }
interface FakeData { authenticated?: boolean; failQuery?: boolean; stories: Record<string, string>; bugs: Record<string, FakeBug[]> }

let d: IsolatedDaemon
let tmp = ""
let dataFile = ""
let logFile = ""
const savedEnv: Record<string, string | undefined> = {}

const setFake = (patch: Partial<FakeData>) => {
  const cur: FakeData = JSON.parse(fs.readFileSync(dataFile, "utf8"))
  fs.writeFileSync(dataFile, JSON.stringify({ ...cur, ...patch }))
}
const setBugs = (...bugs: FakeBug[]) => setFake({ bugs: { [STORY_NAME]: bugs } })
/** 假 CLI 被调用的次数（按命令统计） */
const cliCalls = (cmd?: string) => {
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []
  const all = lines.map((l) => JSON.parse(l) as string[])
  return cmd ? all.filter((a) => a.slice(0, 2).join(" ") === cmd).length : all.length
}

const SESSION = projectSessionKey(GROUP, "pw")
const addProject = (extra: Partial<Project> = {}) => saveProject({
  id: "pw", name: "满班率项目", goal: "g", repoPath: "", baseBranch: "main", featureBranch: "", worktreePath: "",
  workspaceType: "plain", status: "active", sessionKey: SESSION, groupChatId: GROUP, storyUrl: STORY_URL, watchBugs: true,
  createdAt: Date.now(), updatedAt: Date.now(), ...extra,
})

const run = (projectId?: string) => d.post("/api/bug-watch-run", projectId ? { projectId } : {})
const pollKey = async (key: string): Promise<string[]> => {
  const r = await (await fetch(`${d.base}/api/poll-message?sessionKey=${encodeURIComponent(key)}&wait=false`)).json() as { messages?: Array<{ text: string }> }
  return (r.messages ?? []).map((m) => m.text)
}
const confirm = (key: string) => d.post("/api/confirm-claimed", { session_key: key })
const historyHas = async (sessionKey: string, needle: string) =>
  JSON.stringify((await d.post("/api/app-chat/history", { sessionKey })).items ?? []).includes(needle)
const stateFile = () => path.join(configDir(d.dataDir), "bug-watch-state.json")
const readState = (): Record<string, any> => {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")).projects ?? {} } catch { return {} }
}

describe.skipIf(process.platform !== "win32")("项目缺陷监控", () => {
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-fake-meegle-"))
    dataFile = path.join(tmp, "data.json")
    logFile = path.join(tmp, "calls.log")
    fs.writeFileSync(dataFile, JSON.stringify({ authenticated: true, stories: { [STORY_ID]: STORY_NAME }, bugs: { [STORY_NAME]: [] } } satisfies FakeData))
    for (const [k, v] of Object.entries({
      MEEGLE_CLI_PATH: FAKE_CLI, FAKE_MEEGLE_DATA: dataFile, FAKE_MEEGLE_LOG: logFile, LK_BUG_WATCH_INTERVAL_MS: "3600000",
    })) { savedEnv[k] = process.env[k]; process.env[k] = v }
    d = await startIsolatedDaemon()
    initProjectStore(d.dataDir)
  })
  afterEach(async () => {
    await d?.stop()
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("没有项目开监控：什么都不查（飞书项目 CLI 一次都没被调用）", async () => {
    addProject({ watchBugs: false })
    const r = await run()
    expect(r.ok).toBe(true)
    expect(r.ran).toBe(false)
    expect(cliCalls()).toBe(0)
  })

  it("第一轮只建基线（不打扰）；之后新增的缺陷投给项目会话、项目群里提一句；再查不重复", async () => {
    setBugs({ id: 1, name: "老缺陷A" }, { id: 2, name: "老缺陷B" })
    addProject()

    const first = await run()
    expect(first.projects[0]).toMatchObject({ projectId: "pw", result: "baseline" })
    expect(await pollKey(SESSION)).toEqual([])
    expect(Object.keys(readState().pw.seen).sort()).toEqual(["1", "2"])
    expect(readState().pw).toMatchObject({ storyId: STORY_ID, storyName: STORY_NAME })

    setBugs({ id: 1, name: "老缺陷A" }, { id: 2, name: "老缺陷B" }, { id: 3, name: "登录页白屏", assignee: "张三", priority: "P1", status: "OPEN" })
    const second = await run()
    expect(second.projects[0]).toMatchObject({ result: "new", fresh: 1 })

    const msgs = await pollKey(SESSION)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("🐞 缺陷监控「满班率项目」：新增 1 个缺陷")
    expect(msgs[0]).toContain("[P1] 登录页白屏（#3，OPEN，负责人：张三）")
    expect(msgs[0]).toContain("缺陷监控")
    expect(msgs[0]).not.toContain("老缺陷")
    expect(await historyHas(SESSION, "新增 1 个缺陷")).toBe(true)
    await confirm(SESSION)

    const third = await run()
    expect(third.projects[0]).toMatchObject({ result: "unchanged" })
    expect(await pollKey(SESSION)).toEqual([])
    expect(readState().pw.seen["3"]).toBe("OPEN")
  })

  it("需求名称只取一次（缓存在记录里），之后每轮只发一次查询", async () => {
    addProject()
    await run(); await run(); await run()
    expect(cliCalls("workitem get")).toBe(1)
    expect(cliCalls("workitem query")).toBe(3)
  })

  it("项目还没有会话：发现新缺陷也不记账，等有会话后补投", async () => {
    setBugs({ id: 1, name: "老缺陷" })
    addProject({ sessionKey: undefined, groupChatId: undefined })
    await run() // 基线
    setBugs({ id: 1, name: "老缺陷" }, { id: 2, name: "新缺陷" })

    const failed = await run()
    expect(failed.projects[0]).toMatchObject({ result: "error", fresh: 1 })
    expect(failed.projects[0].detail).toContain("还没有会话")
    expect(readState().pw.seen["2"]).toBeUndefined()

    addProject() // 项目有了会话
    const ok = await run()
    expect(ok.projects[0]).toMatchObject({ result: "new", fresh: 1 })
    const msgs = await pollKey(SESSION)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain("新缺陷")
  })

  it("查询失败：不记账、不当作空结果；恢复后第一次成功仍只是基线，不会把存量缺陷刷一遍", async () => {
    addProject()
    setFake({ failQuery: true, bugs: { [STORY_NAME]: [1, 2, 3, 4, 5].map((id) => ({ id, name: `存量${id}` })) } })
    const failed = await run()
    expect(failed.projects[0].result).toBe("error")
    expect(readState().pw).toBeUndefined()

    setFake({ failQuery: false })
    const recovered = await run()
    expect(recovered.projects[0].result).toBe("baseline")
    expect(await pollKey(SESSION)).toEqual([])
  })

  it("飞书项目没登录：整轮跳过，不查缺陷", async () => {
    setFake({ authenticated: false })
    addProject()
    const r = await run()
    expect(r.ran).toBe(false)
    expect(r.reason).toContain("未登录")
    expect(cliCalls("workitem query")).toBe(0)
  })

  it("已暂停的项目 / 需求链接不支持的项目：跳过并说明原因，不查", async () => {
    addProject({ status: "paused" })
    expect((await run()).projects[0]).toMatchObject({ result: "skipped", detail: "项目已暂停" })
    addProject({ storyUrl: "https://project.feishu.cn/wk-dm/t1024/detail/1" })
    const r = await run()
    expect(r.projects[0].result).toBe("skipped")
    expect(r.projects[0].detail).toContain("wk-dm")
    expect(cliCalls()).toBe(0)
  })

  it("项目被删除后记录被清掉", async () => {
    addProject()
    await run()
    expect(readState().pw).toBeDefined()
    fs.rmSync(path.join(d.dataDir, "projects", "pw.json"), { force: true })
    await run()
    expect(readState().pw).toBeUndefined()
  })
})
