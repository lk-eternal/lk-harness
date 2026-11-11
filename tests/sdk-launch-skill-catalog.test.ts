import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 launchSdkAgent + 假的 @cursor/sdk + 空壳 worker：验证「这次拉起要不要给 AI 带 Skill 名单」。
 * 规则：新账本带一次；续跑的账本里 AI 手里已经是这一版就不带；名单变了补发；没有 Skill 不带。
 * 新账本 = 没有可续的 Agent（新会话、账本滚动、服务端找不到旧 Agent、newSession）。
 */
const h = vi.hoisted(() => ({
  dir: "",
  resume: vi.fn(),
  create: vi.fn(),
  startWorker: vi.fn(),
  catalog: { text: "", hash: "", count: 0 } as { text: string; hash: string; count: number },
}))

vi.mock("electron", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-sdk-skill-"))
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
vi.mock("../electron/skill-catalog", () => ({ getSkillCatalog: () => h.catalog }))

import { forgetResumable, launchSdkAgent, unregisterSdkSessionForWorker } from "../electron/agent-sdk"
import { initSessionModelStore } from "../src/shared/session-model-store"
import { getSessionRecord, patchSessionRecord } from "../src/shared/session-overrides-store"

const CATALOG = { text: "## 本机 Skill\n### /h/.cursor/skills\n- alpha：甲", hash: "hash-current", count: 1 }
const NOTICE = "（Skill 名单有变化"

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

/** 拉起后交给 worker 的东西：[会话, 选项] */
function workerCall(): [{ skillsHash?: string }, { skillCatalog?: { text: string; hash: string } }] {
  expect(h.startWorker).toHaveBeenCalledTimes(1)
  return h.startWorker.mock.calls[0] as never
}

/** 记着上一个可续接的 Agent（以及 AI 手里的名单版本），下一条消息会走 Resume */
function seedResumable(skillsHash?: string) {
  patchSessionRecord(sessionKey, { agentId: "agent-old", workspaceDir, ...(skillsHash ? { skillsHash } : {}) })
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
  h.catalog = { ...CATALOG }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("新账本：带名单（原文，不加「有变化」说明）", () => {
  it("全新会话", async () => {
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.create).toHaveBeenCalledTimes(1)
    const [session, o] = workerCall()
    expect(o.skillCatalog).toMatchObject({ text: CATALOG.text, hash: "hash-current" })
    expect(o.skillCatalog!.text).not.toContain(NOTICE)
    expect(session.skillsHash).toBeUndefined() // 还没交付，worker 第一轮成功后才记
  })

  it("记录里残留着旧指纹但没有可续的 Agent（账本滚动后的样子）：旧指纹不算数，照样带", async () => {
    // 账本滚动 / forget 之后：agentId 没了，指纹可能还在（旧版本留下的）
    patchSessionRecord(sessionKey, { skillsHash: "hash-current" })
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).not.toHaveBeenCalled()
    const [session, o] = workerCall()
    expect(o.skillCatalog?.text).toBe(CATALOG.text)
    expect(session.skillsHash).toBeUndefined()
  })

  it("newSession（用户要求全新会话）：不 Resume，旧指纹作废，名单照带，记录里的指纹也被清掉", async () => {
    seedResumable("hash-current")
    expect(await launchSdkAgent(opts({ newSession: true }))).toEqual({ ok: true })
    expect(h.resume).not.toHaveBeenCalled()
    const [session, o] = workerCall()
    expect(o.skillCatalog?.text).toBe(CATALOG.text)
    expect(session.skillsHash).toBeUndefined()
    expect(getSessionRecord(sessionKey)?.skillsHash).toBeUndefined()
    expect(getSessionRecord(sessionKey)?.agentId).toBe("agent-new") // 记录指向新建的 Agent，旧的已丢
  })

  it("服务端说旧 Agent 找不到（not found）而回退新建：这是新账本，名单要带，不能因为记录里的指纹相同就省掉", async () => {
    seedResumable("hash-current")
    h.resume.mockRejectedValue(new Error("agent not found"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.create).toHaveBeenCalledTimes(1)
    const [session, o] = workerCall()
    expect(session.skillsHash).toBeUndefined()
    expect(o.skillCatalog?.text).toBe(CATALOG.text)
  })
})

describe("续跑的账本：按指纹决定", () => {
  it("AI 手里已经是这一版：不带，会话沿用这个指纹", async () => {
    seedResumable("hash-current")
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).toHaveBeenCalledTimes(1)
    const [session, o] = workerCall()
    expect(o.skillCatalog).toBeUndefined()
    expect(session.skillsHash).toBe("hash-current")
  })

  it("名单变了（指纹不同）：补发最新的并说明以这份为准；交付前会话仍记着旧指纹", async () => {
    seedResumable("hash-old")
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [session, o] = workerCall()
    expect(o.skillCatalog?.hash).toBe("hash-current")
    expect(o.skillCatalog?.text.startsWith(NOTICE)).toBe(true)
    expect(o.skillCatalog?.text).toContain(CATALOG.text)
    expect(session.skillsHash).toBe("hash-old")
  })

  it("可续的 Agent 但从没成功交付过名单（没有指纹）：按「还没给过」带原文", async () => {
    seedResumable(undefined)
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [, o] = workerCall()
    expect(o.skillCatalog?.text).toBe(CATALOG.text)
    expect(o.skillCatalog!.text).not.toContain(NOTICE)
  })

})

