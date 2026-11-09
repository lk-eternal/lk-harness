import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 executeSdkTurn / 流式卡 + 假的 @cursor/sdk 与假的 daemon：
 * 「立即发送」软打断一轮时，被取消的那张流式卡必须封成「已打断」并让下一轮开新卡；
 * 而 /stop、断线等其它取消路径照旧把卡挂起以便续写（不能被这次改动带歪）。
 */
const h = vi.hoisted(() => ({
  dir: "",
  create: vi.fn(),
  startWorker: vi.fn(),
  posts: [] as Array<Record<string, unknown>>,
  cardSeq: 0,
}))

vi.mock("electron", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-sdk-turn-"))
  return {
    app: { getPath: () => h.dir, isPackaged: false, getAppPath: () => h.dir, getVersion: () => "0.0.0" },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
  }
})
vi.mock("@cursor/sdk", () => ({
  Agent: { resume: vi.fn(), create: h.create, listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() },
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
  // 应用内会话：带流式卡，显示思考/工具（否则工具段不进卡）
  resolveChannelForSession: vi.fn(() => ({ type: "app", showThinking: true, showThinkingOthers: true })),
}))
vi.mock("../electron/daemon-client", () => ({
  readLockFile: vi.fn(() => ({ port: 4321 })),
  // 流式卡的所有请求都打到这里：ensure 发新卡号，其余原样记录
  httpPost: vi.fn(async (url: string, body: Record<string, unknown>) => {
    if (!String(url).endsWith("/api/agent-stream-card")) return {}
    h.posts.push(body)
    if (body.action === "ensure") return { ok: true, cardId: `card-${++h.cardSeq}` }
    return { ok: true }
  }),
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

import { executeSdkTurn, finishInterruptedTurn, launchSdkAgent, type SdkSessionAgent } from "../electron/agent-sdk"
import { initSessionModelStore } from "../src/shared/session-model-store"

/** 一轮 run：事件由测试按需推入，status 由测试在结束时给 */
function fakeRun() {
  const queue: unknown[] = []
  let ended = false
  let wake: (() => void) | null = null
  const run = {
    status: "running" as string,
    durationMs: 12,
    result: "",
    cancel: vi.fn(async () => undefined),
    wait: vi.fn(async () => ({})),
    stream: async function* () {
      for (;;) {
        if (queue.length > 0) { yield queue.shift(); continue }
        if (ended) return
        await new Promise<void>((r) => { wake = r })
      }
    },
  }
  return {
    run,
    push(event: unknown) { queue.push(event); wake?.() },
    end(status: string) { run.status = status; ended = true; wake?.() },
  }
}

const toolRunning = { type: "tool_call", name: "shell", status: "running", args: { command: "npm test" } }
const status = (s: string) => ({ type: "status", status: s })
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } })

let seq = 0
let session: SdkSessionAgent
let agent: { agentId: string; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }

const postsOf = (action: string) => h.posts.filter((p) => p.action === action)

beforeEach(async () => {
  process.env.CURSOR_RIPGREP_PATH = "stub"
  initSessionModelStore(h.dir)
  h.posts.length = 0
  h.cardSeq = 0
  h.create.mockReset()
  h.startWorker.mockReset()
  h.startWorker.mockImplementation(() => new Promise<void>(() => {}))
  agent = { agentId: "agent-t", close: vi.fn(), send: vi.fn() }
  h.create.mockResolvedValue(agent)

  seq += 1
  const r = await launchSdkAgent({
    sessionKey: `app_t${seq}|chat${seq}::${h.dir}`,
    chatType: "p2p",
    workspaceDir: h.dir,
    apiKey: "key",
    model: "grok-4.7",
    senderOpenId: "ou_x",
  })
  expect(r.ok).toBe(true)
  session = h.startWorker.mock.calls[0][0] as SdkSessionAgent
})

/** 起一轮：推一个工具调用让卡立刻建出来（ensure），返回这一轮的操控柄 */
async function startTurnWithCard() {
  const fr = fakeRun()
  agent.send.mockResolvedValueOnce(fr.run)
  const turn = executeSdkTurn(session, "做点什么")
  await vi.waitFor(() => expect(agent.send).toHaveBeenCalled())
  fr.push(toolRunning)
  await vi.waitFor(() => expect(postsOf("ensure")).toHaveLength(1))
  await vi.waitFor(() => expect(session.streamAgg?.cardId).toBeTruthy())
  return { fr, turn }
}

