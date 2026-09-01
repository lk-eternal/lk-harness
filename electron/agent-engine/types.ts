import type { AgentResource, MessageChannel } from "../../src/shared/channel-types"

export type AgentEngineKind = "cursor-cli" | "cursor-sdk" | "llm"

export interface ListedModel {
  id: string
  label: string
  current?: boolean
}

export interface AgentLaunchParams {
  sessionKey: string
  chatType: import("../agent-launcher").ChatType
  meta?: import("../agent-launcher").LaunchMeta
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
  /** CLI resume 作用域*/
  resumeScope?: string
  /** 启动前注入 CLI MCP（是否含 admin MCP）*/
  cliMcpAdmin?: boolean
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
