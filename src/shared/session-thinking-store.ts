import * as fs from "node:fs"
import * as path from "node:path"
import { sessionStateDir } from "./data-paths.js"

/** Pi 支持的推理档位（ModelThinkingLevel）：off=不推理 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

export function isThinkingLevel(v: string | undefined): v is ThinkingLevel {
  return (THINKING_LEVELS as string[]).includes(v ?? "")
}

/**
 * models.dev effort 取值映射到 Pi 档位并按 THINKING_LEVELS 保序，恒带 off。
 * 无可用映射（空 / 仅 budget_tokens 等）返回 undefined，调用方回退全量档。
 */
export function mapEffortLevels(values: string[] | undefined): ThinkingLevel[] | undefined {
  if (!values?.length) return undefined
  const norm = new Set(values.map((v) => (v.trim() === "none" ? "off" : v.trim())))
  const levels = (THINKING_LEVELS as string[]).filter((l) => norm.has(l))
  if (!levels.length) return undefined
  if (!levels.includes("off")) levels.unshift("off")
  return levels as ThinkingLevel[]
}

/** 无覆盖时的默认档：模型目录 reasoning=true 才开 medium */
export function defaultThinkingLevel(modelReasoning?: boolean): ThinkingLevel {
  return modelReasoning ? "medium" : "off"
}

/** 会话有效档：覆盖优先，其次模型默认 */
export function resolveThinkingLevel(
  sessionKey: string,
  modelReasoning?: boolean,
): ThinkingLevel {
  return getSessionThinking(sessionKey) ?? defaultThinkingLevel(modelReasoning)
}

interface ThinkingFile {
  sessions: Record<string, { level: ThinkingLevel; updatedAt: number }>
}

const FILE_NAME = "session-thinking.json"

let dataDir: string | null = null
let cache: ThinkingFile | null = null

export function initSessionThinkingStore(dir: string): void {
  dataDir = dir
  cache = null
}

export function resetSessionThinkingStoreForTests(): void {
  dataDir = null
  cache = null
}

function resolveDataDir(): string {
  if (dataDir) return dataDir
  if (process.env.APP_DATA_DIR) return process.env.APP_DATA_DIR
  throw new Error("session-thinking-store: data dir not initialized")
}

function storePath(): string {
  return path.join(sessionStateDir(resolveDataDir()), FILE_NAME)
}

function load(): ThinkingFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as ThinkingFile
    cache = { sessions: raw.sessions ?? {} }
  } catch {
    cache = { sessions: {} }
  }
  return cache
}

function save(): void {
  if (!cache) return
  const target = storePath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = target + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(cache), "utf8")
  fs.renameSync(tmp, target)
}

export function setSessionThinking(sessionKey: string, level: ThinkingLevel): void {
  const s = load()
  s.sessions[sessionKey] = { level, updatedAt: Date.now() }
  save()
}

export function getSessionThinking(sessionKey: string): ThinkingLevel | undefined {
  const e = load().sessions[sessionKey]
  return e && isThinkingLevel(e.level) ? e.level : undefined
}

export function clearSessionThinking(sessionKey: string): void {
  const s = load()
  if (!(sessionKey in s.sessions)) return
  delete s.sessions[sessionKey]
  save()
}
