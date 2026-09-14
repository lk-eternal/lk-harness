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

  it("sdkRunsLimitExceeded 15 runs 或 10MB 任一达标", () => {
    expect(sdkRunsLimitExceeded(LEDGER_MAX_SDK_RUNS, 0)).toBe(true)
    expect(sdkRunsLimitExceeded(LEDGER_MAX_SDK_RUNS - 1, LEDGER_MAX_BYTES)).toBe(true)
    expect(sdkRunsLimitExceeded(1, 100)).toBe(false)
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
