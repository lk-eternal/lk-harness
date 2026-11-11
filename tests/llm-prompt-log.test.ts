import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Pi 引擎的提示词日志：system prompt 全文 + 每回合交给 Pi 的 prompt 都要落日志。
 * 真实的 agent-llm（launchLlmAgent / executeLlmPiTurn / 事件处理），
 * 顶掉 electron、pi 会话创建、worker 循环、配置/网关这些外部依赖，用假的 Pi 会话驱动。
 */

let userData = ""
const logs: { level: string; content: string }[] = []
const order: string[] = []

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("../electron/ui-logger", () => ({
  pushUiLog: (_p: string, level: string, content: string) => { logs.push({ level, content }); order.push(`log:${content.split("\n")[0]}`) },
  broadcastLog: () => {},
  broadcastSessionStatus: () => {},
}))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: () => null,
  httpPost: async () => ({}),
  notifySessionLaunched: async () => {},
}))
vi.mock("../electron/agent-env", () => ({ syncMainProcessProxyEnv: () => {} }))
vi.mock("../electron/llm-proxy", () => ({ llmProxyConfigured: () => false, withLlmProxyOptions: (o: unknown) => o }))
vi.mock("../electron/config-store", async (orig) => ({
  ...(await orig<typeof import("../electron/config-store")>()),
  getChannel: () => undefined,
  resolveChannelForSession: () => undefined,
  resolveChannelModel: () => ({ model: "", modelParams: "" }),
  getConfig: () => ({ agentResources: [] }),
}))
vi.mock("../electron/llm-config", () => ({
  llmApiKey: () => "sk-test",
  llmProviderId: () => "fake",
  resolveLlmModel: () => fakeModel,
}))
vi.mock("../electron/llm-model-catalog", () => ({ lookupModelThinkingLevels: () => undefined }))
vi.mock("../electron/pi-resume-store", () => ({
  forgetPiResumable: () => {},
  getPiResumable: () => undefined,
  rememberPiResumable: () => {},
  patchPiResumableStreamCard: () => {},
}))
vi.mock("../electron/prompt-assembler", async (orig) => {
  const actual = await orig<typeof import("../electron/prompt-assembler")>()
  return {
    ...actual,
    computePromptHash: () => "rules-hash",
    resolveDaemonPortForPrompt: () => 9999,
  }
})
vi.mock("../electron/pi-embedded", () => ({
  createHarnessPiSession: async () => ({ session: nextPi, resumed: nextResumed }),
  hasPersistedPiSession: () => false,
  clearPiSession: () => {},
  readPiSessionTurns: () => [],
}))
vi.mock("../electron/llm-session-worker.js", () => ({
  startLlmWorkerLoop: (session: unknown) => { startedSessions.push(session); return Promise.resolve() },
  isLlmWorkerActive: () => false,
  stopLlmWorker: async () => {},
  stopAllLlmWorkers: async () => {},
  getLlmWorkerPhase: () => null,
}))

const fakeModel = { id: "fake-model", name: "Fake", api: "openai-completions", baseUrl: "http://gw", reasoning: false }
const startedSessions: unknown[] = []
let nextResumed = false

interface FakePi {
  systemPrompt: string
  messages: unknown[]
  state: { errorMessage?: string }
  agent: { waitForIdle: () => Promise<void> }
  prompt: (text: string) => Promise<void>
  subscribe: (fn: (event: unknown) => void) => () => void
  setModel: () => Promise<void>
  abort: () => Promise<void>
  dispose: () => void
  emit: (event: unknown) => void
  prompted: string[]
}

function makeFakePi(systemPrompt: string): FakePi {
  let listener: ((event: unknown) => void) | null = null
  const pi: FakePi = {
    systemPrompt,
    messages: [],
    state: {},
    agent: { waitForIdle: async () => {} },
    prompted: [],
    prompt: async (text: string) => { order.push("pi.prompt"); pi.prompted.push(text) },
    subscribe: (fn) => { listener = fn; return () => { listener = null } },
    setModel: async () => {},
    abort: async () => {},
    dispose: () => {},
    emit: (event) => listener?.(event),
  }
  return pi
}

let nextPi: FakePi

type AgentLlm = typeof import("../electron/agent-llm")
let llm: AgentLlm
let seq = 0

const resource = { id: "res1", type: "llm-custom", name: "gw", baseUrl: "http://gw" } as never

async function launch(systemPrompt: string, resumed = false) {
  nextPi = makeFakePi(systemPrompt)
  nextResumed = resumed
  const sessionKey = `ch_test${++seq}|oc_chat${seq}::D:\\work`
  const r = await llm.launchLlmAgent({
    sessionKey,
    chatType: "p2p",
    workspaceDir: "D:\\work",
    resource,
  } as never)
  expect(r).toEqual({ ok: true })
  const session = startedSessions[startedSessions.length - 1] as Parameters<AgentLlm["executeLlmPiTurn"]>[0]
  return { pi: nextPi, session, sessionKey }
}

