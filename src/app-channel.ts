// ── 应用内对话通道：聊天记录存储与出站落地 ─────────────────────────────────
// Daemon 的各出站接口对 app 通道只做委托，所有内容落成 AppChatItem，
// 先写入本机 JSONL 再通过 emit 推给界面。不经过任何外部消息服务。

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { channelIdFromSessionKey } from "./shared/channel-types.js";
import { formatQuestionBatchSummary } from "./shared/question-summary.js";
import { withdrawOutcome, type WithdrawResult } from "./shared/question-withdraw.js";
import { appChatImageMime, MAX_APP_CHAT_IMAGE_BYTES } from "./shared/app-chat-image.js";
import {
  appChatSessionId,
  chatItemInsertIndex,
  isQueuedUserItem,
  overlayInlineBlocks,
  type AppChatAssistantItem,
  type AppChatButton,
  type AppChatEvent,
  type AppChatInlineBlock,
  type AppChatItem,
  type AppChatQuestionItem,
  type AppChatSegment,
  type AppChatTool,
  type AppChatUserItem,
} from "./shared/app-chat-types.js";

const MAX_ITEMS_PER_SESSION = 1000;
const PERSIST_DEBOUNCE_MS = 1000;
const CLOSED_CARD_MEMORY = 8;
/** 会话的图片目录 = 记录文件名去掉 .jsonl 再加这个后缀，放在同一个通道目录里 */
const IMAGE_DIR_SUFFIX = ".images";

/**
 * 还没收口的回合卡。卡上的 segments 每次流式更新都整体替换，所以原样的流式输出另存一份（streamed），
 * Agent 在回合中途发的问题、图片、文件、文字记在 inlines 里，每次更新后重新叠到对应位置。
 */
interface LiveCard {
  id: string;
  streamed: AppChatSegment[];
  inlines: AppChatInlineBlock[];
}

interface SessionEntry {
  sessionKey: string;
  file: string;
  /** 这个会话的图片目录：紧挨着记录文件，和记录同生命周期 */
  imageDir: string;
  items: AppChatItem[];
  timer: NodeJS.Timeout | null;
  live?: LiveCard;
  /** 已收口的卡 id：旧回合的迟到 update 据此判定作废 */
  closedCardIds: string[];
}

export interface StreamCardResult {
  cardId?: string;
  /** 该卡已被收口或被新卡取代，调用方应丢弃本队列 */
  gone?: boolean;
  hasReply: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toTool(raw: unknown): AppChatTool {
  const t = (raw ?? {}) as Record<string, unknown>;
  return {
    name: str(t.name),
    status: str(t.status),
    ...(typeof t.summary === "string" ? { summary: t.summary } : {}),
    ...(typeof t.ms === "number" ? { ms: t.ms } : {}),
  };
}

/** 流式载荷 → 界面分段；飞书专有的段（如内联问题块）一律丢弃 */
export function toAppChatSegments(raw: unknown): AppChatSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: AppChatSegment[] = [];
  for (const entry of raw) {
    const seg = (entry ?? {}) as Record<string, unknown>;
    if (seg.type === "thinking") {
      out.push({ type: "thinking", text: str(seg.text), ...(typeof seg.ms === "number" ? { ms: seg.ms } : {}) });
    } else if (seg.type === "tools") {
      out.push({ type: "tools", tools: Array.isArray(seg.tools) ? seg.tools.map(toTool) : [] });
    } else if (seg.type === "reply") {
      out.push({ type: "reply", text: str(seg.text) });
    } else if (seg.type === "todos") {
      const items = Array.isArray(seg.items) ? seg.items : [];
      out.push({
        type: "todos",
        items: items.map((i) => ({ content: str((i as Record<string, unknown>)?.content), status: str((i as Record<string, unknown>)?.status) })),
      });
    }
  }
  return out;
}

function hasReplyText(segments: AppChatSegment[]): boolean {
  return segments.some((s) => s.type === "reply" && s.text.trim().length > 0);
}

