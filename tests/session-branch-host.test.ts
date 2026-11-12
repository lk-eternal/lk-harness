import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { BranchState } from "../electron/git-branch"

/**
 * 切分支接到应用上的这一层：会话 → 目录、哪些会话算「在回复」、哪些会话不让切。
 * 真实的 session-branch + session-branch-core + 会话记录文件（临时数据目录）；
 * electron、通道表、会话列表、worker 阶段、git 都顶掉（git 本身在 git-branch-io.test.ts 里用真仓库测过）。
 */

let userData = ""
let work = ""
let channels: Record<string, { type: string }> = {}
let sessions: Array<{ sessionKey: string; workspaceDir?: string }> = []
const sdkPhase = new Map<string, string>()
const llmPhase = new Map<string, string>()
let gitState: BranchState
const switchCalls: Array<{ dir: string; name: string }> = []
const logs: string[] = []

vi.mock("electron", () => ({ app: { getPath: () => userData } }))
vi.mock("../electron/config-store", () => ({ getChannel: (id?: string) => (id ? channels[id] : undefined) }))
vi.mock("../electron/agent-engine/control", () => ({ listAllAgentSessions: () => sessions }))
vi.mock("../electron/sdk-session-worker", () => ({ getSdkWorkerPhase: (k: string) => sdkPhase.get(k) ?? null }))
vi.mock("../electron/llm-session-worker", () => ({ getLlmWorkerPhase: (k: string) => llmPhase.get(k) ?? null }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: (m: string) => { logs.push(m) } }))
vi.mock("../electron/git-branch", () => ({
  readBranchState: async () => ({ ok: true, ...gitState }),
  switchBranch: async (dir: string, t: { name: string }) => {
    switchCalls.push({ dir, name: t.name })
    return { ok: true, current: t.name }
  },
}))

async function load() {
  vi.resetModules()
  const store = await import("../src/shared/session-overrides-store")
  store.resetSessionOverridesStoreForTests()
  store.initSessionOverridesStore(userData)
  const mod = await import("../electron/session-branch")
  return { ...mod, store }
}

const key = (dir: string) => `ch_app|app_main::${dir}`

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "branch-host-ud-"))
  work = fs.mkdtempSync(path.join(os.tmpdir(), "branch-host-work-"))
  fs.mkdirSync(path.join(work, "repo", "pkg"), { recursive: true })
  fs.mkdirSync(path.join(work, "other"), { recursive: true })
  channels = { ch_app: { type: "app" }, ch_feishu: { type: "feishu" } }
  sessions = []
  sdkPhase.clear()
  llmPhase.clear()
  switchCalls.length = 0
  logs.length = 0
  gitState = {
    toplevel: path.join(work, "repo"),
    current: "main",
    detached: false,
    branches: [{ name: "main", kind: "local", current: true }, { name: "dev", kind: "local" }],
    dirty: 0,
    truncated: false,
  }
})

afterEach(() => {
  for (const d of [userData, work]) fs.rmSync(d, { recursive: true, force: true })
})

describe("哪些会话能在这里切分支", () => {
  it("目录会话：读得到分支", async () => {
    const { listSessionBranches } = await load()
    const r = await listSessionBranches(key(path.join(work, "repo")))
    expect(r).toMatchObject({ ok: true, current: "main" })
  })

  it("项目会话：分支由项目管，读和切都拒绝，git 不碰", async () => {
    const { listSessionBranches, switchSessionBranch } = await load()
    const k = "ch_app|app_main::project_abc123"
    const msg = { ok: false, error: "项目会话的分支由项目管理，不能在这里切换" }
    expect(await listSessionBranches(k)).toEqual(msg)
    expect(await switchSessionBranch(k, { name: "dev", kind: "local" })).toEqual(msg)
    expect(switchCalls).toEqual([])
  })

  it("不是应用内对话的会话（飞书等）：拒绝", async () => {
    const { listSessionBranches } = await load()
    expect(await listSessionBranches(`ch_feishu|oc_xxx::${path.join(work, "repo")}`)).toEqual({ ok: false, error: "不是应用内对话的会话" })
    expect(await listSessionBranches(`ch_gone|app_main::${path.join(work, "repo")}`)).toEqual({ ok: false, error: "不是应用内对话的会话" })
  })

  it("还没选工作目录的临时会话：拒绝，说清楚是没选目录", async () => {
    const { listSessionBranches } = await load()
    const temp = path.join(work, "workspaces", "temp_1700000000000")
    fs.mkdirSync(temp, { recursive: true })
    expect(await listSessionBranches(key(temp))).toEqual({ ok: false, error: "这个会话还没有选工作目录" })
  })

  it("临时会话选过目录后：用选的目录（不是临时目录）", async () => {
    const { listSessionBranches, store } = await load()
    const temp = path.join(work, "workspaces", "temp_1700000000000")
    fs.mkdirSync(temp, { recursive: true })
    store.patchSessionRecord(key(temp), { boundDir: path.join(work, "repo") })
    expect(await listSessionBranches(key(temp))).toMatchObject({ ok: true, current: "main" })
  })

  it("目录已经不存在：拒绝，点出路径", async () => {
    const { listSessionBranches } = await load()
    const gone = path.join(work, "deleted")
    expect(await listSessionBranches(key(gone))).toEqual({ ok: false, error: `目录不存在：${gone}` })
  })
})

