// ── 多消息通道共享类型与工具 ──────────────────────────────
// Electron 主进程与 Daemon 子进程共用。

import type { LlmApiProtocol } from "./agent-providers.js"

/** Agent 资源：SDK Key 或大模型供应商实例 */
export interface AgentResource {
  id: string;            // "sdk_<hex>" | "llm_<hex>"
  type: "sdk" | "llm-builtin" | "llm-custom";
  name: string;
  apiKey?: string;       // SDK / 大模型供应商
  /** 校验成功后缓存的账号标识（仅展示用） */
  email?: string;
  /** 内置供应商 id（openai / anthropic …） */
  providerId?: string;
  /** 自定义网关 Base URL */
  baseUrl?: string;
  /** 自定义网关默认模型 ID 列表 */
  modelIds?: string[];
}

/** 消息通道：一个飞书自建应用或一个微信账号 */
export interface MessageChannel {
  id: string;            // "ch_<hex>"
  name: string;
  enabled: boolean;
  type: "feishu" | "wechat";
  // 飞书凭据
  larkAppId?: string;
  larkAppSecret?: string;
  larkAppQuickCreated?: boolean;
  /** 飞书机器人应用名缓存（凭据校验时解析，离线可显示） */
  larkBotName?: string;
  // 微信凭据
  wechatToken?: string;
  wechatAccountId?: string;
  // Agent 绑定
  agentResourceId: string;        // sdk / llm 资源 id
  model: string;                  // 主模型（"" / "auto" = 默认）
  modelParams: string;            // JSON 序列化的 {id,value}[]，仅 SDK
  othersModel: string;            // 其他人/群聊模型，空 = 跟随主模型
  othersModelParams: string;
  // 主用户（可选）
  mainUserEnabled: boolean;
  mainUserChatId: string;         // 原始 chatId（不含通道前缀）
  mainUserOpenId?: string;       // 绑定时刻记录的发送人 id（群/私聊同值，直比）
  // 其他人使用（通道级）
  allowOthers: boolean;
  /** 对外身份规则，注入到其他人会话的临时工作目录 */
  digitalIdentity: string;
  // 工作目录（主用户私聊时使用；空 = 回退全局兜底）
  workspaceDir: string;
  /** 该通道的常用目录（可切换会话来源）；undefined = 未迁移，回退全局 favoriteWorkspaces */
  favoriteWorkspaces?: string[];
  /** 保留会话：run 结束后保留上下文（记录 agentId），新消息 Resume 延续对话（默认 true） */
  keepSession?: boolean;
  /** 保持长连接：无限 poll 保活（默认 true；false = 回答完收回合按需唤醒） */
  persistentPoll?: boolean;
  /** 是否展示流式进度卡（默认 true；关闭后仅推送最终回复消息） */
  showThinking?: boolean;
  /** 流式卡思考/工具块各保留最近 N 个（默认 5；仅 showThinking 开启时生效） */
  streamKeepPerKind?: number;
  /** 完整回复后隐藏思考/工具/todos 折叠块，仅保留正文（默认 true） */
  hideThinkingOnFinish?: boolean;
}

/** 下发给 Daemon 的通道配置（含运行所需的全部字段） */
export interface DaemonChannelConfig {
  id: string;
  name: string;
  type: "feishu" | "wechat";
  appId?: string;
  appSecret?: string;
  wechatToken?: string;
  wechatAccountId?: string;
  mainUserEnabled: boolean;
  mainUserChatId: string;
  mainUserOpenId?: string;       // 绑定时刻记录的发送人 id（群/私聊同值，直比）
  /** 通道级工作目录，空 = 跟随全局 WORKSPACE_DIR */
  workspaceDir: string;
  /** 合成开关（keepSession && persistentPoll）：poll 响应随路下发，作为 Agent 收尾方式的权威来源 */
  keepAlive?: boolean;
  /** 是否展示流式进度卡（默认 true） */
  showThinking?: boolean;
  /** 流式卡思考/工具块各保留最近 N 个（默认 5） */
  streamKeepPerKind?: number;
  /** 完整回复后隐藏思考/工具/todos 折叠块（默认 true） */
  hideThinkingOnFinish?: boolean;
}

/** Daemon 上报的通道状态 */
export interface ChannelStatusInfo {
  id: string;
  name: string;
  type: "feishu" | "wechat";
  connected: boolean;
  /** wechat: disconnected/qr_pending/logging_in/connected/error；feishu: connected/connecting */
  status: string;
  mainUserBound: boolean;
  /** 飞书机器人应用名（app_name，群内显示名） */
  botName?: string;
}

// ── chatKey：全局唯一聊天标识 `${channelId}|${rawChatId}` ──

export const CHAT_KEY_SEP = "|";

export function makeChatKey(channelId: string, chatId: string): string {
  if (!channelId) return chatId;
  return `${channelId}${CHAT_KEY_SEP}${chatId}`;
}

export function parseChatKey(chatKey: string): { channelId?: string; chatId: string } {
  const idx = chatKey.indexOf(CHAT_KEY_SEP);
  if (idx > 0 && chatKey.startsWith("ch_")) {
    return { channelId: chatKey.slice(0, idx), chatId: chatKey.slice(idx + 1) };
  }
  return { chatId: chatKey };
}

/** 从 sessionKey（`chatKey` 或 `chatKey::workspaceDir`）提取 chatKey 部分 */
export function chatIdFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf("::");
  return idx > 0 ? sessionKey.slice(0, idx) : sessionKey;
}

/** 从 sessionKey（`chatKey` 或 `chatKey::workspaceDir`）解析 channelId */
export function channelIdFromSessionKey(sessionKey: string): string | undefined {
  return parseChatKey(chatIdFromSessionKey(sessionKey)).channelId;
}

/** 从 sessionKey 提取 `::` 后缀的工作目录；仅路径形态有效（排除 wf_xxx 等非路径后缀） */
export function workspaceDirFromSessionKey(sessionKey: string): string | undefined {
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return undefined;
  const dir = sessionKey.slice(idx + 2);
  return dir && /[\\/]/.test(dir) ? dir : undefined;
}

/**
 * 规范化会话 key：盘符路径上的重复反斜杠压成单个（防 JSON/环境变量双重转义导致队列目录分裂）。
 * 特殊后缀（wf_/project_/裸 temp_ 等）不动。
 */
export function normalizeSessionKey(sessionKey: string | undefined | null): string {
  if (!sessionKey) return "";
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return sessionKey;
  const prefix = sessionKey.slice(0, idx + 2);
  let suffix = sessionKey.slice(idx + 2);
  if (!suffix) return sessionKey;
  if (suffix.startsWith("wf_") || suffix.startsWith("project_")) return sessionKey;
  if (!/[\\/]/.test(suffix) && !/^[A-Za-z]:/.test(suffix)) return sessionKey;
  // Windows 盘符路径：D:\\foo → D:\foo；保留开头的 UNC \\server 为两个反斜杠
  if (/^[A-Za-z]:/.test(suffix)) {
    suffix = suffix.replace(/\\+/g, "\\");
  } else if (suffix.startsWith("\\\\")) {
    suffix = "\\\\" + suffix.slice(2).replace(/\\+/g, "\\");
  } else {
    suffix = suffix.replace(/\\+/g, "\\");
  }
  return prefix + suffix;
}
