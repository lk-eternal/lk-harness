import type { AgentResource, MessageChannel } from "../../src/shared/channel-types"
import type { PollPhaseEventPayload } from "../stream-card"

/** 引擎实现标识；与 UI SessionSource 一致，新增 Agent 在此扩展 */
export type AgentRuntimeId = "sdk" | "llm"

export type AgentEngineKind = "cursor-sdk" | "llm"

export interface ListedModel {
  id: string
  label: string
  current?: boolean
  /** variant 参数（SDK 同模型多档位靠它区分；缺省=无参数） */
  params?: string
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
  resourceId?: string
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
  /** 跨账本搬运历史：首轮拼进 messages 最前面（无 message_id，不进 poll 去重） */
  historyTurns?: TranscriptTurn[]
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
  quoted_message?: {
    message_id: string
    sender_type: string
    sender_open_id?: string
    text: string
  }
}

export interface CompleteParams {
  resource: AgentResource
  /** 会话当前模型 id；引擎可自行决定是否采用（SDK 引擎统一走默认模型，免得一个标题耗掉高档位额度） */
  model: string
  prompt: string
}

/** 软打断的结果：调用方据此决定是否还要走「停止 + 重新拉起」 */
export type InterruptTurnResult =
  /** 当前这一轮已取消并收口；Agent 还在，会自己去队列领排队的消息 */
  | "interrupted"
  /** Agent 正在拉起，还没有可打断的回合；排队的消息会由它启动后领走 */
  | "launching"
  /** Agent 活着，但此刻没有在跑回合（刚好结束，或在空闲监听） */
  | "no-turn"
  /** 不适用：按需唤醒的会话（回合一结束 Agent 就退出）或引擎不支持 */
  | "unsupported"
  /** 已取消，但回合迟迟没有收口 */
  | "timeout"
  /** 打断过程中 Agent 退出了（出错、账本滚动要冷启动等），由调度器重新拉起 */
  | "exited"
  /** 没有 Agent 在运行 */
  | "not-running"

export interface AgentEngine {
  kind: AgentEngineKind
  runtimeId: AgentRuntimeId

  launch(params: AgentLaunchParams): Promise<{ ok: boolean; error?: string }>
  isRunning(sessionKey: string): boolean
  stop(sessionKey: string): Promise<void>
  stopAll(): Promise<void>
  /**
   * 软打断（可选）：只取消当前这一轮，Agent 不退出，随后自己去队列领排队的消息。
   * 比「停止再重新拉起」快得多：省掉重新拉起（SDK 的 Resume 要走网络，偶发卡 30 秒以上）。
   * 不实现 = 不支持，调用方走停止 + 重新拉起。
   */
  interruptTurn?(sessionKey: string): Promise<InterruptTurnResult>

  listSessions(): AgentSessionInfo[]
  getSessionCount(): number

  switchSessionModel(
    sessionKey: string,
    model: string,
    modelParams?: string,
    resourceId?: string,
  ): Promise<{ ok: boolean; deferred?: boolean; error?: string }>
  /** 切推理档（仅 LLM；SDK 的档位即 variants，走 switchSessionModel） */
  switchSessionReasoning?(
    sessionKey: string,
    level: string,
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
  /** 一次性文本补全：不进任何会话、不带工具（会话标题等轻量生成用） */
  complete?(p: CompleteParams): Promise<{ ok: boolean; text?: string; error?: string }>
  getSessionDiagnostics?(sessionKey: string): AgentSessionDiagnostics
  getResumableSummary?(): { sessionKey: string; agentId: string; workspaceDir: string; updatedAt: number }[]
}