describe("有会话在回复时不让切", () => {
  const repo = () => path.join(work, "repo")

  it("本会话在回复（worker 阶段 processing）：拒绝，且说是这个会话", async () => {
    const { listSessionBranches, switchSessionBranch } = await load()
    const k = key(repo())
    sessions = [{ sessionKey: k }]
    sdkPhase.set(k, "processing")
    const l = await listSessionBranches(k)
    expect(l.ok && l.blocked).toBe("这个会话正在回复，等它结束再切换分支")
    expect(await switchSessionBranch(k, { name: "dev", kind: "local" })).toEqual({ ok: false, error: "这个会话正在回复，等它结束再切换分支" })
    expect(switchCalls).toEqual([])
  })

  it("LLM 会话的 worker 阶段也认", async () => {
    const { switchSessionBranch } = await load()
    const k = key(repo())
    sessions = [{ sessionKey: k }]
    llmPhase.set(k, "processing")
    expect((await switchSessionBranch(k, { name: "dev", kind: "local" })).ok).toBe(false)
  })

  it("只有 processing 才算在回复：会话在线但在等消息（idle 等）不拦", async () => {
    const { switchSessionBranch } = await load()
    const k = key(repo())
    sessions = [{ sessionKey: k }, { sessionKey: key(path.join(repo(), "pkg")) }]
    sdkPhase.set(k, "idle")
    llmPhase.set(key(path.join(repo(), "pkg")), "polling")
    expect(await switchSessionBranch(k, { name: "dev", kind: "local" })).toEqual({ ok: true, current: "dev" })
    expect(switchCalls).toEqual([{ dir: repo(), name: "dev" }])
  })

  it("同一个仓库的子目录里别的会话在回复：也拦（它们共用一份工作区）", async () => {
    const { listSessionBranches } = await load()
    const sub = key(path.join(repo(), "pkg"))
    sessions = [{ sessionKey: sub }]
    sdkPhase.set(sub, "processing")
    const l = await listSessionBranches(key(repo()))
    expect(l.ok && l.blocked).toBe("有 1 个会话正在这个目录里工作，等它们结束再切换分支")
  })

  it("用户给会话选的目录（boundDir）是这个仓库：它在回复也拦，即使会话键里是别的目录", async () => {
    const { listSessionBranches, store } = await load()
    const temp = path.join(work, "workspaces", "temp_1700000000001")
    const k = key(temp)
    store.patchSessionRecord(k, { boundDir: repo() })
    sessions = [{ sessionKey: k }]
    sdkPhase.set(k, "processing")
    const l = await listSessionBranches(key(repo()))
    expect(l.ok && l.blocked).toBe("有 1 个会话正在这个目录里工作，等它们结束再切换分支")
  })

  it("别的仓库的会话、项目会话在回复：不拦", async () => {
    const { switchSessionBranch } = await load()
    const other = key(path.join(work, "other"))
    const project = "ch_app|app_main::project_abc123"
    sessions = [{ sessionKey: other }, { sessionKey: project, workspaceDir: repo() }]
    sdkPhase.set(other, "processing")
    sdkPhase.set(project, "processing")
    expect(await switchSessionBranch(key(repo()), { name: "dev", kind: "local" })).toEqual({ ok: true, current: "dev" })
  })
})

describe("切完之后", () => {
  it("通知所有订阅者（桌面窗口、手机流）并写日志；切到当前分支（没变）不通知；取消订阅后不再通知", async () => {
    const { switchSessionBranch, subscribeBranchChanged } = await load()
    const k = key(path.join(work, "repo"))
    const seen: number[] = []
    const off = subscribeBranchChanged(() => { seen.push(1) })
    subscribeBranchChanged(() => { throw new Error("某一端刷新失败") })
    const second: number[] = []
    subscribeBranchChanged(() => { second.push(1) })

    expect(await switchSessionBranch(k, { name: "dev", kind: "local" })).toEqual({ ok: true, current: "dev" })
    expect(seen).toHaveLength(1)
    expect(second).toHaveLength(1) // 前一个订阅者抛错不影响后一个
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("main → dev")
    expect(logs[0]).toContain(k)

    // git 返回还是 main：没切换，不通知
    gitState = { ...gitState, current: "main" }
    const noop = await switchSessionBranch(k, { name: "main", kind: "local" })
    expect(noop.ok).toBe(true)
    // mock 的 switchBranch 总是返回目标名，这里 current 是 main → 与读到的 main 相同，不算切换
    expect(seen).toHaveLength(1)

    off()
    await switchSessionBranch(k, { name: "dev", kind: "local" })
    expect(seen).toHaveLength(1)
    expect(second).toHaveLength(2)
  })
})