/**
 * 完整一圈：拉起 → worker 交付名单 → 会话收口（真实的 unregisterSdkSessionForWorker 把续聊信息落盘）→ 再次拉起。
 * 会话还登记着的时候再拉起会直接返回（不会起新 worker），所以必须先走收口。
 */
describe("完整一圈：收口落盘后再次拉起", () => {
  type LiveSession = { skillsHash?: string; ledgerRollover?: boolean }

  async function firstLaunch(): Promise<{ session: LiveSession; sent: { text: string; hash: string } | undefined }> {
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [session, o] = workerCall()
    h.startWorker.mockClear()
    return { session: session as LiveSession, sent: o.skillCatalog }
  }

  async function close(session: LiveSession): Promise<void> {
    await unregisterSdkSessionForWorker(session as never, false)
  }

  it("名单交付成功后收口：下一次 Resume 不再带，指纹随续聊记录一起落盘", async () => {
    const { session, sent } = await firstLaunch()
    expect(sent?.text).toBe(CATALOG.text)
    session.skillsHash = sent!.hash // worker 第一轮成功后做的事
    await close(session)
    expect(getSessionRecord(sessionKey)).toMatchObject({ agentId: "agent-new", skillsHash: "hash-current" })

    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).toHaveBeenCalledTimes(1)
    const [second, o] = workerCall()
    expect(o.skillCatalog).toBeUndefined()
    expect(second.skillsHash).toBe("hash-current")
  })

  it("第一轮没交付成功（worker 没记指纹）就收口：下次 Resume 按「还没给过」重带原文", async () => {
    const { session } = await firstLaunch()
    expect(session.skillsHash).toBeUndefined()
    await close(session)
    expect(getSessionRecord(sessionKey)?.skillsHash).toBeUndefined()

    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [, o] = workerCall()
    expect(o.skillCatalog?.text).toBe(CATALOG.text)
    expect(o.skillCatalog!.text).not.toContain(NOTICE)
  })

  it("收口后名单变了：下次 Resume 补发新版并带说明", async () => {
    const { session, sent } = await firstLaunch()
    session.skillsHash = sent!.hash
    await close(session)

    h.catalog = { text: "## 本机 Skill\n- alpha：甲\n- beta：乙", hash: "hash-v2", count: 2 }
    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [, o] = workerCall()
    expect(o.skillCatalog?.hash).toBe("hash-v2")
    expect(o.skillCatalog?.text.startsWith(NOTICE)).toBe(true)
  })

  it("账本滚动（forgetResumable + ledgerRollover，和 rolloverSessionLedgerIfNeeded 做的一样）：下次是新账本，名单照带", async () => {
    // 先正常跑一圈：交付名单、收口，续聊记录里有了指纹（真实场景里每次空闲收口都会落盘）
    const { session: first, sent } = await firstLaunch()
    first.skillsHash = sent!.hash
    await close(first)
    expect(getSessionRecord(sessionKey)?.skillsHash).toBe("hash-current")

    // 再次 Resume（名单没变，不带），随后账本超限滚动
    h.resume.mockResolvedValue(fakeAgent("agent-new"))
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [session, resumedOpts] = workerCall()
    h.startWorker.mockClear()
    expect(resumedOpts.skillCatalog).toBeUndefined()

    // 账本超限：丢掉续聊信息（连同指纹），worker 退出时不再写回
    forgetResumable(sessionKey)
    ;(session as LiveSession).ledgerRollover = true
    await close(session as LiveSession)
    expect(getSessionRecord(sessionKey)?.agentId).toBeUndefined()
    expect(getSessionRecord(sessionKey)?.skillsHash).toBeUndefined()

    h.create.mockReset()
    h.create.mockResolvedValue(fakeAgent("agent-rolled"))
    h.resume.mockClear()
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(h.resume).not.toHaveBeenCalled()
    const [fresh, o] = workerCall()
    expect(fresh.skillsHash).toBeUndefined()
    expect(o.skillCatalog?.text).toBe(CATALOG.text)
    expect(o.skillCatalog!.text).not.toContain(NOTICE)
  })
})

describe("本机没有可列的 Skill", () => {
  it("新会话、续跑都不带，也不会拿空名单去覆盖指纹", async () => {
    h.catalog = { text: "", hash: "", count: 0 }
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    expect(workerCall()[1].skillCatalog).toBeUndefined()
  })

  it("续跑且 AI 手里有旧名单、现在一个 Skill 都没了：不带（不发空名单），沿用旧指纹", async () => {
    h.catalog = { text: "", hash: "", count: 0 }
    seedResumable("hash-old")
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const [session, o] = workerCall()
    expect(o.skillCatalog).toBeUndefined()
    expect(session.skillsHash).toBe("hash-old")
  })
})