describe("软打断：被取消的那张卡封成「已打断」，下一轮开新卡", () => {
  it("取消引发的 CANCELLED 不再挂起卡、不再刷帧；紧接着封口时发 finish(interrupted)，下一轮是全新的卡", async () => {
    const { fr, turn } = await startTurnWithCard()
    const cardId = session.streamAgg!.cardId
    const before = h.posts.length

    session.interruptRequested = true // interruptSdkWorkerTurn 做的事
    fr.push(status("CANCELLED"))
    fr.end("cancelled")
    const r = await turn

    expect(r.ok).toBe(true) // 取消不是失败
    expect(h.posts.length).toBe(before) // 回合收口时没有再发任何卡请求（尤其没有「挂起」那一帧）
    expect(session.streamAgg?.suspended).toBeFalsy()
    expect(session.streamAgg?.finished).toBeFalsy()

    await finishInterruptedTurn(session)
    const fin = postsOf("finish")
    expect(fin).toHaveLength(1)
    expect(fin[0]).toMatchObject({ card_id: cardId, interrupted: true })
    expect(session.streamAgg).toBeNull()

    // 下一轮：新卡（ensure 不带旧卡号），正常收口，不带 interrupted
    const next = fakeRun()
    agent.send.mockResolvedValueOnce(next.run)
    const turn2 = executeSdkTurn(session, "排队的那条")
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledTimes(2))
    next.push(text("好的，按新的来"))
    next.push(status("FINISHED"))
    next.end("finished")
    expect((await turn2).ok).toBe(true)

    // 回合返回时卡的请求都已发完（收尾会等 inflight）。FINISHED 事件和收尾各 finish 一次是原有行为（daemon 幂等），不数次数
    const ensures = postsOf("ensure")
    expect(ensures).toHaveLength(2)
    expect(ensures[1].card_id).toBeUndefined() // 新卡：ensure 不带旧卡号
    const finishes = postsOf("finish")
    expect(finishes[0]).toMatchObject({ card_id: cardId, interrupted: true })
    const afterwards = finishes.slice(1)
    expect(afterwards.length).toBeGreaterThanOrEqual(1)
    for (const f of afterwards) {
      expect(f.card_id).toBe("card-2") // 新一轮收口的是新卡
      expect(f.interrupted).toBeUndefined() // 正常结束，不带「已打断」
    }
  })

  it("对照：没有打断标记时，CANCELLED 照旧把卡挂起（/stop、断线续写的行为不变），不会 finish", async () => {
    const { fr, turn } = await startTurnWithCard()
    fr.push(status("CANCELLED"))
    fr.end("cancelled")
    await turn

    expect(session.streamAgg?.suspended).toBe(true)
    expect(session.streamAgg?.finished).toBeFalsy()
    expect(postsOf("finish")).toHaveLength(0)
    await finishInterruptedTurn(session) // 没人调它：这里只确认挂起态不会被误当成已结束
  })

  it("取消没赶上、回合其实自然结束了：卡正常 finish 一次，finishInterruptedTurn 不会再补一个「已打断」", async () => {
    const { fr, turn } = await startTurnWithCard()
    session.interruptRequested = true
    fr.push(text("已经做完了"))
    fr.push(status("FINISHED"))
    fr.end("finished")
    await turn
    const finished = postsOf("finish").length
    expect(finished).toBeGreaterThanOrEqual(1)

    await finishInterruptedTurn(session)
    expect(postsOf("finish")).toHaveLength(finished) // 卡已经正常收口：不会再补一个
    expect(postsOf("finish").every((f) => f.interrupted === undefined)).toBe(true)
    expect(session.streamAgg).toBeNull()
  })

  it("还没有建出卡的回合被打断：不发任何卡请求，也不留脏状态", async () => {
    const fr = fakeRun()
    agent.send.mockResolvedValueOnce(fr.run)
    const turn = executeSdkTurn(session, "做点什么")
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled())
    session.interruptRequested = true
    fr.push(status("CANCELLED"))
    fr.end("cancelled")
    await turn

    await finishInterruptedTurn(session)
    expect(h.posts).toHaveLength(0)
    expect(session.streamAgg).toBeNull()
  })
})

describe("send 还没返回 run 时被打断", () => {
  it("send 返回后补一刀 cancel（那时 session.run 还没登记，软打断的 cancel 没有对象）", async () => {
    const fr = fakeRun()
    let release!: (r: unknown) => void
    agent.send.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const turn = executeSdkTurn(session, "做点什么")
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled())

    session.interruptRequested = true
    expect(session.run).toBeNull()
    release(fr.run)
    await vi.waitFor(() => expect(fr.run.cancel).toHaveBeenCalledTimes(1))

    fr.push(status("CANCELLED"))
    fr.end("cancelled")
    expect((await turn).ok).toBe(true)
  })

  it("没有打断标记时 send 返回后不会多 cancel", async () => {
    const fr = fakeRun()
    agent.send.mockResolvedValueOnce(fr.run)
    const turn = executeSdkTurn(session, "做点什么")
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalled())
    fr.push(text("嗯"))
    fr.push(status("FINISHED"))
    fr.end("finished")
    await turn
    expect(fr.run.cancel).not.toHaveBeenCalled()
  })
})
