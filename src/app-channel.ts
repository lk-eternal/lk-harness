// ── 应用内对话通道：聊天记录存储与出站落地 ─────────────────────────────────
// Daemon 的各出站接口对 app 通道只做委托，所有内容落成 AppChatItem，
// 先写入本机 JSONL 再通过 emit 推给界面。不经过任何外部消息服务。

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { channelIdFromSessionKey } from "./shared/channel-types.js";
import { formatQuestionBatchSummary } from "./shared/question-summary.js";
import {
  appChatSessionId,
  chatItemInsertIndex,
  isQueuedUserItem,
  type AppChatAssistantItem,
  type AppChatButton,
  type AppChatEvent,
  type AppChatItem,
  type AppChatQuestionItem,
  type AppChatSegment,
  type AppChatTool,
  type AppChatUserItem,
} from "./shared/app-chat-types.js";

const MAX_ITEMS_PER_SESSION = 1000;
const PERSIST_DEBOUNCE_MS = 1000;
const CLOSED_CARD_MEMORY = 8;

interface SessionEntry {
  sessionKey: string;
  file: string;
  items: AppChatItem[];
  timer: NodeJS.Timeout | null;
  liveCardId?: string;
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

function isOpenQuestion(item: AppChatItem): item is AppChatQuestionItem {
  return item.kind === "question" && !item.answered && !item.closedNote;
}

/** 还没交给 Agent 的问题：没选的，和已选但在等其余问题的 */
function isUndeliveredQuestion(item: AppChatItem): item is AppChatQuestionItem {
  return item.kind === "question" && !item.closedNote && (!item.answered || item.held === true);
}

function withoutHeld(item: AppChatQuestionItem): AppChatQuestionItem {
  const next = { ...item };
  delete next.held;
  return next;
}

/**
 * answerQuestion 的结果。deliver 有值 = 这一组问题全选完了，要把这段文本交给 Agent；
 * 没有 = 先记下这个选择，还在等其余问题。
 */
export type AnswerQuestionResult = { ok: false } | { ok: true; deliver?: string };

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

export class AppChat {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly rootDir: string,
    private readonly emit: (event: AppChatEvent) => void,
  ) {}

  private channelDir(channelId: string): string {
    return path.join(this.rootDir, channelId);
  }

