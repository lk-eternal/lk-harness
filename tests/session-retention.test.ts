import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  dirByteSize,
  ledgerLimitExceeded,
  sdkRunsLimitExceeded,
  countSdkRuns,
  LEDGER_MAX_BYTES,
  LEDGER_MAX_TURNS,
  LEDGER_MAX_SDK_RUNS,
  measureLedger,
  rolloverSessionLedgerIfNeeded,
  ledgerNearRollover,
  isSessionLedgerNearRollover,
} from "../electron/session-retention.js"
import { initCarryoverStore, resetCarryoverStoreForTests, appendMirrorTurns, peekCarryover } from "../electron/carryover.js"

describe("session-retention", () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-retention-"))
    initCarryoverStore(dataDir)
    process.env.APP_DATA_DIR = dataDir
  })

  afterEach(() => {
    resetCarryoverStoreForTests()
    delete process.env.APP_DATA_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it("dirByteSize 合计目录内文件", () => {
    const dir = path.join(dataDir, "store")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "a.ndjson"), "x".repeat(100))
    fs.writeFileSync(path.join(dir, "b.ndjson"), "y".repeat(50))
    expect(dirByteSize(dir)).toBe(150)
  })

  it("ledgerLimitExceeded 轮次或体积任一达标", () => {
    expect(ledgerLimitExceeded(LEDGER_MAX_TURNS, 0)).toBe(true)
    expect(ledgerLimitExceeded(LEDGER_MAX_TURNS - 1, LEDGER_MAX_BYTES)).toBe(true)
    expect(ledgerLimitExceeded(1, 100)).toBe(false)
  })

  it("LLM 账本体积达限触发 rollover 并 stash carryover", async () => {
    const sk = "llm-sk"
    const { piSessionDir } = await import("../electron/pi-embedded.js")
    const dir = piSessionDir(sk)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "session.jsonl")
    const fd = fs.openSync(file, "w")
    fs.ftruncateSync(fd, LEDGER_MAX_BYTES + 1)
    fs.closeSync(fd)
    appendMirrorTurns(sk, [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }])

    const rolled = await rolloverSessionLedgerIfNeeded({
      runtime: "llm",
      sessionKey: sk,
      userDataDir: dataDir,
    })
    expect(rolled).toBe(true)
    expect(peekCarryover(sk)?.fromLabel).toBe("ledger-limit")
    expect(fs.existsSync(dir)).toBe(false)
  })

  it("countSdkRuns 只数有效行，坏行/空行/缺 runId 跳过，缺文件为 0", async () => {
    const dir = path.join(dataDir, "sdkstore")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "runs.ndjson"),
      [JSON.stringify({ runId: "run-1" }), "not-json", "", JSON.stringify({ runId: "run-2" }), JSON.stringify({ noRun: 1 })].join("\n"),
    )
    expect(countSdkRuns(dir)).toBe(2)
    expect(countSdkRuns(path.join(dataDir, "none"))).toBe(0)
  })

  it("dirByteSize 含子目录（SDK 新存储按 agents/runs/events/blobs 分目录）", () => {
    const dir = path.join(dataDir, "store")
    fs.mkdirSync(path.join(dir, "store2", "blobs", "ag1"), { recursive: true })
    fs.writeFileSync(path.join(dir, "top.bin"), "x".repeat(10))
    fs.writeFileSync(path.join(dir, "store2", "blobs", "ag1", "b1"), "y".repeat(200))
    fs.writeFileSync(path.join(dir, "store2", "blobs", "ag1", "b2"), "z".repeat(300))
    expect(dirByteSize(dir)).toBe(510)
  })

  it("countSdkRuns 数新布局的 run 文件（跳过临时文件），并与旧 runs.ndjson 的行数相加", () => {
    const dir = path.join(dataDir, "sdkstore-new")
    const runsDir = path.join(dir, "store2", "runs")
    fs.mkdirSync(path.join(runsDir, "ag1"), { recursive: true })
    fs.mkdirSync(path.join(runsDir, "ag2"), { recursive: true })
    for (const f of ["run-1.json", "run-2.json", "run-3.json.ab12.tmp"]) fs.writeFileSync(path.join(runsDir, "ag1", f), "{}")
    fs.writeFileSync(path.join(runsDir, "ag2", "run-9.json"), "{}")
    expect(countSdkRuns(dir)).toBe(3)
    fs.writeFileSync(path.join(dir, "runs.ndjson"), JSON.stringify({ runId: "legacy-1" }) + "\n")
    expect(countSdkRuns(dir)).toBe(4)
  })

  it("SDK 新存储里累积 15 个 run 同样触发 rollover，并清掉整个会话存储目录", async () => {
    const sk = "sdk-sk-new-layout"
    const workspace = "D:\\workspace\\lk-harness"
    const { sdkJsonlStoreDir } = await import("../electron/agent-sdk.js")
    const { SdkAppendStore } = await import("../electron/sdk-append-store.js")
    const dir = sdkJsonlStoreDir(workspace, sk)
    fs.mkdirSync(dir, { recursive: true })
    const store = new SdkAppendStore(dir)
    for (let i = 0; i < LEDGER_MAX_SDK_RUNS; i++) {
      await store.runs.create({
        run: { runId: `run-${i}`, agentId: "ag1", turnNumber: i + 1, status: "finished", createdAt: 1, updatedAt: 1 },
      })
    }
    appendMirrorTurns(sk, [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }])
    expect(countSdkRuns(dir)).toBe(LEDGER_MAX_SDK_RUNS)

    const rolled = await rolloverSessionLedgerIfNeeded({
      runtime: "sdk",
      sessionKey: sk,
      workspaceDir: workspace,
      userDataDir: dataDir,
    })
    expect(rolled).toBe(true)
    expect(peekCarryover(sk)?.fromLabel).toBe("ledger-limit")
    expect(fs.existsSync(dir)).toBe(false)
  })

  it("sdkRunsLimitExceeded 15 runs 或 10MB 任一达标", () => {
    expect(sdkRunsLimitExceeded(LEDGER_MAX_SDK_RUNS, 0)).toBe(true)
    expect(sdkRunsLimitExceeded(LEDGER_MAX_SDK_RUNS - 1, LEDGER_MAX_BYTES)).toBe(true)
    expect(sdkRunsLimitExceeded(1, 100)).toBe(false)
  })

  it("ledgerNearRollover：滚动前最后两个来回开始（SDK 倒数 2 次 run、LLM 倒数 4 条消息），体积到八成也算", () => {
    expect(ledgerNearRollover("sdk", LEDGER_MAX_SDK_RUNS - 3, 0)).toBe(false)
    expect(ledgerNearRollover("sdk", LEDGER_MAX_SDK_RUNS - 2, 0)).toBe(true)
    expect(ledgerNearRollover("llm", LEDGER_MAX_TURNS - 5, 0)).toBe(false)
    expect(ledgerNearRollover("llm", LEDGER_MAX_TURNS - 4, 0)).toBe(true)
    // 两种口径各用各的阈值：同一个数 13，SDK 该提醒了，LLM 还早
    expect(ledgerNearRollover("sdk", 13, 0)).toBe(true)
    expect(ledgerNearRollover("llm", 13, 0)).toBe(false)
    for (const runtime of ["sdk", "llm"] as const) {
      expect(ledgerNearRollover(runtime, 1, LEDGER_MAX_BYTES * 0.8 - 1)).toBe(false)
      expect(ledgerNearRollover(runtime, 1, LEDGER_MAX_BYTES * 0.8)).toBe(true)
    }
  })

  it("isSessionLedgerNearRollover 量真实 SDK 账本：倒数第 3 次 run 不提醒，倒数第 2 次起提醒，滚动清账本后不再提醒", async () => {
    const sk = "sdk-sk-near"
    const workspace = "D:\\workspace\\lk-harness"
    const { sdkJsonlStoreDir } = await import("../electron/agent-sdk.js")
    const dir = sdkJsonlStoreDir(workspace, sk)
    fs.mkdirSync(dir, { recursive: true })
    const writeRuns = (n: number) => fs.writeFileSync(
      path.join(dir, "runs.ndjson"),
      Array.from({ length: n }, (_, i) => JSON.stringify({ runId: `run-${i}` })).join("\n"),
    )
    const near = () => isSessionLedgerNearRollover({ runtime: "sdk", sessionKey: sk, workspaceDir: workspace, userDataDir: dataDir })

    writeRuns(LEDGER_MAX_SDK_RUNS - 3)
    expect(await near()).toBe(false)
    writeRuns(LEDGER_MAX_SDK_RUNS - 2)
    expect(await near()).toBe(true)

    writeRuns(LEDGER_MAX_SDK_RUNS)
    appendMirrorTurns(sk, [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }])
    expect(await rolloverSessionLedgerIfNeeded({ runtime: "sdk", sessionKey: sk, workspaceDir: workspace, userDataDir: dataDir })).toBe(true)
    expect(await near()).toBe(false)
  })

  it("isSessionLedgerNearRollover 量真实 LLM 账本：25 条正文消息不提醒，26 条起提醒", async () => {
    const sk = "llm-sk-near"
    const { piSessionDir } = await import("../electron/pi-embedded.js")
    const dir = piSessionDir(sk)
    fs.mkdirSync(dir, { recursive: true })
    const writeMessages = (n: number) => fs.writeFileSync(
      path.join(dir, "session.jsonl"),
      Array.from({ length: n }, (_, i) => JSON.stringify({
        type: "message",
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `第${i + 1}条` },
      })).join("\n") + "\n",
      "utf-8",
    )
    const near = () => isSessionLedgerNearRollover({ runtime: "llm", sessionKey: sk, userDataDir: dataDir })

    writeMessages(LEDGER_MAX_TURNS - 5)
    expect(await near()).toBe(false)
    writeMessages(LEDGER_MAX_TURNS - 4)
    expect(await near()).toBe(true)
  })

  it("isSessionLedgerNearRollover 只量不动：不清账本、不 stash carryover", async () => {
    const sk = "sdk-sk-near-readonly"
    const workspace = "D:\\workspace\\lk-harness"
    const { sdkJsonlStoreDir } = await import("../electron/agent-sdk.js")
    const dir = sdkJsonlStoreDir(workspace, sk)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "runs.ndjson"),
      Array.from({ length: LEDGER_MAX_SDK_RUNS }, (_, i) => JSON.stringify({ runId: `run-${i}` })).join("\n"),
    )
    expect(await isSessionLedgerNearRollover({ runtime: "sdk", sessionKey: sk, workspaceDir: workspace, userDataDir: dataDir })).toBe(true)
    expect(fs.existsSync(dir)).toBe(true)
    expect(peekCarryover(sk)).toBeUndefined()
  })

  it("SDK 15 runs 触发 rollover：清账本但保留 mirror，且不重复触发", async () => {
    const sk = "sdk-sk"
    const workspace = "D:\\workspace\\lk-harness"
    const { sdkJsonlStoreDir } = await import("../electron/agent-sdk.js")
    const dir = sdkJsonlStoreDir(workspace, sk)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "runs.ndjson"),
      Array.from({ length: LEDGER_MAX_SDK_RUNS }, (_, i) => JSON.stringify({ runId: `run-${i}` })).join("\n"),
    )
    appendMirrorTurns(sk, [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }])

    const rolled = await rolloverSessionLedgerIfNeeded({
      runtime: "sdk",
      sessionKey: sk,
      workspaceDir: workspace,
      userDataDir: dataDir,
    })
    expect(rolled).toBe(true)
    expect(peekCarryover(sk)?.fromLabel).toBe("ledger-limit")
    expect(fs.existsSync(dir)).toBe(false)
    // mirror 保留：不清 mirror
    const { readMirrorTurns } = await import("../electron/carryover.js")
    expect(readMirrorTurns(sk)).toHaveLength(2)

    // 账本已清：计数归零，不再重复触发
    const m = await measureLedger({ runtime: "sdk", sessionKey: sk, workspaceDir: workspace, userDataDir: dataDir })
    expect(m.turns).toBe(0)
    const again = await rolloverSessionLedgerIfNeeded({
      runtime: "sdk",
      sessionKey: sk,
      workspaceDir: workspace,
      userDataDir: dataDir,
    })
    expect(again).toBe(false)
  })

  it("SDK 14 runs 未达限不触发", async () => {
    const sk = "sdk-sk2"
    const workspace = "D:\\workspace\\lk-harness"
    const { sdkJsonlStoreDir } = await import("../electron/agent-sdk.js")
    const dir = sdkJsonlStoreDir(workspace, sk)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "runs.ndjson"),
      Array.from({ length: LEDGER_MAX_SDK_RUNS - 1 }, (_, i) => JSON.stringify({ runId: `run-${i}` })).join("\n"),
    )
    const rolled = await rolloverSessionLedgerIfNeeded({
      runtime: "sdk",
      sessionKey: sk,
      workspaceDir: workspace,
      userDataDir: dataDir,
    })
    expect(rolled).toBe(false)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it("LLM 物理口径：30 轮搬运 + 1 新回合不再触发 rollover", async () => {
    const sk = "llm-carryover-loop"
    const { piSessionDir } = await import("../electron/pi-embedded.js")
    const { readPiSessionTurns } = await import("../electron/pi-embedded.js")
    const dir = piSessionDir(sk)
    fs.mkdirSync(dir, { recursive: true })
    const history = Array.from({ length: 30 }, (_, i) => ({ text: `历史${i + 1}` }))
    const prompt = `[本轮投递]\n\`\`\`json\n${JSON.stringify({ session: {}, messages: [...history, { text: "新问题" }] })}\n\`\`\``
    const rows = [
      JSON.stringify({ type: "message", message: { role: "user", content: prompt } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "新回答" } }),
    ].join("\n") + "\n"
    fs.writeFileSync(path.join(dir, "session.jsonl"), rows, "utf-8")
    // 展开口径仍是 32 轮（回归对照），物理口径只计 2
    expect(readPiSessionTurns(sk)).toHaveLength(32)
    const m = await measureLedger({ runtime: "llm", sessionKey: sk, userDataDir: dataDir })
    expect(m.turns).toBe(2)
    const rolled = await rolloverSessionLedgerIfNeeded({ runtime: "llm", sessionKey: sk, userDataDir: dataDir })
    expect(rolled).toBe(false)
    expect(fs.existsSync(dir)).toBe(true)
  })
})
