/** userData 二级目录布局的单一所有者：新 store 只许走这里，不许再往根下铺文件 */
import * as fs from "node:fs"
import * as path from "node:path"

export const DATA_SUBDIRS = {
  config: "config",
  sessions: "sessions",
  transcripts: "transcripts",
  catalogs: "catalogs",
} as const

export function configDir(root: string): string {
  return path.join(root, DATA_SUBDIRS.config)
}

export function sessionStateDir(root: string): string {
  return path.join(root, DATA_SUBDIRS.sessions)
}

export function transcriptDir(root: string): string {
  return path.join(root, DATA_SUBDIRS.transcripts)
}

export function catalogDir(root: string): string {
  return path.join(root, DATA_SUBDIRS.catalogs)
}

/** [根下旧文件名, 目标子目录]：只搬、不删，目标已存在则跳过 */
const MOVES: [string, keyof typeof DATA_SUBDIRS][] = [
  ["scheduled-tasks.json", "config"],
  ["session-model-overrides.json", "sessions"],
  ["session-resource-overrides.json", "sessions"],
  ["session-routing.json", "sessions"],
  ["sdk-resume-map.json", "sessions"],
  ["pi-resume-map.json", "sessions"],
  ["card-questions.json", "sessions"],
  ["carryover-pending.json", "transcripts"],
  ["models-dev-catalog.json", "catalogs"],
  ["models-dev-catalog-v2.json", "catalogs"],
]

function moveFile(from: string, to: string): boolean {
  try {
    let st: fs.Stats
    try {
      st = fs.statSync(from)
    } catch {
      return false
    }
    if (!st.isFile() || fs.existsSync(to)) return false
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * 启动时一次性迁移根下散文件到子目录：幂等，双进程并发也只搬一次；
 * 返回搬了的条目（`文件名 → 子目录/`），无事可做返回空数组。
 */
export function migrateDataLayout(root: string): string[] {
  const moved: string[] = []
  if (!root) return moved
  try {
    for (const [file, sub] of MOVES) {
      if (moveFile(path.join(root, file), path.join(root, DATA_SUBDIRS[sub], file))) {
        moved.push(`${file} → ${DATA_SUBDIRS[sub]}/`)
      }
    }
    let entries: string[] = []
    try {
      entries = fs.readdirSync(root)
    } catch {
      entries = []
    }
    for (const e of entries) {
      if (!e.startsWith("transcript-") || !e.endsWith(".jsonl")) continue
      if (moveFile(path.join(root, e), path.join(root, DATA_SUBDIRS.transcripts, e))) {
        moved.push(`${e} → ${DATA_SUBDIRS.transcripts}/`)
      }
    }
  } catch {
    /* 迁移失败不阻断启动 */
  }
  return moved
}