  private entry(sessionKey: string): SessionEntry {
    const id = appChatSessionId(sessionKey);
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const channelId = channelIdFromSessionKey(sessionKey) ?? "_";
    const file = path.join(this.channelDir(channelId), `${createHash("sha1").update(id).digest("hex").slice(0, 16)}.jsonl`);
    const created: SessionEntry = { sessionKey, file, items: readItems(file), timer: null, closedCardIds: [] };
    this.sessions.set(id, created);
    return created;
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
    if (entry.items.length > MAX_ITEMS_PER_SESSION) entry.items.splice(0, entry.items.length - MAX_ITEMS_PER_SESSION);
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
    return this.entry(sessionKey).liveCardId !== undefined;
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
    entry.items.splice(idx, 1);
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

  addNotice(sessionKey: string, text: string, buttons?: AppChatButton[]): void {
    this.upsert(this.entry(sessionKey), {
      kind: "notice", id: randomUUID(), ts: Date.now(), text,
      ...(buttons?.length ? { buttons } : {}),
    });
  }

  addImage(sessionKey: string, imagePath: string): void {
    this.upsert(this.entry(sessionKey), { kind: "image", id: randomUUID(), ts: Date.now(), path: imagePath });
  }

  addFile(sessionKey: string, filePath: string): void {
    this.upsert(this.entry(sessionKey), {
      kind: "file", id: randomUUID(), ts: Date.now(), path: filePath, name: path.basename(filePath),
    });
  }

  /** 返回问题的 messageId，调用方据此登记消息路由 */
  addQuestion(sessionKey: string, text: string, options: string[], multi = false): string {
    const messageId = `app_q_${randomUUID()}`;
    this.upsert(this.entry(sessionKey), {
      kind: "question", id: messageId, ts: Date.now(), messageId, text, options,
      ...(multi ? { multi: true } : {}),
    });
    return messageId;
  }

  /**
   * 选中一个选项。同一会话里还有没选的问题时，这个选择先记下（held）、不交给 Agent，
   * 等全部选完才一次交出去；选完之前可以改选。问题不存在、已交出或已关闭返回 ok:false。
   *
   * 「同一组」就是这个会话里所有还没交出的问题：用户发消息会关掉没选的问题（并先交出已选的），
   * 所以不会有很久以前的残留问题把新一轮的答案卡住。
   * 只有一个问题时交出的是选项本身（和之前一致）；多个问题交出的是带题干的汇总，否则 Agent 对不上哪个答案属于哪个问题。
   */
  answerQuestion(sessionKey: string, messageId: string, option: string): AnswerQuestionResult {
    const entry = this.entry(sessionKey);
    const hit = entry.items.find((i) => i.id === messageId);
    if (!hit || !isUndeliveredQuestion(hit)) return { ok: false };
    // 多选题一项都没勾不算作答
    if (hit.multi && !option.trim()) return { ok: false };
    this.upsert(entry, { ...hit, answered: option, held: true });

    const group = entry.items.filter(isUndeliveredQuestion);
    if (group.some((q) => !q.answered)) return { ok: true };

    for (const q of group) this.upsert(entry, withoutHeld(q));
    return { ok: true, deliver: group.length === 1 ? option : formatQuestionBatchSummary(group) };
  }

  /**
   * 用户没有把问题选完、而是直接发了消息：已选但还没交出的答案不能丢，取出来先交给 Agent。
   * 返回带题干的汇总文本；没有这样的答案返回 undefined。要在 closeOpenQuestions 之前调用。
   */
  releaseHeldAnswers(sessionKey: string): string | undefined {
    const entry = this.entry(sessionKey);
    const held = entry.items.filter((i): i is AppChatQuestionItem => i.kind === "question" && i.held === true && !i.closedNote);
    if (held.length === 0) return undefined;
    for (const q of held) this.upsert(entry, withoutHeld(q));
    return formatQuestionBatchSummary(held);
  }

  closeOpenQuestions(sessionKey: string, note: string): void {
    const entry = this.entry(sessionKey);
    for (const item of [...entry.items]) {
      if (isOpenQuestion(item)) this.upsert(entry, { ...item, closedNote: note });
    }
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
    if (entry.liveCardId === cardId) entry.liveCardId = undefined;
    entry.closedCardIds = [...entry.closedCardIds, cardId].slice(-CLOSED_CARD_MEMORY);
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
      const targetId = entry.liveCardId ?? opts.cardId;
      const live = targetId ? this.findAssistant(entry, targetId) : undefined;
      if (!live) return { cardId: targetId, hasReply: hasReplyText(segments) };
      // 收口只认第一次：Agent 重新拉起（Resume）时会按记着的卡 id 再补发一次 finish，
      // 再盖一次 finishedAt，「耗时」就成了从这条回复到下一条消息的整段时间（几小时）
      if (live.finished) return { cardId: live.id, hasReply: hasReplyText(live.segments) };
      const next: AppChatAssistantItem = {
        ...live,
        segments: segments.length ? segments : live.segments,
        finished: true,
        finishedAt: Date.now(),
        ...(opts.modelLabel?.trim() ? { modelLabel: opts.modelLabel.trim() } : {}),
        ...(opts.interrupted ? { interrupted: true } : {}),
      };
      this.upsert(entry, next);
      this.closeCard(entry, live.id);
      return { cardId: live.id, hasReply: hasReplyText(next.segments) };
    }

    if (opts.cardId && entry.closedCardIds.includes(opts.cardId)) return { gone: true, hasReply: false };
    if (entry.liveCardId && opts.cardId && opts.cardId !== entry.liveCardId) {
      return { gone: true, cardId: entry.liveCardId, hasReply: false };
    }

    const live = entry.liveCardId ? this.findAssistant(entry, entry.liveCardId) : undefined;
    const next: AppChatAssistantItem = live
      ? { ...live, segments: segments.length ? segments : live.segments }
      : { kind: "assistant", id: randomUUID(), ts: this.newCardTs(entry), segments, finished: false };
    entry.liveCardId = next.id;
    this.upsert(entry, next);
    return { cardId: next.id, hasReply: hasReplyText(next.segments) };
  }

  clearSession(sessionKey: string): void {
    const entry = this.entry(sessionKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.items = [];
    if (entry.liveCardId) this.closeCard(entry, entry.liveCardId);
    fs.rmSync(entry.file, { force: true });
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

  /** 通道聊天记录占用的磁盘字节数（含尚未落盘的会话不计） */
  usageBytes(channelId: string): number {
    const dir = this.channelDir(channelId);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  }
}
