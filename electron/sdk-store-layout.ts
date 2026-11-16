/**
 * SDK 本地存储的磁盘布局常量与只读统计。
 *
 * 不依赖 @cursor/sdk：session-retention（账本限额）和存储本体共用，
 * 避免保留机制为了数文件而把整个 SDK 拉进来。
 */
import * as fs from "node:fs"
import * as path from "node:path"

/** 新布局放在会话 sdk-jsonl 目录下的这个子目录里（目录名沿用 sdk-jsonl，保证会话迁移/删除/重置等既有路径逻辑不变） */
export const SDK_STORE_SUBDIR = "store2"
/** 新布局就绪标记：存在即代表旧 ndjson 已迁移或丢弃 */
export const SDK_STORE_READY_FILE = ".ready"

/** SDK 自带 JsonlLocalAgentStore 的文件名（旧布局，只读，用于迁移） */
export const LEGACY_STORE_FILES = {
  agents: "agents.ndjson",
  runs: "runs.ndjson",
  runEvents: "run_events.ndjson",
  checkpoints: "checkpoints.ndjson",
} as const

export const LEGACY_STORE_FILE_NAMES: readonly string[] = Object.values(LEGACY_STORE_FILES)

/** 新布局子目录名 */
export const STORE_DIRS = {
  agents: "agents",
  runs: "runs",
  events: "events",
  blobs: "blobs",
} as const

/** 旧 ndjson 合计字节数（不存在的文件按 0） */
export function legacyStoreBytes(rootDir: string): number {
  let total = 0
  for (const name of LEGACY_STORE_FILE_NAMES) {
    try {
      total += fs.statSync(path.join(rootDir, name)).size
    } catch { /* 不存在 */ }
  }
  return total
}

/** 新布局里的 run 文件数（runs/<agentId>/<runId>.json；跳过临时文件） */
export function countRunFiles(rootDir: string): number {
  const runsDir = path.join(rootDir, SDK_STORE_SUBDIR, STORE_DIRS.runs)
  let n = 0
  try {
    for (const agentDir of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!agentDir.isDirectory()) continue
      try {
        for (const f of fs.readdirSync(path.join(runsDir, agentDir.name))) {
          if (f.endsWith(".json")) n++
        }
      } catch { /* 目录被并发清理 */ }
    }
  } catch { /* 无新布局 */ }
  return n
}
