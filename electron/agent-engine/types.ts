import type { AgentResource, MessageChannel } from "../../src/shared/channel-types"
import type { PollPhaseEventPayload } from "../stream-card"

/** 引擎实现标识；与 UI SessionSource 一致，新增 Agent 在此扩展 */
export type AgentRuntimeId = "sdk" | "llm"

export type AgentEngineKind = "cursor-sdk" | "llm"

export interface ListedModel {
  id: string
  label: string
  current?: boolean
}

export interface AgentSessionInfo {
  sessionKey: string
  runtimeId: AgentRuntimeId
  startedAt: number
  lastActivityAt: number
  chatType: string
  chatName?: string
  workspaceDir?: string
  senderOpenId?: string
  model?: string
  modelParams?: string
  agentId?: string
  workerPhase?: string
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
  /** 切供应商搬运：全新起（不清旧家，下家清了重铺） */
  newSession?: boolean
  pendingMessageIds?: string[]
  resource: AgentResource
  channelId?: string
  /** 主用户私聊：协议内嵌 admin 段 */
  includeAdmin?: boolean
}

export interface AgentSessionDiagnostics {
  running: boolean
  resumeAgentId?: string
  resumeUpdatedAt?: number
  lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }
}

export interface TranscriptTurn {
  role: "user" | "assistant"
  text: string
}

export interface AgentEngine {
  kind: AgentEngineKind
  runtimeId: AgentRuntimeId

  launch(params: AgentLaunchParams): Promise<{ ok: boolean; error?: string }>
  isRunning(sessionKey: string): boolean
  stop(sessionKey: string): Promise<void>
  stopAll(): Promise<void>

  listSessions(): AgentSessionInfo[]
  getSessionCount(): number

  switchSessionModel(
    sessionKey: string,
    model: string,
    modelParams?: string,
  ): Promise<{ ok: boolean; deferred?: boolean; error?: string }>
  resetSessionContext(sessionKey: string): void
  handlePollPhaseEvent(sessionKey: string, phase: "start" | "end", payload: PollPhaseEventPayload): void
  setIdleHandler(fn: (sessionKey: string) => void): void

  failCooldownRemaining(sessionKey: string): number
  clearFailStreak(sessionKey: string): void
  clearAllFailStreaks(): void
  hasResumableSession(sessionKey: string): boolean

  /** 导出最近正文轮次（搬运用；取不到返回 []，不抛错） */
  exportTranscript?(sessionKey: string): Promise<TranscriptTurn[]>

  listModels?(
    resource: AgentResource,
    channel?: MessageChannel,
    effModel?: string,
    effParams?: string,
  ): Promise<{ ok: boolean; models?: ListedModel[]; error?: string }>
  checkCredentials?(resource: AgentResource): Promise<{ ok: boolean; email?: string; error?: string }>
  getSessionDiagnostics?(sessionKey: string): AgentSessionDiagnostics
  getResumableSummary?(): { sessionKey: string; agentId: string; workspaceDir: string; updatedAt: number }[]
}
