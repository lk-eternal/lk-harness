import type { AgentLaunchParams } from "./types"
import type { AgentResource, MessageChannel } from "../../src/shared/channel-types"
import {
  launchLlmAgent,
  stopLlmSession,
  stopAllLlmSessions,
  isLlmSessionRunning,
  listLlmModels,
  verifyLlmResource,
  getLlmSessionList,
  getLlmSessionCount,
  switchLlmSessionModel,
  resetLlmSessionContext,
  handleLlmPollPhaseEvent,
  setLlmIdleHandler,
  llmFailCooldownRemaining,
  clearLlmFailStreak,
  clearAllLlmFailStreaks,
  hasPersistedLlmSession,
} from "../agent-llm"

import type { AgentEngine } from "./types"

export const llmEngine: AgentEngine = {
  kind: "llm" as const,
  runtimeId: "llm" as const,

  async launch(p: AgentLaunchParams) {
    return launchLlmAgent({
      sessionKey: p.sessionKey,
      chatType: p.chatType,
      meta: p.meta,
      workspaceDir: p.workspaceDir,
      resource: p.resource,
      model: p.model,
      modelParams: p.modelParams,
      useMainWorkspace: p.useMainWorkspace,
      digitalIdentityOverride: p.digitalIdentityOverride,
      senderOpenId: p.senderOpenId,
      chatName: p.chatName,
      taskMessage: p.taskMessage,
      notifySessionKey: p.notifySessionKey,
      keepSession: p.keepSession,
      persistentPoll: p.persistentPoll,
      pendingMessageIds: p.pendingMessageIds,
      channelId: p.channelId,
      includeAdmin: p.includeAdmin,
    })
  },

  isRunning: isLlmSessionRunning,
  stop: stopLlmSession,
  stopAll: stopAllLlmSessions,

  listSessions() {
    return getLlmSessionList().map((s) => ({
      sessionKey: s.sessionKey,
      runtimeId: "llm" as const,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      chatType: s.chatType,
      chatName: s.chatName,
      workspaceDir: s.workspaceDir,
      senderOpenId: s.senderOpenId,
      model: s.model,
      modelParams: s.modelParams,
      workerPhase: s.workerPhase,
    }))
  },

  getSessionCount: getLlmSessionCount,
  switchSessionModel: switchLlmSessionModel,
  resetSessionContext: resetLlmSessionContext,
  handlePollPhaseEvent: handleLlmPollPhaseEvent,
  setIdleHandler: setLlmIdleHandler,
  failCooldownRemaining: llmFailCooldownRemaining,
  clearFailStreak: clearLlmFailStreak,
  clearAllFailStreaks: clearAllLlmFailStreaks,
  hasResumableSession: hasPersistedLlmSession,

  async listModels(resource: AgentResource, channel?: MessageChannel, effModel?: string, effParams?: string) {
    const r = await listLlmModels(resource, effModel ?? channel?.model, effParams ?? channel?.modelParams)
    if (!r.ok) return { ok: false, error: r.error || "获取模型列表失败" }
    return { ok: true, models: r.models }
  },

  async checkCredentials(resource: AgentResource) {
    return verifyLlmResource(resource)
  },
}