/** 还没交给 Agent 的问题：没选的，和已选但在等这一轮结束、或等其余问题的 */
function isUndeliveredQuestion(item: AppChatItem): item is AppChatQuestionItem {
  return item.kind === "question" && !item.closedNote && (!item.answered || item.held === true);
}

/** 同一轮问的、还没交给 Agent 的问题：一起选完、一起交出 */
function undeliveredOfRound(items: readonly AppChatItem[], round: string | undefined): AppChatQuestionItem[] {
  return items.filter((i): i is AppChatQuestionItem => isUndeliveredQuestion(i) && i.round === round);
}

function withoutHeld(item: AppChatQuestionItem): AppChatQuestionItem {
  const next = { ...item };
  delete next.held;
  return next;
}

/**
 * answerQuestion 的结果。deliver 有值 = 这一组问题全选完、且这一轮已结束，要把这段文本交给 Agent；
 * 没有 = 先记下这个选择，还在等其余问题或这一轮结束。
 */
export type AnswerQuestionResult = { ok: false } | { ok: true; deliver?: string };

/** 一组选完、等到这一轮结束才交出的答案：text 交给 Agent，anchorId 是这组里一道题的 messageId，用来把消息路由回原会话 */
export interface ReadyAnswers {
  text: string;
  anchorId: string;
}

/** 路径比较用的规整形式：绝对化、统一大小写（Windows / macOS 默认大小写不敏感，和 referencesPath 一致） */
function pathKey(p: string): string {
  return path.resolve(p).toLowerCase();
}

/** 记录里引用的图片路径：用户发的图和 AI 发的图 */
function imagePathsOf(items: readonly AppChatItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "image") out.push(item.path);
    else if (item.kind === "user" && item.images) out.push(...item.images);
  }
  return out;
}

function isInsideDir(dir: string, target: string): boolean {
  return pathKey(target).startsWith(pathKey(dir) + path.sep);
}

/** 目录占用的字节数（含子目录） */
function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirBytes(full) : fs.statSync(full).size;
    } catch { /* 读的时候被删了，不计 */ }
  }
  return total;
}

/** 重启后内存里没有活卡：未收口的回合一律视为已结束 */
function readItems(file: string): AppChatItem[] {
  if (!fs.existsSync(file)) return [];
  const items: AppChatItem[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as AppChatItem;
      if (!item?.id || !item.kind) continue;
      items.push(item.kind === "assistant" ? { ...item, finished: true } : item);
    } catch { /* 跳过损坏行 */ }
  }
  return items;
}

/** 投递记录的标题最多多少字；超出的靠折叠的全文看 */
const DELIVERED_TITLE_MAX_CHARS = 80;

/**
 * 交给 Agent 的一条消息在聊天流里怎么显示：第一行当标题，标题以外的部分当折叠的全文，只有一行且不长就没有全文。
 * 第一行太长被截断时，标题显示不全，全文就是完整的整段。
 */
export function deliveredNoticeParts(text: string): { text: string; detail?: string } {
  const full = text.trim();
  const firstLineEnd = full.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? full : full.slice(0, firstLineEnd).trim();
  if (firstLine.length > DELIVERED_TITLE_MAX_CHARS) return { text: `${firstLine.slice(0, DELIVERED_TITLE_MAX_CHARS)}…`, detail: full };
  return firstLineEnd === -1 ? { text: full } : { text: firstLine, detail: full.slice(firstLineEnd).trim() };
}

