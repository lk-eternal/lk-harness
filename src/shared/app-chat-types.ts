// ── 应用内对话通道：聊天条目与事件（Daemon / Electron / 渲染层共用）──────────────

import { normalizeSessionKey } from "./channel-types.js";

export interface AppChatTool {
  name: string;
  status: string;
  summary?: string;
  ms?: number;
}

export interface AppChatTodo {
  content: string;
  status: string;
}

/** 流式卡时间线分段（与 Electron 流式聚合的载荷同形，去掉飞书专有字段） */
export type AppChatSegment =
  | { type: "thinking"; text: string; ms?: number }
  | { type: "tools"; tools: AppChatTool[] }
  | { type: "reply"; text: string }
  | { type: "todos"; items: AppChatTodo[] };

/** 指令回执里的可点击项：点击等于发送 cmd */
export interface AppChatButton {
  label: string;
  cmd: string;
  section?: string;
}

interface AppChatItemBase {
  id: string;
  ts: number;
}

export interface AppChatUserItem extends AppChatItemBase {
  kind: "user";
  text: string;
  /** 本地图片绝对路径 */
  images?: string[];
}

/** 一个回合的流式输出；segments 每次更新整体替换 */
export interface AppChatAssistantItem extends AppChatItemBase {
  kind: "assistant";
  segments: AppChatSegment[];
  finished: boolean;
  modelLabel?: string;
}

/** send_text 等独立文本消息 */
export interface AppChatTextItem extends AppChatItemBase {
  kind: "text";
  text: string;
}

export interface AppChatQuestionItem extends AppChatItemBase {
  kind: "question";
  /** 同 id；回答时按它路由回原会话 */
  messageId: string;
  text: string;
  options: string[];
  answered?: string;
  closedNote?: string;
}

export interface AppChatImageItem extends AppChatItemBase {
  kind: "image";
  path: string;
}

export interface AppChatFileItem extends AppChatItemBase {
  kind: "file";
  path: string;
  name: string;
}

export interface AppChatNoticeItem extends AppChatItemBase {
  kind: "notice";
  text: string;
  buttons?: AppChatButton[];
}

export type AppChatItem =
  | AppChatUserItem
  | AppChatAssistantItem
  | AppChatTextItem
  | AppChatQuestionItem
  | AppChatImageItem
  | AppChatFileItem
  | AppChatNoticeItem;

export type AppChatEvent =
  | { type: "item"; sessionKey: string; item: AppChatItem }
  | { type: "clear"; sessionKey?: string; channelId?: string };

/** 界面 → 主进程的发送载荷：普通消息，或对某个问题的选择（questionId + option） */
export interface AppChatSendPayload {
  sessionKey: string;
  text?: string;
  /** 本地图片绝对路径（由 saveImage 落盘得到） */
  images?: string[];
  questionId?: string;
  option?: string;
}

export interface AppChatResult {
  ok: boolean;
  error?: string;
  items?: AppChatItem[];
  bytes?: number;
  /** 会话最近一条记录的时间戳，键为 appChatSessionId；没有记录的会话不出现 */
  times?: Record<string, number>;
}

/** 会话在存储与比对里的统一标识：路径分隔符与大小写归一（Windows 路径混写不分裂） */
export function appChatSessionId(sessionKey: string): string {
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  return normalized.replace(/[\\/]+/g, "/").toLowerCase();
}
