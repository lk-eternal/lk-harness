import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 launchSdkAgent + 假的 @cursor/sdk + 空壳 worker：验证访客档真的传给了 SDK。
 * 访客会话：Agent.create / Agent.resume 都带 tools 白名单（SDK 的 tools 不随 Agent 持久化，续聊也要再传）、
 * 内置 MCP 走 /mcp-visitor、用户 MCP 只挂点名的、Skill 名单只列点名的；主人 / 同我档的会话一个限制都不加。
 */
const h = vi.hoisted(() => ({
  dir: "",
  resume: vi.fn(),
  create: vi.fn(),
  startWorker: vi.fn(),
  skillCalls: [] as unknown[][],
}))

vi.mock("electron", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-sdk-visitor-"))
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
  readLockFile: vi.fn(() => ({ port: 4321 })),
  httpPost: vi.fn(async () => ({})),
  notifySessionLaunched: vi.fn(async () => undefined),
}))
vi.mock("../electron/prompt-assembler", () => ({
  computePromptHash: vi.fn((ctx: { visitor?: unknown }) => (ctx.visitor ? "hash-visitor" : "hash-plain")),
  resolveDaemonPortForPrompt: vi.fn(() => 4321),
}))
vi.mock("../electron/sdk-session-worker", () => ({
  startSdkWorkerLoop: h.startWorker,
  isSdkWorkerActive: vi.fn(() => false),
  stopSdkWorker: vi.fn(async () => undefined),
}))
vi.mock("../electron/skill-catalog", () => ({
  getSkillCatalog: (...args: unknown[]) => {
    h.skillCalls.push(args)
    return { text: "", hash: "", count: 0 }
  },
}))

import { launchSdkAgent } from "../electron/agent-sdk"
import { initSessionModelStore } from "../src/shared/session-model-store"
import { patchSessionRecord } from "../src/shared/session-overrides-store"
import { initHarnessMcpStore, saveHarnessMcpServer, CLAW_MCP_KEY } from "../src/shared/harness-mcp-store"
import { resolveVisitorLimits, VISITOR_SDK_BASE_TOOLS } from "../src/shared/visitor-limits"

let seq = 0
let sessionKey = ""

const fakeAgent = (id = "agent-new") => ({ agentId: id, close: vi.fn() })

function opts(extra: Record<string, unknown> = {}) {
  return {
    sessionKey,
    chatType: "p2p" as const,
    workspaceDir: h.dir,
    apiKey: "key",
    model: "grok-4.7",
    senderOpenId: "ou_x",
    ...extra,
  }
}

/** 传给 Agent.create / Agent.resume 的选项 */
function createOpts(): { tools?: string[]; mcpServers: Record<string, { url?: string }> } {
  expect(h.create).toHaveBeenCalledTimes(1)
  return h.create.mock.calls[0]![0] as never
}

beforeEach(() => {
  process.env.CURSOR_RIPGREP_PATH = "stub"
  initSessionModelStore(h.dir)
  initHarnessMcpStore(h.dir)
  saveHarnessMcpServer("notion", { url: "http://notion.example/mcp" })
  saveHarnessMcpServer("db", { url: "http://db.example/mcp" })
  seq += 1
  sessionKey = `ch_v${seq}|oc_chat${seq}::${h.dir}`
  h.resume.mockReset()
  h.create.mockReset()
  h.startWorker.mockReset()
  h.startWorker.mockImplementation(() => new Promise<void>(() => {}))
  h.resume.mockResolvedValue(fakeAgent("agent-old"))
  h.create.mockResolvedValue(fakeAgent("agent-new"))
  h.skillCalls.length = 0
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("不受限的会话：和以前一样，一个限制都不加", () => {
  it("没有 visitor：不传 tools；内置 MCP 走 /mcp-interactive；用户 MCP 全挂；Skill 名单不过滤", async () => {
    expect(await launchSdkAgent(opts())).toEqual({ ok: true })
    const o = createOpts()
    expect("tools" in o).toBe(false)
    expect(o.mcpServers[CLAW_MCP_KEY]!.url).toBe("http://127.0.0.1:4321/mcp-interactive")
    expect(Object.keys(o.mcpServers).sort()).toEqual([CLAW_MCP_KEY, "db", "notion"].sort())
    expect(h.skillCalls[0]![1]).toBeUndefined()
  })
})

describe("访客会话", () => {
  it("Agent.create：tools 白名单 + 访客专用内置 MCP + 不挂用户 MCP + Skill 名单按空白名单取", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor" }, "others")!
    expect(await launchSdkAgent(opts({ visitor }))).toEqual({ ok: true })
    const o = createOpts()
    expect(o.tools).toEqual([...VISITOR_SDK_BASE_TOOLS])
    expect(o.tools).not.toContain("shell")
    expect(o.tools).not.toContain("read")
    expect(o.mcpServers[CLAW_MCP_KEY]!.url).toBe("http://127.0.0.1:4321/mcp-visitor")
    expect(Object.keys(o.mcpServers)).toEqual([CLAW_MCP_KEY])
    expect(h.skillCalls[0]![1]).toEqual([])
  })

  it("Agent.resume（续聊）也带同一份 tools 和 MCP：SDK 不持久化 tools，漏了就等于续聊时解除限制", async () => {
    patchSessionRecord(sessionKey, { agentId: "agent-old", workspaceDir: h.dir })
    const visitor = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["notion"] }, "others")!
    expect(await launchSdkAgent(opts({ visitor }))).toEqual({ ok: true })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.resume).toHaveBeenCalledTimes(1)
    const [agentId, ro] = h.resume.mock.calls[0]! as [string, { tools?: string[]; mcpServers: Record<string, unknown> }]
    expect(agentId).toBe("agent-old")
    expect(ro.tools).toEqual([...VISITOR_SDK_BASE_TOOLS])
    expect(Object.keys(ro.mcpServers).sort()).toEqual([CLAW_MCP_KEY, "notion"].sort())
  })

  it("额外开放：点名的用户 MCP 才挂；开放了 Skill 就多给 read，名单只列点名的", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor", visitorMcp: ["db"], visitorSkills: ["weekly-report"] }, "others")!
    expect(await launchSdkAgent(opts({ visitor }))).toEqual({ ok: true })
    const o = createOpts()
    expect(Object.keys(o.mcpServers).sort()).toEqual([CLAW_MCP_KEY, "db"].sort())
    expect(o.tools).toContain("read")
    expect(o.tools).not.toContain("shell")
    expect(h.skillCalls[0]![1]).toEqual(["weekly-report"])
  })

  it("交给 worker 的提示词上下文带着 visitor（提示词里要告诉 AI 它是访客）", async () => {
    const visitor = resolveVisitorLimits({ visitorTier: "visitor" }, "others")!
    expect(await launchSdkAgent(opts({ visitor }))).toEqual({ ok: true })
    const [session, o] = h.startWorker.mock.calls[0]! as [{ visitor?: unknown }, { promptCtx: { visitor?: unknown } }]
    expect(o.promptCtx.visitor).toBe(visitor)
    expect(session.visitor).toBe(visitor)
  })
})
