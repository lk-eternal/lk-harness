import type { AgentResource } from "../../src/shared/channel-types"
import type { PollPhaseEventPayload } from "../stream-card"
import { resolveSessionChatName } from "../session-chat-name"
import type { AgentEngine, AgentSessionDiagnostics, AgentSessionInfo } from "./types"
import { app } from "electron"
import { getAgentEngine, getAllAgentEngines, agentEngineKind } from "./factory"

export type ListedAgentSession = AgentSessionInfo & { pid: number; source: AgentSessionInfo["runtimeId"] }

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
  return getAgentEngine(resource).switchSessionModel(sessionKey, model, modelParams)
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
  const { stashCarryover, buildCarryoverBlock, initCarryoverStore } = await import("../carryover.js")
  initSessionModelStore(app.getPath("userData"))
  initCarryoverStore(app.getPath("userData"))

  const fromLabel = currentResource.name || currentResource.id
  const toLabel = targetResource.name || targetResource.id
  const sameLedger = agentEngineKind(currentResource) === "llm" && agentEngineKind(targetResource) === "llm"

  if (targetResource.id === currentResource.id) {
    clearSessionResourceOverride(sessionKey)
  } else {
    setSessionResourceOverride(sessionKey, targetResource.id)
  }
  if (opts?.model?.trim()) {
    setSessionOverride(sessionKey, { model: opts.model.trim(), modelParams: opts.modelParams ?? "" })
  } else {
    clearSessionOverride(sessionKey)
  }

  let turns = 0
  if (!sameLedger) {
    try {
      const live = findEngineForSession(sessionKey) ?? getAgentEngine(currentResource)
      const exported = (await live.exportTranscript?.(sessionKey)) ?? []
      if (exported.length > 0) {
        turns = exported.length
        stashCarryover(sessionKey, { block: buildCarryoverBlock(exported, fromLabel, toLabel), turns, fromLabel, toLabel })
      }
    } catch { /* 导不出则按空处理：不清不搬 */ }
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
