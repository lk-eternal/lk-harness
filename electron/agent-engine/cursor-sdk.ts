import {
  launchSdkAgent,
  stopSdkSession,
  stopAllSdkSessions,
  isSdkSessionRunning,
  listSdkModels,
  checkSdkApiKey,
} from "../agent-sdk"
import type { AgentEngine, AgentLaunchParams } from "./types"

export const cursorSdkEngine: AgentEngine = {
  kind: "cursor-sdk",

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
      pendingMessageIds: p.pendingMessageIds,
      includeAdmin: p.includeAdmin,
    })
  },

  isRunning: isSdkSessionRunning,
  stop: stopSdkSession,
  stopAll: stopAllSdkSessions,

  async listModels(resource, channel, effModel, effParams) {
    const r = await listSdkModels(resource.apiKey ?? "", effModel ?? channel?.model, effParams ?? channel?.modelParams)
    if (!r.ok) return { ok: false, error: r.error || "获取模型列表失败" }
    return { ok: true, models: r.models }
  },

  async checkCredentials(resource) {
    return checkSdkApiKey(resource.apiKey ?? "")
  },
}
