import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 launchSdkAgent + 假的 @cursor/sdk + 空壳 worker：验证拉起时会话上记的「AI 手里的宿主提示词版本」（protocolHash）。
 * 续上的账本沿用记录里的指纹，worker 据此决定每一轮给不给；新账本没有指纹，第一轮一定给。
 * 新账本 = 没有可续的 Agent（新会话、账本滚动、服务端找不到旧 Agent、newSession）。
 */
const h = vi.hoisted(() => ({
  dir: "",
  resume: vi.fn(),
  create: vi.fn(),
  startWorker: vi.fn(),
}))

vi.mock("electron", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-sdk-host-"))
  return {
    app: { getPath: () => h.dir, isPackaged: false, getAppPath: () => h.dir, getVersion: () => "0.0.0" },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  }
})
vi.mock("@cursor/sdk", () => ({
  Agent: { resume: h.resume, create: h.create, listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() },
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
  computePromptHash: vi.fn(() => "hash"),
  resolveDaemonPortForPrompt: vi.fn(() => undefined),
}))
vi.mock("../electron/sdk-session-worker", () => ({
  startSdkWorkerLoop: h.startWorker,
  isSdkWorkerActive: vi.fn(() => false),
  stopSdkWorker: vi.fn(async () => undefined),
}))

import { forgetResumable, launchSdkAgent, unregisterSdkSessionForWorker } from "../electron/agent-sdk"
import { initSessionModelStore } from "../src/shared/session-model-store"
import { getSessionRecord, patchSessionRecord } from "../src/shared/session-overrides-store"

let seq = 0
let sessionKey = ""
let workspaceDir = ""

const fakeAgent = (id = "agent-new") => ({ agentId: id, close: vi.fn() })

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

type LiveSession = { protocolHash?: string; ledgerRollover?: boolean }

/** 拉起后交给 worker 的会话 */
function workerSession(): LiveSession {
  expect(h.startWorker).toHaveBeenCalledTimes(1)
  return h.startWorker.mock.calls[0][0] as LiveSession
}

/** 记着上一个可续接的 Agent（以及 AI 手里的宿主提示词版本），下一条消息会走 Resume */
function seedResumable(protocolHash?: string) {
  patchSessionRecord(sessionKey, { agentId: "agent-old", workspaceDir, ...(protocolHash ? { protocolHash } : {}) })
}

async function close(session: LiveSession): Promise<void> {
  await unregisterSdkSessionForWorker(session as never, false)
}

beforeEach(() => {
  process.env.CURSOR_RIPGREP_PATH = "stub"
  initSessionModelStore(h.dir)
  seq += 1
  sessionKey = `ch_s${seq}|oc_chat${seq}::${h.dir}`
  workspaceDir = h.dir
  h.resume.mockReset()
  h.create.mockReset()
  h.startWorker.mockReset()
  h.startWorker.mockImplementation(() => new Promise<void>(() => {}))
  h.resume.mockResolvedValue(fakeAgent("agent-old"))
  h.create.mockResolvedValue(fakeAgent("agent-new"))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("新账本：会话上没有指纹（第一轮一定给宿主提示词）", () => {
  it("全新会话", async () => {
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(workerSession().protocolHash).toBeUndefined()
  })

  it("记录里残留着旧指纹但没有可续的 Agent（账本滚动后的样子）：旧指纹不算数", async () => {
    patchSessionRecord(sessionKey, { protocolHash: "hash-current" })
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).not.toHaveBeenCalled()
    expect(workerSession().protocolHash).toBeUndefined()
  })

  it("newSession（用户要求全新会话）：不 Resume，旧指纹作废，记录里的指纹也被清掉", async () => {
    seedResumable("hash-current")
    expect(await launchSdkAgent(opts({ newSession: true }))).toEqual({ ok: true })
    expect(h.resume).not.toHaveBeenCalled()
    expect(workerSession().protocolHash).toBeUndefined()
    expect(getSessionRecord(sessionKey)?.protocolHash).toBeUndefined()
    expect(getSessionRecord(sessionKey)?.agentId).toBe("agent-new") // 记录指向新建的 Agent，旧的已丢
  })

  it("服务端说旧 Agent 找不到（not found）而回退新建：这是新账本，不能沿用记录里的指纹", async () => {
    seedResumable("hash-current")
    h.resume.mockRejectedValue(new Error("agent not found"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(workerSession().protocolHash).toBeUndefined()
  })
})

describe("续跑的账本：沿用记录里的指纹", () => {
  it("记录里有指纹：会话带着它，worker 据此比较现在的宿主提示词", async () => {
    seedResumable("hash-current")
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(workerSession().protocolHash).toBe("hash-current")
  })

  it("可续的 Agent 但从没成功交付过（没有指纹）：按「还没给过」处理", async () => {
    seedResumable(undefined)
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(workerSession().protocolHash).toBeUndefined()
  })
})

/**
 * 完整一圈：拉起 → worker 交付 → 会话收口（真实的 unregisterSdkSessionForWorker 把续聊信息落盘）→ 再次拉起。
 * 会话还登记着的时候再拉起会直接返回（不会起新 worker），所以必须先走收口。
 */
describe("完整一圈：收口落盘后再次拉起", () => {
  async function firstLaunch(): Promise<LiveSession> {
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const session = workerSession()
    h.startWorker.mockClear()
    return session
  }

  it("交付成功后收口：指纹随续聊记录一起落盘，下一次 Resume 沿用", async () => {
    const session = await firstLaunch()
    session.protocolHash = "hash-current" // worker 第一轮成功后做的事
    await close(session)
    expect(getSessionRecord(sessionKey)).toMatchObject({ agentId: "agent-new", protocolHash: "hash-current" })

    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(workerSession().protocolHash).toBe("hash-current")
  })

  it("第一轮没交付成功（worker 没记指纹）就收口：记录里没有指纹，下次 Resume 按「还没给过」处理", async () => {
    const session = await firstLaunch()
    expect(session.protocolHash).toBeUndefined()
    await close(session)
    expect(getSessionRecord(sessionKey)?.protocolHash).toBeUndefined()

    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(workerSession().protocolHash).toBeUndefined()
  })

  it("账本滚动（forgetResumable + ledgerRollover，和 rolloverSessionLedgerIfNeeded 做的一样）：下次是新账本，指纹作废", async () => {
    // 先正常跑一圈：交付、收口，续聊记录里有了指纹（真实场景里每次空闲收口都会落盘）
    const first = await firstLaunch()
    first.protocolHash = "hash-current"
    await close(first)
    expect(getSessionRecord(sessionKey)?.protocolHash).toBe("hash-current")

    // 再次 Resume，随后账本超限滚动
    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const resumed = workerSession()
    h.startWorker.mockClear()
    expect(resumed.protocolHash).toBe("hash-current")

    // 账本超限：丢掉续聊信息（连同指纹），worker 退出时不再写回
    forgetResumable(sessionKey)
    resumed.ledgerRollover = true
    await close(resumed)
    expect(getSessionRecord(sessionKey)?.agentId).toBeUndefined()
    expect(getSessionRecord(sessionKey)?.protocolHash).toBeUndefined()

    h.create.mockReset()
    h.create.mockResolvedValue(fakeAgent("agent-rolled"))
    h.resume.mockClear()
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).not.toHaveBeenCalled()
    expect(workerSession().protocolHash).toBeUndefined()
  })
})
