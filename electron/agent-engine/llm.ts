import type { AgentLaunchParams, ListedModel } from "./types"
import type { AgentResource, MessageChannel } from "../../src/shared/channel-types"
import {
  launchLlmAgent,
  stopLlmSession,
  stopAllLlmSessions,
  isLlmSessionRunning,
  listLlmModels,
  verifyLlmResource,
} from "../agent-llm"

export const llmEngine = {
  kind: "llm" as const,

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

  async listModels(resource: AgentResource, channel?: MessageChannel, effModel?: string, effParams?: string) {
    const r = await listLlmModels(resource, effModel ?? channel?.model, effParams ?? channel?.modelParams)
    if (!r.ok) return { ok: false, error: r.error || "获取模型列表失败" }
    return { ok: true, models: r.models }
  },

  async checkCredentials(resource: AgentResource) {
    return verifyLlmResource(resource)
  },
}
