// ── 应用内对话通道：聊天条目与事件（Daemon / Electron / 渲染层共用）──────────────

import { normalizeSessionKey, workspaceDirFromSessionKey } from "./channel-types.js";
import { isTempChatWorkspace } from "./temp-workspace.js";

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
  /** 用户选的选项 */
  answered?: string;
  /**
   * 已选，但还没交给 Agent：同一轮有多个问题时，要全部选完才一起交出去。
   * 此时可以改选；交出去之后清掉这个标记，选择才锁定。没有这个字段的旧记录一律视为已交出。
   */
  held?: boolean;
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
  /** 历史分页：返回的这一页之前还有更早的记录（见 app-chat-history-page.ts）；整段历史时没有这个字段 */
  hasMore?: boolean;
  /** references-path：这个路径是不是出现在该会话的记录里 */
  owned?: boolean;
  bytes?: number;
  /** 会话最近一条记录的时间戳，键为 appChatSessionId；没有记录的会话不出现 */
  times?: Record<string, number>;
  /** 新建的临时会话的会话键 */
  sessionKey?: string;
}

/**
 * 对话页会话列表要显示的 tab：定时任务自己的会话（kind=task）不是对话会话，
 * 它的内容在任务执行里，进对话页只会显示成空会话，所以不列。
 */
export function visibleChatTabs<T extends { kind: string }>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.kind !== "task");
}

/** 会话在存储与比对里的统一标识：路径分隔符与大小写归一（Windows 路径混写不分裂） */
export function appChatSessionId(sessionKey: string): string {
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  return normalized.replace(/[\\/]+/g, "/").toLowerCase();
}

/**
 * 应用内会话的工作目录（给用户看的那个）：用户给会话选的目录（boundDir）优先；
 * 否则是会话键里的目录，但临时会话键里的目录只是它自己的临时文件夹，对用户不可见，视为没有指定目录。
 */
export function appChatSessionDir(sessionKey: string, boundDir?: string): string | undefined {
  if (boundDir) return boundDir;
  const dir = workspaceDirFromSessionKey(sessionKey);
  return isTempChatWorkspace(dir) ? undefined : dir;
}

/** 两个目录路径是不是同一个：分隔符、末尾斜杠、大小写都不算区别（Windows 路径混写不分裂） */
export function sameChatDir(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (d: string) => d.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 在会话里选目录会发生什么：还没开始的临时会话可以直接改它的目录（true）；
 * 已经开始的（SDK 续聊要求 cwd 不变）、或键里带真实目录的（目录就是会话身份）不能改，只能用该目录新开一个会话（false）。
 */
export function canRebindSessionDir(sessionKey: string, started: boolean): boolean {
  return !started && isTempChatWorkspace(workspaceDirFromSessionKey(sessionKey));
}

/** 在会话里选了一个目录之后要做什么（桌面端和手机端共用这一条规则） */
export type DirChoice = "same" | "rebind" | "new-session";

/** 已经是这个目录：什么都不做；会话还能改目录：改它；否则（已经开始、或目录是会话身份）：用该目录新开一个会话 */
export function planDirChoice(opts: {
  sessionKey: string;
  started: boolean;
  currentDir: string | undefined;
  chosen: string;
}): DirChoice {
  if (sameChatDir(opts.chosen, opts.currentDir)) return "same";
  return canRebindSessionDir(opts.sessionKey, opts.started) ? "rebind" : "new-session";
}

export interface ChatDirOption {
  name: string;
  dir: string;
}

/**
 * 目录菜单：通道里各会话在用的目录，去重后一个目录一项。
 * 目录不是会话的身份——同一个目录可以有多个会话，菜单里仍只列一次；还没选目录的临时会话不贡献选项。
 */
export function chatDirOptions<T extends { kind: string; sessionKey: string }>(
  tabs: readonly T[],
  boundDirOf: (tab: T) => string | undefined,
): ChatDirOption[] {
  const dirs: string[] = [];
  for (const t of tabs) {
    if (t.kind !== "main" && t.kind !== "dir") continue;
    const dir = appChatSessionDir(t.sessionKey, boundDirOf(t));
    if (dir && !dirs.some((d) => sameChatDir(d, dir))) dirs.push(dir);
  }
  return dirs.map((dir) => ({ name: dir.split(/[\\/]/).filter(Boolean).pop() ?? dir, dir }));
}

/**
 * 应用内会话在界面上叫什么（对话页的会话列表、工作台的会话清单共用这一条规则）：
 * 摘要标题（或手动改的名字）优先；还没有时，选了目录的会话显示目录名，没选目录的临时会话叫「新会话」，
 * 其它显示键里的目录名（不带「（主）」和分支）；
 * 连目录都取不到（项目、定时任务这类不是目录的会话）就用 fallback。
 */
export function appChatSessionName(
  sessionKey: string,
  titles: Readonly<Record<string, string>>,
  fallback?: string,
  boundDir?: string,
): string | undefined {
  const title = titles[appChatSessionId(sessionKey)];
  if (title) return title;
  const dir = boundDir || workspaceDirFromSessionKey(sessionKey);
  if (!boundDir && isTempChatWorkspace(dir)) return "新会话";
  return dir?.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
}
