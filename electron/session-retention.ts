import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"

export const LEDGER_MAX_TURNS = 30
/** SDK 轮次口径：runs.ndjson 有效行数（1 行 = 1 次 run ≈ mirror 2 轮），与 30 条正文轮对齐取 15 */
export const LEDGER_MAX_SDK_RUNS = 15
export const LEDGER_MAX_BYTES = 10 * 1024 * 1024

export function dirByteSize(dir: string): number {
  try {
    if (!fs.existsSync(dir)) return 0
    let total = 0
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isFile()) total += st.size
    }
    return total
  } catch {
    return 0
  }
}

export function ledgerLimitExceeded(turns: number, bytes: number): boolean {
  return turns >= LEDGER_MAX_TURNS || bytes >= LEDGER_MAX_BYTES
}

/** 数 runs.ndjson 有效行（坏行/空行跳过；不按 agentId 过滤：旧 agent 残留行同样占账本，保守计入） */
export function countSdkRuns(storeDir: string): number {
  try {
    const f = path.join(storeDir, "runs.ndjson")
    if (!fs.existsSync(f)) return 0
    let n = 0
    for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const row = JSON.parse(t) as { runId?: unknown }
        if (typeof row.runId === "string" && row.runId) n++
      } catch { /* 坏行跳过 */ }
    }
    return n
  } catch {
    return 0
  }
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
    const { readPiSessionTurns, piSessionDir } = await import("./pi-embedded.js")
    return {
      turns: readPiSessionTurns(opts.sessionKey).length,
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
  const { readMirrorTurns, takeLastTurns, stashCarryover, buildCarryoverBlock } = await import("./carryover.js")
  const { turns, bytes } = await measureLedger({ ...opts, userDataDir })

  const exceeded = opts.runtime === "llm"
    ? ledgerLimitExceeded(turns, bytes)
    : sdkRunsLimitExceeded(turns, bytes)
  if (!exceeded) return false

  const history = takeLastTurns(readMirrorTurns(opts.sessionKey))
  if (history.length > 0) {
    stashCarryover(opts.sessionKey, {
      block: buildCarryoverBlock(history, "ledger-limit", "fresh"),
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
