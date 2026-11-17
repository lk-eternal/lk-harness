import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 真实的 executeSdkTurn / 流式卡 + 假的 @cursor/sdk 与假的 daemon：
 * 「立即发送」软打断一轮时，被取消的那张流式卡必须封成「已打断」并让下一轮开新卡；
 * 而 /stop、断线等其它取消路径照旧把卡挂起以便续写（不能被这次改动带歪）。
 */
const h = vi.hoisted(() => ({
  dir: "",
  create: vi.fn(),
  resume: vi.fn(),
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

import {
  executeSdkTurn,
  finishInterruptedTurn,
  launchSdkAgent,
  resolveRememberedStreamCardId,
  unregisterSdkSessionForWorker,
  type SdkSessionAgent,
} from "../electron/agent-sdk"
import { initSessionModelStore } from "../src/shared/session-model-store"
import { getSessionRecord } from "../src/shared/session-overrides-store"

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
  h.resume.mockReset()
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

    // 回合返回时卡的请求都已发完（收尾会等 inflight）。FINISHED 事件和回合收尾各调一次 finish，但新卡只发一次
    const ensures = postsOf("ensure")
    expect(ensures).toHaveLength(2)
    expect(ensures[1].card_id).toBeUndefined() // 新卡：ensure 不带旧卡号
    const finishes = postsOf("finish")
    expect(finishes[0]).toMatchObject({ card_id: cardId, interrupted: true })
    const afterwards = finishes.slice(1)
    expect(afterwards).toHaveLength(1)
    expect(afterwards[0].card_id).toBe("card-2") // 新一轮收口的是新卡
    expect(afterwards[0].interrupted).toBeUndefined() // 正常结束，不带「已打断」
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

/**
 * 卡片收口后，会话记录里不能还留着它的 cardId。
 * 记录里的 cardId 是给「进程重启时卡停在流式状态」用的：Resume 会按它再收口一次。
 * 回合末尾记续聊信息时若把已结束 agg 的 cardId 又写回去，每次 Resume 都会对一张早已结束的卡再 PATCH 一遍，
 * 飞书会把这次更新当成新的 @ 事件重推给卡里被 @ 的机器人（两个机器人互相触发的根因）。
 */
describe("记录里该留哪张卡 resolveRememberedStreamCardId", () => {
  it("没有 agg、或 agg 还没建出卡：记录保持原样", () => {
    expect(resolveRememberedStreamCardId(null, "old")).toBe("old")
    expect(resolveRememberedStreamCardId(undefined, undefined)).toBeUndefined()
    expect(resolveRememberedStreamCardId({ finished: false }, "old")).toBe("old")
  })

  it("卡还没收口（进行中或挂起待续写）：记 agg 当前这张", () => {
    expect(resolveRememberedStreamCardId({ cardId: "c2", finished: false }, undefined)).toBe("c2")
    expect(resolveRememberedStreamCardId({ cardId: "c2", finished: false }, "c1")).toBe("c2")
  })

  it("卡已收口：不再记它；记录里存的恰是它就清掉", () => {
    expect(resolveRememberedStreamCardId({ cardId: "c1", finished: true }, "c1")).toBeUndefined()
    expect(resolveRememberedStreamCardId({ cardId: "c1", finished: true }, undefined)).toBeUndefined()
  })

  it("卡已收口但记录里存的是另一张卡：不动那一张（清除要对得上期望的卡号）", () => {
    expect(resolveRememberedStreamCardId({ cardId: "c1", finished: true }, "c2")).toBe("c2")
  })
})

describe("卡片收口后不再留 cardId 给 Resume", () => {
  const recordedCard = () => getSessionRecord(session.sessionKey)?.streamCardId

  /** 一整轮：建卡、出正文、FINISHED，等回合收尾返回 */
  async function finishedTurn() {
    const { fr, turn } = await startTurnWithCard()
    const cardId = session.streamAgg!.cardId!
    expect(recordedCard()).toBe(cardId) // 进行中的卡要记着，进程挂了 Resume 才收得了口
    fr.push(text("做完了"))
    fr.push(status("FINISHED"))
    fr.end("finished")
    expect((await turn).ok).toBe(true)
    return cardId
  }

  it("一轮正常结束：对这张卡只发一次 finish（状态事件和回合收尾不各发一次）", async () => {
    const cardId = await finishedTurn()
    const finishes = postsOf("finish")
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ card_id: cardId })
  })

  it("一轮正常结束：会话记录里不留这张已收口的卡号", async () => {
    await finishedTurn()
    expect(recordedCard()).toBeUndefined()
  })

  it("对照：卡被挂起（CANCELLED 且不是软打断）时，卡号照旧留在记录里供 Resume 接续", async () => {
    const { fr, turn } = await startTurnWithCard()
    const cardId = session.streamAgg!.cardId!
    fr.push(status("CANCELLED"))
    fr.end("cancelled")
    await turn
    expect(session.streamAgg?.suspended).toBe(true)
    expect(recordedCard()).toBe(cardId)
  })

  const relaunchOpts = () => ({
    sessionKey: session.sessionKey,
    chatType: "p2p" as const,
    workspaceDir: h.dir,
    apiKey: "key",
    model: "grok-4.7",
    senderOpenId: "ou_x",
  })

  it("正常结束、worker 收尾后重新拉起（Resume）：不会再对那张旧卡发 finish", async () => {
    const cardId = await finishedTurn()
    // 真实流程里 Resume 之前一定走过 worker 收尾；内存里还留着旧实例的话 launch 会直接当作已在运行
    await unregisterSdkSessionForWorker(session, false)
    h.resume.mockResolvedValue(agent)
    const before = h.posts.length

    const r = await launchSdkAgent(relaunchOpts())

    expect(r.ok).toBe(true)
    expect(h.resume).toHaveBeenCalledTimes(1) // 真的走了 Resume，不是全新拉起
    expect(h.posts.slice(before).filter((p) => p.card_id === cardId)).toEqual([])
  })

  it("进程重启时卡还挂着没收口：Resume 照旧把那张卡收掉，并清掉记录", async () => {
    const { fr, turn } = await startTurnWithCard()
    const cardId = session.streamAgg!.cardId!
    fr.push(status("CANCELLED"))
    fr.end("cancelled")
    await turn
    expect(recordedCard()).toBe(cardId)

    // 模拟进程重启：重新加载模块，内存里的会话没了，记录留在磁盘上
    vi.resetModules()
    const fresh = await import("../electron/agent-sdk")
    h.resume.mockResolvedValue(agent)
    const before = h.posts.length

    const r = await fresh.launchSdkAgent(relaunchOpts())

    expect(r.ok).toBe(true)
    expect(h.resume).toHaveBeenCalledTimes(1)
    const closes = h.posts.slice(before).filter((p) => p.action === "finish")
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ card_id: cardId })
    expect(recordedCard()).toBeUndefined()
  })
})
