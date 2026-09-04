import {
  launchSdkAgent,
  stopSdkSession,
  stopAllSdkSessions,
  isSdkSessionRunning,
  listSdkModels,
  checkSdkApiKey,
  getSdkSessionList,
  getSdkSessionCount,
  switchSdkSessionModel,
  resetSdkSessionContext,
  exportSdkTranscript,
  handlePollPhaseEvent,
  setSdkIdleHandler,
  sdkFailCooldownRemaining,
  clearSdkFailStreak,
  clearAllSdkFailStreaks,
  hasResumableSdkSession,
  getSdkSessionDiagnostics,
  getResumableSummary,
} from "../agent-sdk"
import type { AgentEngine, AgentLaunchParams } from "./types"

export const cursorSdkEngine: AgentEngine = {
  kind: "cursor-sdk",
  runtimeId: "sdk",

  async launch(p: AgentLaunchParams) {
    return launchSdkAgent({
      sessionKey: p.sessionKey,
      chatType: p.chatType,
      meta: p.meta,
      workspaceDir: p.workspaceDir,
      useMainWorkspace: p.useMainWorkspace,
      digitalIdentityOverride: p.digitalIdentityOverride,
      senderOpenId: p.senderOpenId,
      chatName: p.chatName,
      taskMessage: p.taskMessage,
      notifySessionKey: p.notifySessionKey,
      apiKey: p.resource.apiKey ?? "",
      model: p.model,
      modelParams: p.modelParams,
      keepSession: p.keepSession,
      persistentPoll: p.persistentPoll,
      newSession: p.newSession,
      pendingMessageIds: p.pendingMessageIds,
      includeAdmin: p.includeAdmin,
    })
  },

  isRunning: isSdkSessionRunning,
  stop: stopSdkSession,
  stopAll: stopAllSdkSessions,

  listSessions() {
    return getSdkSessionList().map((s) => ({
      sessionKey: s.sessionKey,
      runtimeId: "sdk" as const,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      chatType: s.chatType,
      chatName: s.chatName,
      workspaceDir: s.workspaceDir,
      senderOpenId: s.senderOpenId,
      model: s.model,
      modelParams: s.modelParams,
      agentId: s.agentId,
    }))
  },

  getSessionCount: getSdkSessionCount,
  switchSessionModel: switchSdkSessionModel,
  resetSessionContext: resetSdkSessionContext,
  exportTranscript: exportSdkTranscript,
  handlePollPhaseEvent,
  setIdleHandler: setSdkIdleHandler,
  failCooldownRemaining: sdkFailCooldownRemaining,
  clearFailStreak: clearSdkFailStreak,
  clearAllFailStreaks: clearAllSdkFailStreaks,
  hasResumableSession: hasResumableSdkSession,

  async listModels(resource, channel, effModel, effParams) {
    const r = await listSdkModels(resource.apiKey ?? "", effModel ?? channel?.model, effParams ?? channel?.modelParams)
    if (!r.ok) return { ok: false, error: r.error || "获取模型列表失败" }
    return { ok: true, models: r.models }
  },

  async checkCredentials(resource) {
    return checkSdkApiKey(resource.apiKey ?? "")
  },

  getSessionDiagnostics: getSdkSessionDiagnostics,
  getResumableSummary,
}
