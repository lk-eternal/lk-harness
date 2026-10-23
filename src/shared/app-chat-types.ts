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
  /**
   * 排队中：Agent 正在干活时发出、还没投递给 Agent 的消息。
   * 界面把它放在输入框上方的暂存区（可编辑/删除/立即发送），不进聊天流；投递后该字段清掉，才按原位置进入聊天流。
   */
  queued?: boolean;
}

/** 一个回合的流式输出；segments 每次更新整体替换 */
export interface AppChatAssistantItem extends AppChatItemBase {
  kind: "assistant";
  segments: AppChatSegment[];
  finished: boolean;
  /** 回合收口的时间戳；耗时 = finishedAt - ts。收口前和重启时被判定结束的旧记录没有 */
  finishedAt?: number;
  modelLabel?: string;
  /** 回合没跑完就被收口（用户停止、切模型、重置、应用退出、worker 异常结束） */
  interrupted?: boolean;
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
  /** 某条记录被移除（暂存区里删除了排队消息） */
  | { type: "remove"; sessionKey: string; itemId: string }
  | { type: "clear"; sessionKey?: string; channelId?: string };

/** 暂存区里的消息：排队中、还没投递给 Agent 的用户消息 */
export function isQueuedUserItem(item: AppChatItem): item is AppChatUserItem {
  return item.kind === "user" && item.queued === true;
}

/** 聊天流里要显示的条目：排队中的消息只出现在暂存区 */
export function chatStreamItems(items: AppChatItem[]): AppChatItem[] {
  return items.some(isQueuedUserItem) ? items.filter((it) => !isQueuedUserItem(it)) : items;
}

/**
 * 新记录在列表里的落点：自尾部向前跳过 ts 比它大的记录。
 * 记录几乎总是按时间到达，落点就是末尾；唯一的例外是回合卡——它到 Agent 第一段输出时才创建，
 * 而这时暂存区里可能已经排了消息，卡的 ts 取在这些消息之前（见 AppChat.streamCard），让它落在它们前面。
 * 服务端落盘、桌面端、手机端都用这一条规则，顺序才不会各算各的。
 */
export function chatItemInsertIndex(items: readonly AppChatItem[], ts: number): number {
  let at = items.length;
  while (at > 0 && items[at - 1].ts > ts) at--;
  return at;
}

/** 把一批记录并入列表（不改原数组）：同 id 的原位替换（流式快照、状态变更），新的按 ts 就位 */
export function upsertChatItems(prev: readonly AppChatItem[], incoming: readonly AppChatItem[]): AppChatItem[] {
  if (incoming.length === 0) return prev as AppChatItem[];
  const next = prev.slice();
  for (const item of incoming) {
    let at = next.length - 1;
    while (at >= 0 && next[at].id !== item.id) at--;
    if (at >= 0) next[at] = item;
    else next.splice(chatItemInsertIndex(next, item.ts), 0, item);
  }
  return next;
}

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
  /** 新建的临时会话的会话键 */
  sessionKey?: string;
}

/** 会话在存储与比对里的统一标识：路径分隔符与大小写归一（Windows 路径混写不分裂） */
export function appChatSessionId(sessionKey: string): string {
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  return normalized.replace(/[\\/]+/g, "/").toLowerCase();
}
