import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 launchSdkAgent / executeSdkTurn + 假的 @cursor/sdk：
 * 会话存储换成 SdkAppendStore 之后，拉起路径上的几处接入要对：
 *  - Resume / Create 拿到的是会话自己的 SdkAppendStore（不是 SDK 自带的 JSONL，也不是 cwd 下的默认存储）
 *  - Resume 因「上下文已不存在」回退全新会话时，用镜像最近几轮续上（旧存储太大被丢弃就是这条路）
 *  - 残留 active run 的 listRuns / cancelRun 必须带 store，否则落到默认存储报 "Agent ... not found"，
 *    强制重发空转 30 秒（诊断包里 Mac 用户卡死的那段日志）
 */
const h = vi.hoisted(() => ({
  dir: "",
  resume: vi.fn(),
  create: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  startWorker: vi.fn(),
}))

vi.mock("electron", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-sdk-store-"))
  return {
    app: { getPath: () => h.dir, isPackaged: false, getAppPath: () => h.dir, getVersion: () => "0.0.0" },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  }
})
vi.mock("@cursor/sdk", () => ({
  Agent: { resume: h.resume, create: h.create, listRuns: h.listRuns, getRun: h.getRun, cancelRun: h.cancelRun },
  Cursor: { models: { list: vi.fn(async () => []) } },
  JsonlLocalAgentStore: class {},
}))
vi.mock("../electron/ui-logger", () => ({
  pushUiLog: vi.fn(),
  broadcastLog: vi.fn(),
  broadcastSessionStatus: vi.fn(),
}))
vi.mock("../electron/config-store", () => ({
  getAgentResource: vi.fn(() => ({})),
  resolveChannelForSession: vi.fn(() => undefined),
}))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: vi.fn(() => null),
  httpPost: vi.fn(async () => ({})),
  notifySessionLaunched: vi.fn(async () => undefined),
}))
vi.mock("../electron/prompt-assembler", () => ({
  resolveDaemonPortForPrompt: vi.fn(() => undefined),
}))
vi.mock("../electron/sdk-session-worker", () => ({
  startSdkWorkerLoop: h.startWorker,
  isSdkWorkerActive: vi.fn(() => false),
  stopSdkWorker: vi.fn(async () => undefined),
}))

import * as fs from "node:fs"
import * as path from "node:path"
import { executeSdkTurn, launchSdkAgent, sdkJsonlStoreDir, type SdkSessionAgent } from "../electron/agent-sdk"
import { LEGACY_MIGRATE_MAX_BYTES, SdkAppendStore } from "../electron/sdk-append-store"
import { SDK_STORE_READY_FILE, SDK_STORE_SUBDIR } from "../electron/sdk-store-layout"
import { appendMirrorTurns, initCarryoverStore } from "../electron/carryover"
import { initSessionModelStore } from "../src/shared/session-model-store"
import { patchSessionRecord } from "../src/shared/session-overrides-store"

let seq = 0
let sessionKey = ""
let workspaceDir = ""

function opts(extra: Record<string, unknown> = {}) {
  return {
    sessionKey,
    chatType: "p2p" as const,
    workspaceDir,
    apiKey: "key",
    model: "grok-4.7",
    senderOpenId: "ou_x",
    ...extra,
  }
}

const history = [
  { role: "user" as const, text: "上一轮的问题" },
  { role: "assistant" as const, text: "上一轮的回答" },
]

const fakeAgent = (id: string) => ({ agentId: id, close: vi.fn(), send: vi.fn() })

beforeEach(() => {
  delete process.env.APP_DATA_DIR
  process.env.CURSOR_RIPGREP_PATH = "stub"
  initSessionModelStore(h.dir)
  initCarryoverStore(h.dir)
  seq += 1
  sessionKey = `ch_s${seq}|oc_chat${seq}::${h.dir}`
  workspaceDir = h.dir
  for (const m of [h.resume, h.create, h.listRuns, h.getRun, h.cancelRun, h.startWorker]) m.mockReset()
  h.startWorker.mockImplementation(() => new Promise<void>(() => {}))
})

const seedResumable = () => patchSessionRecord(sessionKey, { agentId: "agent-old", workspaceDir })
const launchedHistory = (): unknown => (h.startWorker.mock.calls.at(-1)?.[1] as { historyTurns?: unknown } | undefined)?.historyTurns

