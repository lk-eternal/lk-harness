import type { AgentResource, MessageChannel } from "../../src/shared/channel-types"

export type AgentEngineKind = "cursor-sdk" | "llm"

export interface ListedModel {
  id: string
  label: string
  current?: boolean
}

export interface AgentLaunchParams {
  sessionKey: string
  chatType: import("../agent-session-types").ChatType
  meta?: import("../agent-session-types").LaunchMeta
  workspaceDir: string
  useMainWorkspace: boolean
  digitalIdentityOverride?: string
  senderOpenId?: string
  chatName?: string
  taskMessage?: string
  notifySessionKey?: string
  model: string
  modelParams: string
  keepSession: boolean
  persistentPoll: boolean
  pendingMessageIds?: string[]
  resource: AgentResource
  channelId?: string
  /** 主用户私聊：协议内嵌 admin 段 */
  includeAdmin?: boolean
}

export interface AgentEngine {
  kind: AgentEngineKind
  launch(params: AgentLaunchParams): Promise<{ ok: boolean; error?: string }>
  isRunning(sessionKey: string): boolean
  stop(sessionKey: string): Promise<void>
  stopAll(): Promise<void>
  listModels?(
    resource: AgentResource,
    channel?: MessageChannel,
    effModel?: string,
    effParams?: string,
  ): Promise<{ ok: boolean; models?: ListedModel[]; error?: string }>
  checkCredentials?(resource: AgentResource): Promise<{ ok: boolean; email?: string; error?: string }>
}
