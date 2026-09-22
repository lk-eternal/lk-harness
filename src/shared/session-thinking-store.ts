import {
  initSessionOverridesStore,
  resetSessionOverridesStoreForTests,
  patchSessionRecord,
  getSessionRecord,
} from "./session-overrides-store.js"

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

export function initSessionThinkingStore(dir: string): void {
  initSessionOverridesStore(dir)
}

export function resetSessionThinkingStoreForTests(): void {
  resetSessionOverridesStoreForTests()
}

export function setSessionThinking(sessionKey: string, level: ThinkingLevel): void {
  patchSessionRecord(sessionKey, { thinkingLevel: level })
}

export function getSessionThinking(sessionKey: string): ThinkingLevel | undefined {
  const level = getSessionRecord(sessionKey)?.thinkingLevel
  return level && isThinkingLevel(level) ? level : undefined
}

export function clearSessionThinking(sessionKey: string): void {
  patchSessionRecord(sessionKey, { thinkingLevel: undefined })
}
