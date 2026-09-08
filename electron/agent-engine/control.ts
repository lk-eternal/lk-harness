import type { AgentResource } from "../../src/shared/channel-types"
import type { PollPhaseEventPayload } from "../stream-card"
import { resolveSessionChatName } from "../session-chat-name"
import type { AgentEngine, AgentSessionDiagnostics, AgentSessionInfo } from "./types"
import { app } from "electron"
import { getAgentEngine, getAllAgentEngines, agentEngineKind } from "./factory"

export type ListedAgentSession = AgentSessionInfo & { pid: number; source: AgentSessionInfo["runtimeId"] }

/** 账本身份：LLM 全通用一个账本；SDK 每个供应商（账号）独立账本 */
function ledgerOf(resource: AgentResource): string {
  return agentEngineKind(resource) === "llm" ? "llm" : `sdk:${resource.id}`
}

/** 老待搬运块兼容：供应商 id 自带前后缀（sdk_<hex> | llm_<hex>） */
function ledgerKeyOfId(resourceId: string): string {
  return resourceId.startsWith("sdk_") ? `sdk:${resourceId}` : "llm"
}

/** 合并各引擎会话列表；同 sessionKey 时 LLM 优先（与旧逻辑一致） */
export function listAllAgentSessions(): ListedAgentSession[] {
  const rawList = getAllAgentEngines().flatMap((e) =>
    e.listSessions().map((s) => ({ ...s, pid: 0, source: s.runtimeId })),
  )
  const byKey = new Map<string, ListedAgentSession>()
  for (const s of rawList) {
    const prev = byKey.get(s.sessionKey)
    if (!prev || s.source === "llm") byKey.set(s.sessionKey, s)
  }
  return [...byKey.values()].map((s) => ({
    ...s,
    chatName: resolveSessionChatName(s.sessionKey, s.chatName, s.senderOpenId),
  }))
}

export function activeAgentSessionCount(): number {
  return getAllAgentEngines().reduce((n, e) => n + e.getSessionCount(), 0)
}

export function handleAgentPollPhase(
  sessionKey: string,
  phase: "start" | "end",
  payload: PollPhaseEventPayload,
): void {
  for (const e of getAllAgentEngines()) {
    e.handlePollPhaseEvent(sessionKey, phase, payload)
  }
}

export function resetAllSessionContext(sessionKey: string): void {
  for (const e of getAllAgentEngines()) {
    e.resetSessionContext(sessionKey)
  }
}

export function clearAllAgentFailStreaks(): void {
  for (const e of getAllAgentEngines()) {
    e.clearAllFailStreaks()
  }
}

export function clearAgentFailStreaks(sessionKey: string): void {
  for (const e of getAllAgentEngines()) {
    e.clearFailStreak(sessionKey)
  }
}

export function agentFailCooldownRemaining(sessionKey: string): number {
  let max = 0
  for (const e of getAllAgentEngines()) {
    max = Math.max(max, e.failCooldownRemaining(sessionKey))
  }
  return max
}

export function setAllAgentIdleHandlers(fn: (sessionKey: string) => void): void {
  for (const e of getAllAgentEngines()) {
    e.setIdleHandler(fn)
  }
}

export async function switchAgentSessionModel(
  resource: AgentResource,
  sessionKey: string,
  model: string,
  modelParams?: string,
): Promise<{ ok: boolean; deferred?: boolean; error?: string }> {
  return getAgentEngine(resource).switchSessionModel(sessionKey, model, modelParams, resource.id)
}

/** 会话级切推理档：仅 LLM 引擎支持；写覆盖 + 停进程，下条懒拉起 */
export async function switchAgentSessionReasoning(
  resource: AgentResource,
  sessionKey: string,
  level: string,
): Promise<{ ok: boolean; deferred?: boolean; error?: string }> {
  const fn = getAgentEngine(resource).switchSessionReasoning
  if (!fn) return { ok: false, error: "当前供应商不支持切换推理档" }
  return fn(sessionKey, level)
}

/**
 * 会话级切供应商：同账本（llm↔llm）直续；跨账本导出现在家轮次并暂存搬运。
 * 只停旧进程不清旧本子；空导出不暂存（下次按目标原生起）。
 */