describe("会话存储", () => {
  it("Create 与 Resume 拿到的都是会话自己的 SdkAppendStore，目录在会话的 sdk-jsonl 下", async () => {
    h.create.mockResolvedValue(fakeAgent("agent-new"))
    expect((await launchSdkAgent(opts())).ok).toBe(true)
    const created = h.create.mock.calls[0][0].local
    expect(created.store).toBeInstanceOf(SdkAppendStore)
    expect(created.cwd).toBe(workspaceDir)

    // 存储已就绪：新布局标记落在会话目录里
    const dir = sdkJsonlStoreDir(workspaceDir, sessionKey)
    expect(fs.existsSync(path.join(dir, SDK_STORE_SUBDIR, SDK_STORE_READY_FILE))).toBe(true)
  })

  it("Resume 用的存储与之后残留 run 恢复用的是同一个实例（同一会话只有一份缓存与队列）", async () => {
    seedResumable()
    const agent = fakeAgent("agent-old")
    h.resume.mockResolvedValue(agent)
    expect((await launchSdkAgent(opts())).ok).toBe(true)
    const resumeStore = h.resume.mock.calls[0][1].local.store
    expect(resumeStore).toBeInstanceOf(SdkAppendStore)

    const session = h.startWorker.mock.calls[0][0] as SdkSessionAgent
    agent.send.mockRejectedValueOnce(new Error("agent already has active run")).mockRejectedValueOnce(new Error("boom"))
    h.listRuns.mockResolvedValue({ items: [{ id: "run-live", status: "running" }] })
    h.getRun.mockRejectedValue(new Error("gone"))
    h.cancelRun.mockResolvedValue(undefined)
    await executeSdkTurn(session, "继续").catch(() => undefined)

    expect(h.listRuns).toHaveBeenCalledWith("agent-old", expect.objectContaining({ runtime: "local", cwd: workspaceDir, store: resumeStore }))
    expect(h.cancelRun).toHaveBeenCalledWith("run-live", expect.objectContaining({ runtime: "local", cwd: workspaceDir, store: resumeStore }))
  })
})

describe("Resume 回退全新会话时的历史", () => {
  it("服务端说 not found：冷启动带上镜像最近几轮，不是空白会话", async () => {
    seedResumable()
    appendMirrorTurns(sessionKey, history)
    h.resume.mockRejectedValue(new Error("Agent agent-old not found"))
    h.create.mockResolvedValue(fakeAgent("agent-new"))

    expect((await launchSdkAgent(opts())).ok).toBe(true)
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(launchedHistory()).toEqual(history)
  })

  it("Resume 成功：不带历史（上下文本来就在，重复灌入会让模型看到两遍）", async () => {
    seedResumable()
    appendMirrorTurns(sessionKey, history)
    h.resume.mockResolvedValue(fakeAgent("agent-old"))

    expect((await launchSdkAgent(opts())).ok).toBe(true)
    expect(h.create).not.toHaveBeenCalled()
    expect(launchedHistory()).toBeUndefined()
  })

  it("调度器已经带了历史（切供应商搬运）：以它为准，不被镜像覆盖", async () => {
    seedResumable()
    appendMirrorTurns(sessionKey, history)
    const carried = [{ role: "user" as const, text: "搬运来的" }]
    h.resume.mockRejectedValue(new Error("agent not found"))
    h.create.mockResolvedValue(fakeAgent("agent-new"))

    expect((await launchSdkAgent(opts({ historyTurns: carried }))).ok).toBe(true)
    expect(launchedHistory()).toEqual(carried)
  })

  it("没有可 Resume 的旧会话（首次对话）：不读镜像，不带历史", async () => {
    appendMirrorTurns(sessionKey, history)
    h.create.mockResolvedValue(fakeAgent("agent-new"))
    expect((await launchSdkAgent(opts())).ok).toBe(true)
    expect(h.resume).not.toHaveBeenCalled()
    expect(launchedHistory()).toBeUndefined()
  })

  it("没有镜像可用：照旧回退全新会话，不报错", async () => {
    seedResumable()
    h.resume.mockRejectedValue(new Error("agent not found"))
    h.create.mockResolvedValue(fakeAgent("agent-new"))
    expect((await launchSdkAgent(opts())).ok).toBe(true)
    expect(launchedHistory()).toBeUndefined()
  })
})

describe("旧版 SDK 存储（ndjson）", () => {
  it("超过迁移上限：拉起时就丢弃（不去读百 MB 的文件），随后按冷启动带镜像历史", async () => {
    seedResumable()
    appendMirrorTurns(sessionKey, history)
    const dir = sdkJsonlStoreDir(workspaceDir, sessionKey)
    fs.mkdirSync(dir, { recursive: true })
    const legacy = path.join(dir, "checkpoints.ndjson")
    const fd = fs.openSync(legacy, "w")
    fs.ftruncateSync(fd, LEGACY_MIGRATE_MAX_BYTES + 1)
    fs.closeSync(fd)
    // 存储里没有旧 agent 了，真实 SDK 的 Resume 会报 not found
    h.resume.mockRejectedValue(new Error("Agent agent-old not found"))
    h.create.mockResolvedValue(fakeAgent("agent-new"))

    expect((await launchSdkAgent(opts())).ok).toBe(true)
    expect(fs.existsSync(legacy)).toBe(false)
    expect(launchedHistory()).toEqual(history)
  })

  it("存储初始化失败：如实报错，不带着坏存储去拉起", async () => {
    // 会话存储目录的位置被一个同名文件占住，建不出子目录
    const dir = sdkJsonlStoreDir(workspaceDir, sessionKey)
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    fs.rmSync(dir, { recursive: true, force: true })
    fs.writeFileSync(dir, "occupied")
    const r = await launchSdkAgent(opts())
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/SDK 存储初始化失败/)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.resume).not.toHaveBeenCalled()
  })
})
