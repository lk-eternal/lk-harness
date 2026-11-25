import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { LEGACY_STORE_FILES, countRunFiles } from "./sdk-store-layout"

/** LLM 轮次口径：物理 Pi 消息数（1 个 prompt = 1 轮，不展开一条用户消息里的多条正文；≈15 回合，与 SDK 15 runs 对齐） */
export const LEDGER_MAX_TURNS = 30
/** SDK 轮次口径：runs.ndjson 有效行数（1 行 = 1 次 run ≈ mirror 2 轮），与 30 条正文轮对齐取 15 */
export const LEDGER_MAX_SDK_RUNS = 15
export const LEDGER_MAX_BYTES = 10 * 1024 * 1024

/** 目录内所有文件的字节数合计（含子目录：SDK 新存储按 agents/runs/events/blobs 分目录） */
export function dirByteSize(dir: string, depth = 0): number {
  try {
    if (depth > 6 || !fs.existsSync(dir)) return 0
    let total = 0
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      try {
        const st = fs.statSync(p)
        if (st.isFile()) total += st.size
        else if (st.isDirectory()) total += dirByteSize(p, depth + 1)
      } catch { /* 统计途中文件被删/改名：跳过 */ }
    }
    return total
  } catch {
    return 0
  }
}

export function ledgerLimitExceeded(turns: number, bytes: number): boolean {
  return turns >= LEDGER_MAX_TURNS || bytes >= LEDGER_MAX_BYTES
}

/**
 * 数账本里的 run 数：旧布局 runs.ndjson 的有效行（坏行/空行跳过）+ 新布局 store2/runs/<agent>/ 下的 run 文件。
 * 不按 agentId 过滤：旧 agent 残留同样占账本，保守计入。
 */
export function countSdkRuns(storeDir: string): number {
  let n = 0
  try {
    const f = path.join(storeDir, LEGACY_STORE_FILES.runs)
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
        const t = line.trim()
        if (!t) continue
        try {
          const row = JSON.parse(t) as { runId?: unknown }
          if (typeof row.runId === "string" && row.runId) n++
        } catch { /* 坏行跳过 */ }
      }
    }
  } catch { /* 读旧文件失败按 0 计 */ }
  return n + countRunFiles(storeDir)
}

export function sdkRunsLimitExceeded(runs: number, bytes: number): boolean {
  return runs >= LEDGER_MAX_SDK_RUNS || bytes >= LEDGER_MAX_BYTES
}

export async function measureLedger(opts: {
  runtime: "sdk" | "llm"
  sessionKey: string
  workspaceDir?: string
  userDataDir: string
}): Promise<{ turns: number; bytes: number }> {
  if (opts.runtime === "llm") {
    const { countPiSessionPhysicalTurns, piSessionDir } = await import("./pi-embedded.js")
    return {
      turns: countPiSessionPhysicalTurns(opts.sessionKey),
      bytes: dirByteSize(piSessionDir(opts.sessionKey)),
    }
  }
  if (!opts.workspaceDir?.trim()) return { turns: 0, bytes: 0 }
  const { sdkJsonlStoreDir } = await import("./agent-sdk.js")
  const storeDir = sdkJsonlStoreDir(opts.workspaceDir, opts.sessionKey)
  return {
    turns: countSdkRuns(storeDir),
    bytes: dirByteSize(storeDir),
  }
}

/** 回合结束后检查 SDK/LLM 账本；超限则 stash mirror、清账本、丢 resume */
export async function rolloverSessionLedgerIfNeeded(opts: {
  runtime: "sdk" | "llm"
  sessionKey: string
  workspaceDir?: string
  userDataDir?: string
}): Promise<boolean> {
  const userDataDir = opts.userDataDir ?? app.getPath("userData")
  const { readMirrorTurns, takeLastTurns, stashCarryover } = await import("./carryover.js")
  const { turns, bytes } = await measureLedger({ ...opts, userDataDir })

  const exceeded = opts.runtime === "llm"
    ? ledgerLimitExceeded(turns, bytes)
    : sdkRunsLimitExceeded(turns, bytes)
  if (!exceeded) return false

  const history = takeLastTurns(readMirrorTurns(opts.sessionKey))
  if (history.length > 0) {
    stashCarryover(opts.sessionKey, {
      turns: history.length,
      fromLabel: "ledger-limit",
      toLabel: "fresh",
      history,
    })
  }

  if (opts.runtime === "llm") {
    const { clearPiSession } = await import("./pi-embedded.js")
    const { forgetPiResumable } = await import("./pi-resume-store.js")
    clearPiSession(opts.sessionKey)
    forgetPiResumable(opts.sessionKey)
  } else {
    const { clearSdkJsonlStore, forgetResumable } = await import("./agent-sdk.js")
    clearSdkJsonlStore(opts.workspaceDir!, opts.sessionKey)
    forgetResumable(opts.sessionKey)
  }

  return true
}