export async function switchAgentSessionProvider(
  sessionKey: string,
  currentResource: AgentResource,
  targetResource: AgentResource,
  opts?: { model?: string; modelParams?: string },
): Promise<{ ok: boolean; sameLedger: boolean; turns: number; fromLabel: string; toLabel: string; error?: string }> {
  const { setSessionResourceOverride, clearSessionResourceOverride } = await import("../../src/shared/session-resource-store.js")
  const { setSessionOverride, clearSessionOverride, initSessionModelStore } = await import("../../src/shared/session-model-store.js")
  const { stashCarryover, buildCarryoverBlock, initCarryoverStore, readMirrorTurns, takeLastTurns, peekCarryover, consumeCarryover } = await import("../carryover.js")
  initSessionModelStore(app.getPath("userData"))
  initCarryoverStore(app.getPath("userData"))

  const fromLabel = currentResource.name || currentResource.id
  const toLabel = targetResource.name || targetResource.id
  const fromLedger = ledgerOf(currentResource)
  const toLedger = ledgerOf(targetResource)
  let sameLedger = fromLedger === toLedger

  if (targetResource.id === currentResource.id) {
    clearSessionResourceOverride(sessionKey)
  } else {
    setSessionResourceOverride(sessionKey, targetResource.id)
  }
  if (opts?.model?.trim()) {
    setSessionOverride(sessionKey, { model: opts.model.trim(), modelParams: opts.modelParams ?? "", resourceId: targetResource.id })
  } else {
    clearSessionOverride(sessionKey)
  }

  let turns = 0
  if (!sameLedger) {
    // 切出后一次都没在新家拉起过（待搬运块还在）就回来=零聊天回原：视同从未离开，丢块直续
    try {
      const pending = peekCarryover(sessionKey)
      const pendingFrom = pending?.fromLedger ?? (pending?.fromResourceId ? ledgerKeyOfId(pending.fromResourceId) : undefined)
      if (pending && pendingFrom !== undefined && pendingFrom === toLedger) {
        consumeCarryover(sessionKey)
        sameLedger = true
      }
    } catch { /* 无待搬运则正常搬 */ }
  }
  if (!sameLedger) {
    // 跨账本=新家全新起：逐回合抄件全量搬过去（近 10 轮封顶），下次拉起时注入
    try {
      const full = takeLastTurns(readMirrorTurns(sessionKey))
      if (full.length > 0) {
        turns = full.length
        stashCarryover(sessionKey, { block: buildCarryoverBlock(full, fromLabel, toLabel), history: full, turns, fromLabel, toLabel, fromLedger, toLedger, fromResourceId: currentResource.id, toResourceId: targetResource.id })
      }
    } catch { /* 抄件读不到则按空处理：不清不搬 */ }
    // 真换账本才忘掉旧 resume 映射；视同直续时保留，下次仍可续上
    if (!sameLedger) {
      try {
        const { forgetResumable } = await import("../agent-sdk.js")
        forgetResumable(sessionKey)
      } catch { /* 旧家无映射则无事可做 */ }
      try {
        const { forgetPiResumable } = await import("../pi-resume-store.js")
        forgetPiResumable(sessionKey)
      } catch { /* 同上 */ }
    }
  }

  try {
    const live = findEngineForSession(sessionKey)
    if (live) await live.stop(sessionKey)
  } catch { /* 停失败不阻断，下次拉起覆盖 */ }
  return { ok: true, sameLedger, turns, fromLabel, toLabel }
}

export function findLiveSessionKey(chatId: string): string | undefined {
  for (const e of getAllAgentEngines()) {
    const hit = e.listSessions().find(
      (s) => s.sessionKey === chatId || s.sessionKey.startsWith(`${chatId}::`),
    )
    if (hit) return hit.sessionKey
  }
  return undefined
}

export function hasResumableAgentSession(sessionKey: string): boolean {
  return getAllAgentEngines().some((e) => e.hasResumableSession(sessionKey))
}

export function isAgentSessionRunningOrResumable(sessionKey: string, resource: AgentResource): boolean {
  const engine = getAgentEngine(resource)
  return engine.isRunning(sessionKey) || engine.hasResumableSession(sessionKey)
}

export function getAgentSessionDiagnostics(sessionKey: string): AgentSessionDiagnostics {
  for (const e of getAllAgentEngines()) {
    const d = e.getSessionDiagnostics?.(sessionKey)
    if (d) return d
  }
  return { running: false }
}

export function getAgentResumableSummary(): { sessionKey: string; agentId: string; workspaceDir: string; updatedAt: number }[] {
  const out: { sessionKey: string; agentId: string; workspaceDir: string; updatedAt: number }[] = []
  for (const e of getAllAgentEngines()) {
    if (e.getResumableSummary) out.push(...e.getResumableSummary())
  }
  return out
}

export function findEngineForSession(sessionKey: string): AgentEngine | undefined {
  return getAllAgentEngines().find(
    (e) => e.isRunning(sessionKey) || e.listSessions().some((s) => s.sessionKey === sessionKey),
  )
}

export async function warmupAgentModels(
  resource: AgentResource,
  channel?: import("../../src/shared/channel-types").MessageChannel,
  effModel?: string,
  effParams?: string,
): Promise<void> {
  await getAgentEngine(resource).listModels?.(resource, channel, effModel, effParams).catch(() => undefined)
}