const systemDumps = () => logs.filter((l) => /System Prompt:/.test(l.content))

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "llm-prompt-log-"))
  logs.length = 0
  order.length = 0
  startedSessions.length = 0
  vi.resetModules()
  llm = await import("../electron/agent-llm")
})

describe("Pi system prompt 日志", () => {
  it("冷启动：整段 system prompt 原样落日志，并带哈希与字数", async () => {
    const text = "# 协议\n你是 LK Harness 助手\n---\n## 数字身份\n小张"
    const { sessionKey } = await launch(text)
    const dumps = systemDumps()
    expect(dumps).toHaveLength(1)
    const c = dumps[0]!.content
    expect(c.startsWith(`[${sessionKey}] 启动 System Prompt: hash=`)).toBe(true)
    expect(c).toContain(`${text.length} chars`)
    // 头行之后就是全文，一字不差（含换行）
    expect(c.slice(c.indexOf("\n") + 1)).toBe(text)
  })

  it("恢复已有账本：标为「恢复」，同样打全文", async () => {
    const text = "恢复场景的 system prompt"
    await launch(text, true)
    const dumps = systemDumps()
    expect(dumps).toHaveLength(1)
    expect(dumps[0]!.content).toContain("恢复 System Prompt:")
    expect(dumps[0]!.content.endsWith(text)).toBe(true)
  })

  it("回合开始时 system prompt 没变：不重复打", async () => {
    const { pi } = await launch("不变的 system prompt")
    expect(systemDumps()).toHaveLength(1)
    pi.emit({ type: "agent_start" })
    pi.emit({ type: "agent_start" })
    expect(systemDumps()).toHaveLength(1)
  })

  it("回合开始时被扩展改写：打一份新的（标「变更」），同一份不再重复", async () => {
    const { pi } = await launch("旧版 system prompt")
    pi.systemPrompt = "新版 system prompt（扩展追加了一段）"
    pi.emit({ type: "agent_start" })
    pi.emit({ type: "agent_start" })
    const dumps = systemDumps()
    expect(dumps).toHaveLength(2)
    expect(dumps[1]!.content).toContain("变更 System Prompt:")
    expect(dumps[1]!.content.endsWith("新版 system prompt（扩展追加了一段）")).toBe(true)
    // 改回旧版也算变化
    pi.systemPrompt = "旧版 system prompt"
    pi.emit({ type: "agent_start" })
    expect(systemDumps()).toHaveLength(3)
  })

  it("各会话分开记：别的会话的哈希不影响本会话", async () => {
    const a = await launch("同一份 system prompt")
    const b = await launch("同一份 system prompt")
    expect(systemDumps()).toHaveLength(2)
    expect(a.sessionKey).not.toBe(b.sessionKey)
    expect(systemDumps().map((d) => d.content.split("]")[0])).toEqual([`[${a.sessionKey}`, `[${b.sessionKey}`])
  })
})

describe("Pi 回合 prompt 日志", () => {
  it("每回合把交给 Pi 的 prompt 原样打出来，且早于 Pi 实际收到它", async () => {
    const { pi, session, sessionKey } = await launch("sys")
    const prompt = "[本轮投递]\n```json\n{\n  \"messages\": [{ \"text\": \"你好\" }]\n}\n```"
    order.length = 0
    const r = await llm.executeLlmPiTurn(session, prompt)
    expect(r.ok).toBe(true)
    expect(pi.prompted).toEqual([prompt])

    const turn = logs.find((l) => l.content.includes("worker 回合 Prompt:"))
    expect(turn).toBeTruthy()
    expect(turn!.level).toBe("INFO")
    expect(turn!.content).toBe(`[${sessionKey}] worker 回合 Prompt:\n${prompt}`)
    expect(order.indexOf(`log:[${sessionKey}] worker 回合 Prompt:`)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(`log:[${sessionKey}] worker 回合 Prompt:`)).toBeLessThan(order.indexOf("pi.prompt"))
  })

  it("多回合各打各的", async () => {
    const { session } = await launch("sys")
    await llm.executeLlmPiTurn(session, "第一轮")
    await llm.executeLlmPiTurn(session, "第二轮")
    const turns = logs.filter((l) => l.content.includes("worker 回合 Prompt:")).map((l) => l.content.split("\n")[1])
    expect(turns).toEqual(["第一轮", "第二轮"])
  })

  it("回合失败也已经把 prompt 打出来了", async () => {
    const { pi, session } = await launch("sys")
    pi.prompt = async () => { order.push("pi.prompt"); throw new Error("网关 502") }
    const r = await llm.executeLlmPiTurn(session, "会失败的一轮")
    expect(r.ok).toBe(false)
    expect(logs.some((l) => l.content.includes("worker 回合 Prompt:\n会失败的一轮"))).toBe(true)
  })
})
