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
  /** 所属消息通道；空 = 第一个可用通道 */
  channelId?: string;
  /** 任务模型，空 = 跟随通道主模型 */
  model?: string;
  modelParams?: string;
  /** 任务自己选的供应商（Agent 资源 id），空 = 跟随通道的供应商。只在同时配了 model 时生效：供应商换了，模型必须是它家的 */
  resourceId?: string;
  /**
   * 飞书群 / 聊天 ID（裸 oc_xxx 或完整 chatKey）。只在「通知到 IM」时有意义：
   * 结果发到这个聊天；空 = 发到发送通道绑定的主用户私聊。与 Agent 会话无关。
   */
  notifyChatId?: string;
  /**
   * 独立运行的任务做完后怎么交付结果（AI 调用 send_result 提交）：
   * none 不通知（只执行；AI 仍可自己发图片/文件） / agent 投进绑定的 Agent 会话队列 / im 发到飞书或微信。
   * 缺省按旧规则推断，见 resolveTaskNotify。
   */
  notify?: TaskNotify;
  /** 「通知到 IM」时用哪个通道发送；空 = 同所属通道 */
  notifyChannelId?: string;
  /**
   * 绑定的 Agent 会话（我们自己的会话，不是飞书会话）：空 = 所属通道的主会话，否则 = 该项目的会话。
   * 非独立运行：任务内容直接投给它；独立运行 + 通知到 Agent：结果投给它。
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
 * 任务做完后实际怎么通知。
 * - 非独立运行：内容直接进会话，没有「独立结果」可通知，恒为 none。
 * - 显式配过 notify：按它。
 * - 旧任务（没有 notify 字段）：填过飞书群/聊天 ID 就是发 IM（设置页原来的承诺），没填就是不通知。
 */
export function resolveTaskNotify(task: NotifyFields): TaskNotify {
  if (task.independent === false) return "none";
  if (isTaskNotify(task.notify)) return task.notify;
  return task.notifyChatId?.trim() ? "im" : "none";
}

/** 「通知到 IM」用哪个通道发：专门选的发送通道 > 所属通道 */
export function taskImChannelId(task: ChannelFields): string | undefined {
  return task.notifyChannelId?.trim() || task.channelId?.trim() || undefined;
}

/**
 * 任务出站消息（send_result / send_image / send_file）走哪个通道：
 * 通知到 IM 时是发送通道；其余情况出站只有 AI 自己发的图片/文件，发到所属通道的主用户私聊。
 */
export function taskOutboundChannelId(task: NotifyFields & ChannelFields): string | undefined {
  return resolveTaskNotify(task) === "im" ? taskImChannelId(task) : (task.channelId?.trim() || undefined);
}

/**
 * 由任务配置拼出 outbound 投递用的 notify_session_key：只有「通知到 IM」且显式填了聊天 ID 才有。
 * 不是 IM 通知时，旧任务里残留的 notifyChatId 不再生效（它对 Agent 会话 / 不通知没有意义）。
 */
export function buildNotifySessionKey(
  task: NotifyFields & ChannelFields,
): string | undefined {
  if (resolveTaskNotify(task) !== "im") return undefined;
  const raw = task.notifyChatId?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ch_") && raw.includes("|")) return raw;
  const channelId = taskImChannelId(task);
  if (!channelId) return undefined;
  return makeChatKey(channelId, raw);
}

/**
 * 独立任务 MCP / 路由用 outbound chatKey：通知到 IM 且填了聊天 ID 就是那个聊天，否则是通道主用户私聊。
 * mainUserChatId 必须是 taskOutboundChannelId(task) 那个通道的主用户私聊（调用方按它取）。
 */
export function resolveTaskOutboundChatKey(
  task: NotifyFields & ChannelFields,
  mainUserChatId?: string | null,
): string | undefined {
  const explicit = buildNotifySessionKey(task);
  if (explicit) return explicit;
  const channelId = taskOutboundChannelId(task);
  const main = mainUserChatId?.trim();
  if (!channelId || !main) return undefined;
  return makeChatKey(channelId, main);
}

/** 是否 AI 给自己排的程（createdBy=ai） */
export function isAiTask(task: Pick<ScheduledTask, "createdBy">): boolean {
  return task.createdBy === "ai";
}