export class AppChat {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly rootDir: string,
    private readonly emit: (event: AppChatEvent) => void,
    /** 题目所属的那一轮是否已结束。没接轮次记录时（单独使用、测试）题目一律算已结束 */
    private readonly isRoundEnded: (sessionKey: string, round: string | undefined) => boolean = () => true,
  ) {}

  private channelDir(channelId: string): string {
    return path.join(this.rootDir, channelId);
  }

  private entry(sessionKey: string): SessionEntry {
    const id = appChatSessionId(sessionKey);
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const channelId = channelIdFromSessionKey(sessionKey) ?? "_";
    const stem = path.join(this.channelDir(channelId), createHash("sha1").update(id).digest("hex").slice(0, 16));
    const file = `${stem}.jsonl`;
    const created: SessionEntry = { sessionKey, file, imageDir: `${stem}${IMAGE_DIR_SUFFIX}`, items: readItems(file), timer: null, closedCardIds: [] };
    this.sessions.set(id, created);
    this.pruneOrphanImages(created);
    return created;
  }

  /**
   * 图片目录里记录没引用的文件一律删掉：收进图片之后、记录落盘之前进程退出，会留下没人要的图。
   * 只在会话第一次载入时做一次，此时本进程还没往里收过图，不会误删刚收进来的。
   */
  private pruneOrphanImages(entry: SessionEntry): void {
    let names: string[];
    try {
      names = fs.readdirSync(entry.imageDir);
    } catch {
      return;
    }
    const keep = new Set(imagePathsOf(entry.items).map(pathKey));
    for (const name of names) {
      const full = path.join(entry.imageDir, name);
      if (!keep.has(pathKey(full))) fs.rmSync(full, { recursive: true, force: true });
    }
    this.removeImageDirIfEmpty(entry);
  }

  private removeImageDirIfEmpty(entry: SessionEntry): void {
    try {
      fs.rmdirSync(entry.imageDir);
    } catch { /* 还有图片，或本来就没有这个目录 */ }
  }

  /** 记录里不再引用的图片（被删的记录、被挤出上限的旧记录）一并删掉；还被别的记录引用的、不在会话图片目录里的不碰 */
  private releaseImages(entry: SessionEntry, removed: readonly AppChatItem[]): void {
    const candidates = new Map<string, string>();
    for (const p of imagePathsOf(removed)) {
      if (isInsideDir(entry.imageDir, p)) candidates.set(pathKey(p), path.resolve(p));
    }
    if (candidates.size === 0) return;
    for (const p of imagePathsOf(entry.items)) candidates.delete(pathKey(p));
    for (const full of candidates.values()) fs.rmSync(full, { force: true });
    this.removeImageDirIfEmpty(entry);
  }

  private schedulePersist(entry: SessionEntry): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.persist(entry);
    }, PERSIST_DEBOUNCE_MS);
  }

  private persist(entry: SessionEntry): void {
    if (entry.items.length === 0) {
      fs.rmSync(entry.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(entry.file), { recursive: true });
    const tmp = `${entry.file}.tmp`;
    fs.writeFileSync(tmp, entry.items.map((i) => JSON.stringify(i)).join("\n") + "\n", "utf-8");
    fs.renameSync(tmp, entry.file);
  }

  /** 退出前同步落盘所有待写会话 */
  flush(): void {
    for (const entry of this.sessions.values()) {
      if (!entry.timer) continue;
      clearTimeout(entry.timer);
      entry.timer = null;
      this.persist(entry);
    }
  }

  private upsert(entry: SessionEntry, item: AppChatItem): AppChatItem {
    const idx = entry.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) entry.items[idx] = item;
    else entry.items.splice(chatItemInsertIndex(entry.items, item.ts), 0, item);
    if (entry.items.length > MAX_ITEMS_PER_SESSION) {
      this.releaseImages(entry, entry.items.splice(0, entry.items.length - MAX_ITEMS_PER_SESSION));
    }
    this.schedulePersist(entry);
    this.emit({ type: "item", sessionKey: entry.sessionKey, item });
    return item;
  }

  list(sessionKey: string): AppChatItem[] {
    return [...this.entry(sessionKey).items];
  }

  /** 最近一条记录的时间；会话没有记录时为 undefined */
  lastActiveAt(sessionKey: string): number | undefined {
    return this.entry(sessionKey).items.at(-1)?.ts;
  }

  /**
   * 这个会话的记录里是不是出现过这个文件/图片路径（回复里的文件、图片，用户发的图片）。
   * 手机端取每张图、每个文件之前都要校验一次：在这里直接查，不用把整段历史（大会话几 MB）拉过去再逐条比。
   */
  referencesPath(sessionKey: string, targetPath: string): boolean {
    if (!targetPath) return false;
    const same = (p: string) => path.resolve(p).toLowerCase() === path.resolve(targetPath).toLowerCase();
    return this.entry(sessionKey).items.some((item) =>
      ((item.kind === "file" || item.kind === "image") && same(item.path)) ||
      (item.kind === "user" && !!item.images?.some(same)),
    );
  }

  /** queued=true：Agent 正在干活，这条消息要排队，界面放进暂存区而不是聊天流 */
  addUser(sessionKey: string, id: string, text: string, images?: string[], queued?: boolean): void {
    this.upsert(this.entry(sessionKey), {
      kind: "user", id, ts: Date.now(), text,
      ...(images?.length ? { images } : {}),
      ...(queued ? { queued: true } : {}),
    });
  }

  /** Agent 正在干活：有还没收口的回合卡。此时发来的消息要排队，等这一回合结束再投递 */
  hasLiveTurn(sessionKey: string): boolean {
    return this.entry(sessionKey).live !== undefined;
  }

  /** 暂存区里的某条消息；已投递（或不存在）返回 undefined */
  queuedItem(sessionKey: string, id: string): AppChatUserItem | undefined {
    const hit = this.entry(sessionKey).items.find((i) => i.id === id);
    return hit && isQueuedUserItem(hit) ? hit : undefined;
  }

  hasQueued(sessionKey: string): boolean {
    return this.entry(sessionKey).items.some(isQueuedUserItem);
  }

  /** 已投递给 Agent：清掉排队标记，消息按它原来的位置进入聊天流（它本来就排在当前回合之后、下一回合之前） */
  markDelivered(sessionKey: string, ids: string[]): void {
    if (ids.length === 0) return;
    const entry = this.entry(sessionKey);
    const wanted = new Set(ids);
    for (const item of [...entry.items]) {
      if (!isQueuedUserItem(item) || !wanted.has(item.id)) continue;
      const { queued: _queued, ...delivered } = item;
      this.upsert(entry, delivered);
    }
  }

  /**
   * 「立即发送」：暂存区里的消息马上进聊天流，不等 Agent 领走。返回放出来的条数。
   * 只改界面上的位置：消息还在真实队列里，打断完成后 Agent 照常领走（那时 markDelivered 已经无事可做）。
   * 位置不变——它们本来就排在当前回合之后、下一回合之前，和 `/f` 直接上屏的消息落点一致。
   */
  releaseQueued(sessionKey: string): number {
    const ids = this.entry(sessionKey).items.filter(isQueuedUserItem).map((i) => i.id);
    this.markDelivered(sessionKey, ids);
    return ids.length;
  }

  /** 暂存区里编辑一条排队消息的正文；已投递返回 false */
  editQueuedText(sessionKey: string, id: string, text: string): boolean {
    const hit = this.queuedItem(sessionKey, id);
    if (!hit) return false;
    this.upsert(this.entry(sessionKey), { ...hit, text });
    return true;
  }

  /** 移除一条记录并通知界面 */
  removeItem(sessionKey: string, id: string): boolean {
    const entry = this.entry(sessionKey);
    const idx = entry.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const [removed] = entry.items.splice(idx, 1);
    this.releaseImages(entry, [removed]);
    this.schedulePersist(entry);
    this.emit({ type: "remove", sessionKey: entry.sessionKey, itemId: id });
    return true;
  }

  /** 排队的消息被丢弃（停止并清空队列等）：暂存区里的对应记录一并移除；ids 缺省为全部排队消息 */
  dropQueued(sessionKey: string, ids?: string[]): number {
    const entry = this.entry(sessionKey);
    const wanted = ids ? new Set(ids) : undefined;
    let dropped = 0;
    for (const item of [...entry.items]) {
      if (!isQueuedUserItem(item) || (wanted && !wanted.has(item.id))) continue;
      if (this.removeItem(sessionKey, item.id)) dropped++;
    }
    return dropped;
  }

  /**
   * 与真实队列对账：标着排队、但队列里已经没有这条待投递消息的，当作已投递处理。
   * 兜底「投递后 1 秒内崩溃没落盘」「队列被别处清掉」等情况，免得暂存区里留着永远不会出去的消息。
   */
  reconcileQueued(sessionKey: string, pendingIds: Set<string>): void {
    const entry = this.entry(sessionKey);
    const stale = entry.items.filter((i) => isQueuedUserItem(i) && !pendingIds.has(i.id)).map((i) => i.id);
    this.markDelivered(sessionKey, stale);
  }

  addText(sessionKey: string, text: string): void {
    this.upsert(this.entry(sessionKey), { kind: "text", id: randomUUID(), ts: Date.now(), text });
  }

  /**
   * 把一块挂进当前回合卡的当前位置（流式输出此刻已有的段数处）。
   * 没有回合卡（Agent 不在回合中）返回 false，调用方自己落成独立记录。
   */
  private inlineIntoLiveCard(entry: SessionEntry, segment: AppChatSegment): boolean {
    const live = entry.live;
    const card = live ? this.findAssistant(entry, live.id) : undefined;
    if (!live || !card) return false;
    live.inlines.push({ insertAt: live.streamed.length, segment });
    this.upsert(entry, { ...card, segments: overlayInlineBlocks(live.streamed, live.inlines) });
    return true;
  }

  /**
   * 落一条独立记录；inline=true 且有回合卡时，卡里同时引用它（记录本身仍在，答题、搜索、转存都认它）。
   * 先让卡引用它、再落记录：界面先收到卡、再收到记录，这条记录不会先单独出现在末尾、又被收进卡里。
   */
  private place(entry: SessionEntry, item: AppChatItem, inline: boolean): void {
    if (inline) this.inlineIntoLiveCard(entry, { type: "item", itemId: item.id });
    this.upsert(entry, item);
  }

  addNotice(sessionKey: string, text: string, buttons?: AppChatButton[]): void {
    this.upsert(this.entry(sessionKey), {
      kind: "notice", id: randomUUID(), ts: Date.now(), text,
      ...(buttons?.length ? { buttons } : {}),
    });
  }

  /**
   * 交给 Agent 的消息里，聊天流里还没有对应记录的（定时任务的触发和结果、项目步骤、新会话的第一条等）：补一条提示。
   * 记录 id 就是消息 id：已有记录的（用户在界面发的）不动，重投也不会重复。
   */
  recordDelivered(sessionKey: string, messages: ReadonlyArray<{ messageId: string; text: string }>): void {
    const entry = this.entry(sessionKey);
    for (const m of messages) {
      if (entry.items.some((i) => i.id === m.messageId)) continue;
      this.upsert(entry, { kind: "notice", id: m.messageId, ts: Date.now(), ...deliveredNoticeParts(m.text) });
    }
  }

  /** inline=true：Agent 在回合中发的，有回合卡就显示在卡里它发的那个位置；没有回合卡时落成独立记录 */
  addImage(sessionKey: string, imagePath: string, inline = false): void {
    this.place(this.entry(sessionKey), { kind: "image", id: randomUUID(), ts: Date.now(), path: this.adoptImage(sessionKey, imagePath) }, inline);
  }

  /**
   * 把图片收进这个会话自己的目录，返回收进去之后的路径。
   * 对话里的图片只存路径：原来放在系统临时目录、或 AI 随手生成的位置，被清理 / 被删就成了「图片不可用」。
   * 收进来之后和会话记录同生命周期：会话清空、删除、旧记录被挤出上限时一起删。
   * 每次都是独立的一份：同一个路径被重新生成后再发，旧消息里的图不能跟着变。
   * 不是图片格式 / 超过大小上限 / 文件不在 / 复制失败：原样返回原路径，不挡发送。
   */
  adoptImage(sessionKey: string, source: string): string {
    if (!source || !appChatImageMime(source)) return source;
    const entry = this.entry(sessionKey);
    if (isInsideDir(entry.imageDir, source)) return source;
    let dest = "";
    try {
      const st = fs.statSync(source);
      if (!st.isFile() || st.size > MAX_APP_CHAT_IMAGE_BYTES) return source;
      fs.mkdirSync(entry.imageDir, { recursive: true });
      const { name, ext } = path.parse(source);
      dest = path.join(entry.imageDir, `${name.slice(0, 60)}_${randomUUID().slice(0, 8)}${ext}`);
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (e: unknown) {
      // 撞名（EEXIST）说明那个文件不是这次复制的，不能删；其余失败清掉没复制完整的半成品
      if (dest && (e as NodeJS.ErrnoException)?.code !== "EEXIST") fs.rmSync(dest, { force: true });
      this.removeImageDirIfEmpty(entry);
      return source;
    }
  }

  adoptImages(sessionKey: string, sources: readonly string[]): string[] {
    return sources.map((p) => this.adoptImage(sessionKey, p));
  }

  addFile(sessionKey: string, filePath: string, inline = false): void {
    this.place(this.entry(sessionKey), {
      kind: "file", id: randomUUID(), ts: Date.now(), path: filePath, name: path.basename(filePath),
    }, inline);
  }

  /**
   * 返回问题的 messageId，调用方据此登记消息路由。
   * round 是问这道题时 Agent 所在的那一轮；不传 = 不参与轮次（选完就交，用户打字随时可关）。
   * no 是这道题在那一轮里的题号，Agent 凭它撤回这道题。
   * 参与轮次的题就是 Agent 在回合中发的：有回合卡就显示在卡里它发的那个位置。
   */
  addQuestion(sessionKey: string, text: string, options: string[], multi = false, round?: string, no?: number): string {
    const messageId = `app_q_${randomUUID()}`;
    this.place(this.entry(sessionKey), {
      kind: "question", id: messageId, ts: Date.now(), messageId, text, options,
      ...(multi ? { multi: true } : {}),
      ...(round ? { round } : {}),
      ...(no !== undefined ? { no } : {}),
    }, !!round);
    return messageId;
  }

  /**
   * Agent 撤回自己这一轮发出的题：按题号找到、还没作答的关掉并标上说明，不交给 Agent。
   * 已作答（含已选、在等这一轮结束的）、已关闭、找不到的不动，结果里说明原因。
   */
  withdrawQuestions(sessionKey: string, round: string, nos: readonly number[], note: string): WithdrawResult[] {
    const entry = this.entry(sessionKey);
    return nos.map((no) => {
      const hit = entry.items.find((i): i is AppChatQuestionItem => i.kind === "question" && i.round === round && i.no === no);
      const outcome = withdrawOutcome(hit);
      if (hit && outcome === "withdrawn") this.upsert(entry, { ...hit, closedNote: note });
      return { no, outcome };
    });
  }

  /**
   * 选中一个选项：只记下，选完之前、这一轮结束之前都可以改选。
   * 同一轮问的题全部选完、且这一轮已结束，才把这一组一次交出去（返回的 deliver）；否则先留着（held）。
   * 问题不存在、已交出或已关闭返回 ok:false。
   *
   * 不同轮的题各是各的一组：用户打字会关掉已结束那一轮没选的题（并先交出已选的），
   * 所以不会有很久以前的残留问题把新一轮的答案卡住。
   * 交出的永远是带题干的问题和回答（一题也是），否则 Agent 对不上哪个答案属于哪个问题。
   */
  answerQuestion(sessionKey: string, messageId: string, option: string): AnswerQuestionResult {
    const entry = this.entry(sessionKey);
    const hit = entry.items.find((i) => i.id === messageId);
    if (!hit || !isUndeliveredQuestion(hit)) return { ok: false };
    // 多选题一项都没勾不算作答
    if (hit.multi && !option.trim()) return { ok: false };
    this.upsert(entry, { ...hit, answered: option, held: true });

    const deliver = this.takeGroupIfReady(sessionKey, entry, undeliveredOfRound(entry.items, hit.round));
    return deliver === undefined ? { ok: true } : { ok: true, deliver };
  }

  /**
   * Agent 进入等待（一轮结束）后调用：把已经选完、之前只是等这一轮结束的各组答案取出来。
   * 每组一条，由调用方投递给 Agent。
   */
  takeReadyAnswers(sessionKey: string): ReadyAnswers[] {
    const entry = this.entry(sessionKey);
    const rounds = new Set(entry.items.filter(isUndeliveredQuestion).map((q) => q.round));
    const ready: ReadyAnswers[] = [];
    for (const round of rounds) {
      const group = undeliveredOfRound(entry.items, round);
      const text = this.takeGroupIfReady(sessionKey, entry, group);
      if (text !== undefined) ready.push({ text, anchorId: group[0].messageId });
    }
    return ready;
  }

  /** 这一组全选完、且所属那一轮已结束：解除 held 并返回要交给 Agent 的文本；否则什么都不动 */
  private takeGroupIfReady(sessionKey: string, entry: SessionEntry, group: AppChatQuestionItem[]): string | undefined {
    if (group.length === 0 || group.some((q) => !q.answered)) return undefined;
    if (!this.isRoundEnded(sessionKey, group[0].round)) return undefined;
    for (const q of group) this.upsert(entry, withoutHeld(q));
    return formatQuestionBatchSummary(group);
  }

  /**
   * 用户没有把问题选完、而是直接打字发了消息：所属那一轮已结束、还没交出的题现在一并收口。
   * 已选的答案不能丢，带回答；没选的题关掉，在汇总里标成已关闭，让 Agent 知道这些卡已经失效。
   * 那一轮还在跑的题不动（用户可能还没看到这一轮后面发的题）。
   * 返回带题干的汇总文本，由调用方排在用户这条消息前面交给 Agent；没有这样的题返回 undefined。
   */
  closeEndedQuestions(sessionKey: string, note: string): string | undefined {
    const entry = this.entry(sessionKey);
    const ended = entry.items.filter(
      (i): i is AppChatQuestionItem => isUndeliveredQuestion(i) && this.isRoundEnded(sessionKey, i.round),
    );
    if (ended.length === 0) return undefined;
    for (const q of ended) this.upsert(entry, q.answered ? withoutHeld(q) : { ...q, closedNote: note });
    return formatQuestionBatchSummary(ended.map((q) => ({ text: q.text, answered: q.answered, closed: !q.answered })));
  }

  private findAssistant(entry: SessionEntry, id: string): AppChatAssistantItem | undefined {
    const hit = entry.items.find((i) => i.id === id);
    return hit?.kind === "assistant" ? hit : undefined;
  }

  /**
   * 新回合卡的时间戳。卡要等 Agent 的第一段输出才创建，而这之前用户可能已经在暂存区排了消息；
   * 那些消息属于下一回合，卡必须落在它们之前，否则「立即发送」后上一回合的回复会夹在它们中间。
   * 只看末尾那一段连续的排队消息：再往前的是已经投递过的，旧的残留标记不该把新卡顶到很早的位置。
   */
  private newCardTs(entry: SessionEntry): number {
    const now = Date.now();
    let firstQueued: AppChatUserItem | undefined;
    for (let i = entry.items.length - 1; i >= 0; i--) {
      const it = entry.items[i];
      if (it.kind === "assistant") break;
      if (it.kind !== "user") continue;
      if (!isQueuedUserItem(it)) break;
      firstQueued = it;
    }
    return firstQueued ? Math.min(now, firstQueued.ts - 1) : now;
  }

  private closeCard(entry: SessionEntry, cardId: string): void {
    if (entry.live?.id === cardId) entry.live = undefined;
    entry.closedCardIds = [...entry.closedCardIds, cardId].slice(-CLOSED_CARD_MEMORY);
  }

  /** 采用这次的流式输出（空的更新沿用上一份），返回叠上内联块之后卡上要显示的段落 */
  private refreshLive(live: LiveCard, streamed: AppChatSegment[]): AppChatSegment[] {
    if (streamed.length) live.streamed = streamed;
    return overlayInlineBlocks(live.streamed, live.inlines);
  }

  /** 对应 /api/agent-stream-card 的 ensure / update / finish */
  streamCard(
    sessionKey: string,
    action: "ensure" | "update" | "finish",
    rawSegments: unknown,
    opts: { cardId?: string; modelLabel?: string; interrupted?: boolean },
  ): StreamCardResult {
    const entry = this.entry(sessionKey);
    const segments = toAppChatSegments(rawSegments);

    if (action === "finish") {
      const live = entry.live;
      const targetId = live?.id ?? opts.cardId;
      const card = targetId ? this.findAssistant(entry, targetId) : undefined;
      if (!card) return { cardId: targetId, hasReply: hasReplyText(segments) };
      // 收口只认第一次：Agent 重新拉起（Resume）时会按记着的卡 id 再补发一次 finish，
      // 再盖一次 finishedAt，「耗时」就成了从这条回复到下一条消息的整段时间（几小时）。不是活卡的都算已收口
      if (card.finished || !live) return { cardId: card.id, hasReply: hasReplyText(card.segments) };
      const next: AppChatAssistantItem = {
        ...card,
        segments: this.refreshLive(live, segments),
        finished: true,
        finishedAt: Date.now(),
        ...(opts.modelLabel?.trim() ? { modelLabel: opts.modelLabel.trim() } : {}),
        ...(opts.interrupted ? { interrupted: true } : {}),
      };
      this.upsert(entry, next);
      this.closeCard(entry, card.id);
      return { cardId: card.id, hasReply: hasReplyText(next.segments) };
    }

    if (opts.cardId && entry.closedCardIds.includes(opts.cardId)) return { gone: true, hasReply: false };
    if (entry.live && opts.cardId && opts.cardId !== entry.live.id) {
      return { gone: true, cardId: entry.live.id, hasReply: false };
    }

    const live = entry.live;
    const card = live ? this.findAssistant(entry, live.id) : undefined;
    if (live && card) {
      const next: AppChatAssistantItem = { ...card, segments: this.refreshLive(live, segments) };
      this.upsert(entry, next);
      return { cardId: next.id, hasReply: hasReplyText(next.segments) };
    }
    const created: AppChatAssistantItem = { kind: "assistant", id: randomUUID(), ts: this.newCardTs(entry), segments, finished: false };
    entry.live = { id: created.id, streamed: segments, inlines: [] };
    this.upsert(entry, created);
    return { cardId: created.id, hasReply: hasReplyText(created.segments) };
  }

  clearSession(sessionKey: string): void {
    const entry = this.entry(sessionKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.items = [];
    if (entry.live) this.closeCard(entry, entry.live.id);
    fs.rmSync(entry.file, { force: true });
    fs.rmSync(entry.imageDir, { recursive: true, force: true });
    this.emit({ type: "clear", sessionKey: entry.sessionKey });
  }

  clearChannel(channelId: string): void {
    for (const [id, entry] of this.sessions) {
      if (channelIdFromSessionKey(entry.sessionKey) !== channelId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.sessions.delete(id);
    }
    fs.rmSync(this.channelDir(channelId), { recursive: true, force: true });
    this.emit({ type: "clear", channelId });
  }

  /** 通道聊天记录占用的磁盘字节数（含会话里的图片；尚未落盘的会话不计） */
  usageBytes(channelId: string): number {
    return dirBytes(this.channelDir(channelId));
  }
}
