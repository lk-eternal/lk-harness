// ── 定时任务的纯规则（无 node 依赖）──────────────────────
// 类型 + 通知方式 / 出站目标的推断。渲染进程（设置页）和 daemon / Electron 主进程共用，
// 所以这里不许 import node:fs / node:path 之类，文件存取放在 scheduled-task.ts。

import { makeChatKey } from "./channel-types.js";

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  content: string;
  enabled: boolean;
  /** 独立会话运行（不进主会话队列） */
  independent?: boolean;
  /**
   * 通道：通知 AI / 通知我的结果走它，独立运行拉起 Agent 时也借它的供应商 / 规则；空 = 第一个可用通道。
   * 设置页不再单独让用户选「所属通道」，改通道时随通知通道一起写入。
   */
  channelId?: string;
  /** 任务模型，空 = 跟随通道主模型 */
  model?: string;
  modelParams?: string;
  /** 任务自己选的供应商（Agent 资源 id），空 = 跟随通道的供应商。只在同时配了 model 时生效：供应商换了，模型必须是它家的 */
  resourceId?: string;
  /**
   * 接收方的聊天 / 会话，含义随通知方式和通道类型：
   *  - 通知我 + 飞书：群 ID（裸 oc_xxx 或完整 chatKey），空 = 主用户私聊；微信不用填；
   *  - 通知我 + 应用内对话：接收结果的会话键（必填）；
   *  - 通知 AI：所选会话的会话键，空 = 该通道的主会话（项目会话用 targetProjectId）。
   */
  notifyChatId?: string;
  /**
   * 通知谁（AI 调用 send_result 提交结果；非独立运行时是任务内容本身）：
   * none 不通知（仅独立运行：只执行，AI 仍可自己发图片 / 文件） / agent 通知 AI：投进 Agent 会话队列并唤醒它 / im 通知我：以 AI 口吻发给用户，不唤醒 Agent。
   * 独立运行缺省按旧规则推断，非独立运行缺省是 agent，见 resolveTaskNotify。
   */
  notify?: TaskNotify;
  /** 通知用的通道；空 = 同 channelId（设置页保存时只写 channelId，旧任务可能单独存了它） */
  notifyChannelId?: string;
  /**
   * 通知 AI 时绑定的项目会话（我们自己的会话，不是飞书会话）：空 = 用 notifyChatId 选的会话，再空 = 通道的主会话。
   * 非独立运行：任务内容直接投给它；独立运行：结果投给它。
   */
  targetProjectId?: string;
  /** 谁创建的：缺省 = 用户在设置页 / 管理工具里建的；ai = AI 给自己排的程（受次数 / 过期 / 数量限制） */
  createdBy?: "user" | "ai";
  createdAt?: number;
  /** AI 创建：创建它的会话 key，只有该会话能列出 / 取消 */
  ownerSessionKey?: string;
  /** AI 创建：最多触发几次（累计次数记在单独的状态文件里，不改任务文件） */
  maxRuns?: number;
  /** AI 创建：到期时间（毫秒时间戳），过期自动作废 */
  expiresAt?: number;
  /** 仅供设置页显示：AI 排程已触发次数。只在 scheduled-tasks:get 的返回里有，不落盘 */
  runCount?: number;
}

/** 独立任务的结果通知方式 */
export type TaskNotify = "none" | "agent" | "im";

type NotifyFields = Pick<ScheduledTask, "independent" | "notify" | "notifyChatId">;
type ChannelFields = Pick<ScheduledTask, "channelId" | "notifyChannelId">;

const NOTIFY_MODES: readonly TaskNotify[] = ["none", "agent", "im"];

export function isTaskNotify(v: unknown): v is TaskNotify {
  return typeof v === "string" && (NOTIFY_MODES as readonly string[]).includes(v);
}

/**
 * 任务实际通知谁。
 * - 非独立运行：任务内容本身就是要送的东西，只能通知 AI（agent）或通知我（im）；没配过（旧任务）按通知 AI。
 * - 独立运行显式配过 notify：按它。
 * - 独立运行的旧任务（没有 notify 字段）：填过飞书群/聊天 ID 就是通知我（设置页原来的承诺），没填就是不通知。
 */
export function resolveTaskNotify(task: NotifyFields): TaskNotify {
  if (task.independent === false) return task.notify === "im" ? "im" : "agent";
  if (isTaskNotify(task.notify)) return task.notify;
  return task.notifyChatId?.trim() ? "im" : "none";
}

/** 非独立运行 + 通知我：不启动 Agent，任务内容直接以任务消息发给用户 */
export function isDirectNotifyTask(task: NotifyFields): boolean {
  return task.independent === false && resolveTaskNotify(task) === "im";
}

/** 任务的消息是独立发出的（没有会话回合去收口流式卡）：独立运行的任务，和直接通知用户的任务 */
export function sendsStandaloneMessages(task: NotifyFields): boolean {
  return task.independent !== false || isDirectNotifyTask(task);
}

/** 任务通知用的通道，同时也是独立运行出站（send_result / send_image / send_file）走的通道：专门存的 notifyChannelId > channelId */
export function taskNotifyChannelId(task: ChannelFields): string | undefined {
  return task.notifyChannelId?.trim() || task.channelId?.trim() || undefined;
}

/** 通知 AI 时所选的具体会话（会话键）；空 = 项目会话（targetProjectId）或通道的主会话 */
export function taskAgentSessionKey(task: NotifyFields & Pick<ScheduledTask, "targetProjectId">): string | undefined {
  if (resolveTaskNotify(task) !== "agent" || task.targetProjectId?.trim()) return undefined;
  return task.notifyChatId?.trim() || undefined;
}

/**
 * 由任务配置拼出 outbound 投递用的 notify_session_key：只有「通知我」且显式填了聊天 ID / 会话键才有。
 * 不是通知我时 notifyChatId 不走这里（通知 AI 时它是目标会话，见 taskAgentSessionKey；不通知时残留的不再生效）。
 */
export function buildNotifySessionKey(
  task: NotifyFields & ChannelFields,
): string | undefined {
  if (resolveTaskNotify(task) !== "im") return undefined;
  const raw = task.notifyChatId?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ch_") && raw.includes("|")) return raw;
  const channelId = taskNotifyChannelId(task);
  if (!channelId) return undefined;
  return makeChatKey(channelId, raw);
}

/**
 * 独立任务 MCP / 路由用 outbound chatKey：通知到 IM 且填了聊天 ID 就是那个聊天，否则是通道主用户私聊。
 * mainUserChatId 必须是 taskNotifyChannelId(task) 那个通道的主用户私聊（调用方按它取）。
 */
export function resolveTaskOutboundChatKey(
  task: NotifyFields & ChannelFields,
  mainUserChatId?: string | null,
): string | undefined {
  const explicit = buildNotifySessionKey(task);
  if (explicit) return explicit;
  const channelId = taskNotifyChannelId(task);
  const main = mainUserChatId?.trim();
  if (!channelId || !main) return undefined;
  return makeChatKey(channelId, main);
}

/** 是否 AI 给自己排的程（createdBy=ai） */
export function isAiTask(task: Pick<ScheduledTask, "createdBy">): boolean {
  return task.createdBy === "ai";
}
