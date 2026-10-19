// ── 应用内对话通道：聊天记录存储与出站落地 ─────────────────────────────────
// Daemon 的各出站接口对 app 通道只做委托，所有内容落成 AppChatItem，
// 先写入本机 JSONL 再通过 emit 推给界面。不经过任何外部消息服务。

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { channelIdFromSessionKey } from "./shared/channel-types.js";
import {
  appChatSessionId,
  type AppChatAssistantItem,
  type AppChatButton,
  type AppChatEvent,
  type AppChatItem,
  type AppChatQuestionItem,
  type AppChatSegment,
  type AppChatTool,
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
    else entry.items.push(item);
    if (entry.items.length > MAX_ITEMS_PER_SESSION) entry.items.splice(0, entry.items.length - MAX_ITEMS_PER_SESSION);
    this.schedulePersist(entry);
    this.emit({ type: "item", sessionKey: entry.sessionKey, item });
    return item;
  }

  list(sessionKey: string): AppChatItem[] {
    return [...this.entry(sessionKey).items];
  }

  addUser(sessionKey: string, id: string, text: string, images?: string[]): void {
    this.upsert(this.entry(sessionKey), { kind: "user", id, ts: Date.now(), text, ...(images?.length ? { images } : {}) });
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
  addQuestion(sessionKey: string, text: string, options: string[]): string {
    const messageId = `app_q_${randomUUID()}`;
    this.upsert(this.entry(sessionKey), { kind: "question", id: messageId, ts: Date.now(), messageId, text, options });
    return messageId;
  }

  /** 选中一个选项；问题不存在或已作答/已关闭返回 false */
  answerQuestion(sessionKey: string, messageId: string, option: string): boolean {
    const entry = this.entry(sessionKey);
    const hit = entry.items.find((i) => i.id === messageId);
    if (!hit || !isOpenQuestion(hit)) return false;
    this.upsert(entry, { ...hit, answered: option });
    return true;
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

  private closeCard(entry: SessionEntry, cardId: string): void {
    if (entry.liveCardId === cardId) entry.liveCardId = undefined;
    entry.closedCardIds = [...entry.closedCardIds, cardId].slice(-CLOSED_CARD_MEMORY);
  }

  /** 对应 /api/agent-stream-card 的 ensure / update / finish */
  streamCard(
    sessionKey: string,
    action: "ensure" | "update" | "finish",
    rawSegments: unknown,
    opts: { cardId?: string; modelLabel?: string },
  ): StreamCardResult {
    const entry = this.entry(sessionKey);
    const segments = toAppChatSegments(rawSegments);

    if (action === "finish") {
      const targetId = entry.liveCardId ?? opts.cardId;
      const live = targetId ? this.findAssistant(entry, targetId) : undefined;
      if (!live) return { cardId: targetId, hasReply: hasReplyText(segments) };
      const next: AppChatAssistantItem = {
        ...live,
        segments: segments.length ? segments : live.segments,
        finished: true,
        ...(opts.modelLabel?.trim() ? { modelLabel: opts.modelLabel.trim() } : {}),
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
      : { kind: "assistant", id: randomUUID(), ts: Date.now(), segments, finished: false };
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
