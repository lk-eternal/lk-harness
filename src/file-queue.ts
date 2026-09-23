import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { normalizeSessionKey } from "./shared/channel-types.js";
import { ensureSessionLayoutMigrated } from "./shared/session-layout-migrate.js";
import {
  ensureSessionEntry,
  legacyQueueDirId,
  listSessionQueueDirs,
  sessionQueueDir,
} from "./shared/session-entry-paths.js";

const POLL_INTERVAL_MS = 400;
const STALE_TMP_MS = 5 * 60 * 1000;

let queueDir = "";

export function initFileQueue(): string {
  const appDataDir = process.env.APP_DATA_DIR;
  if (!appDataDir) throw new Error("APP_DATA_DIR 环境变量未设置");
  ensureSessionLayoutMigrated(appDataDir);
  queueDir = path.join(appDataDir, "file-queue");
  if (!fs.existsSync(queueDir)) fs.mkdirSync(queueDir, { recursive: true });
  migrateDoubledPathSessions();
  return queueDir;
}

export function getQueueDir(): string {
  return queueDir;
}

function getSessionDir(sessionKey?: string): string {
  if (!sessionKey || !process.env.APP_DATA_DIR) return queueDir;
  const appDataDir = process.env.APP_DATA_DIR;
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  ensureSessionEntry(appDataDir, normalized);
  const sub = sessionQueueDir(appDataDir, normalized);
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
  return sub;
}

function legacyQueueSubdir(sessionKey: string): string {
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  return path.join(queueDir, legacyQueueDirId(normalized));
}

/** 把盘符路径被双重转义的会话目录合并到规范 key 目录，避免消息永久 pending */
function migrateDoubledPathSessions(): void {
  if (!queueDir) return;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(queueDir).filter((d) => fs.statSync(path.join(queueDir, d)).isDirectory());
  } catch {
    return;
  }
  for (const d of dirs) {
    const dir = path.join(queueDir, d);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg") || f.endsWith(".claimed"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(dir, f);
      let parsed: { sessionKey?: string; [k: string]: unknown };
      try {
        parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
      } catch {
        continue;
      }
      const sk = typeof parsed.sessionKey === "string" ? parsed.sessionKey : "";
      if (!sk) continue;
      const norm = normalizeSessionKey(sk);
      if (norm === sk) continue;
      parsed.sessionKey = norm;
      const destDir = getSessionDir(norm);
      const dest = path.join(destDir, f);
      try {
        fs.writeFileSync(fp, JSON.stringify(parsed), "utf-8");
        if (path.resolve(destDir) !== path.resolve(dir)) {
          if (fs.existsSync(dest)) fs.unlinkSync(fp);
          else fs.renameSync(fp, dest);
        }
      } catch { /* ignore */ }
    }
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }
}

/** 会话是否有过队列目录（探测不创建）：send 校验用——收过消息的会话必有目录 */
export function hasSessionQueueDir(sessionKey: string): boolean {
  if (!sessionKey || !process.env.APP_DATA_DIR) return false;
  const normalized = normalizeSessionKey(sessionKey) || sessionKey;
  const appDataDir = process.env.APP_DATA_DIR;
  if (fs.existsSync(sessionQueueDir(appDataDir, normalized))) return true;
  if (!queueDir) return false;
  return fs.existsSync(legacyQueueSubdir(normalized));
}

/** v2：仅 sessions/{entryId}/queue/，不扫 legacy file-queue 子目录 */
function queueMessageDirs(): string[] {
  if (!process.env.APP_DATA_DIR) return [];
  return listSessionQueueDirs(process.env.APP_DATA_DIR);
}

/** 入队时间戳单调递增：同毫秒内连续入队（如 skipDedup 重投同 messageId）文件名不冲突、不被覆盖 */
let lastPushTs = 0;

export function pushToFileQueue(text: string, messageId?: string, source?: string, sessionKey?: string, skipDedup?: boolean, meta?: QueueMessageMeta): boolean {
  if (!queueDir || !text?.trim()) return false;

  const normalizedKey = sessionKey ? (normalizeSessionKey(sessionKey) || sessionKey) : sessionKey;
  const dir = getSessionDir(normalizedKey);
  const ts = Math.max(Date.now(), lastPushTs + 1);
  lastPushTs = ts;
  const fileToken = messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const safeId = fileToken.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${ts}_${safeId}.qmsg`;

  if (messageId && !skipDedup) {
    try {
      const existing = fs.readdirSync(dir);
      if (existing.some((f) => (f.endsWith(".qmsg") || f.endsWith(".claimed")) && matchesSafeId(f, safeId))) {
        return false;
      }
    } catch { /* ignore */ }
  }

  try {
    const data = JSON.stringify({
      text, messageId: messageId || "", timestamp: ts,
      source: source || `pid-${process.pid}`,
      sessionKey: normalizedKey || "",
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    });
    const tmpPath = path.join(dir, filename + ".tmp");
    const finalPath = path.join(dir, filename);
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

export interface QueueMessageMeta {
  chatId?: string;
  chatType?: string;
  senderOpenId?: string;
  senderType?: string;
  quoted_message?: {
    message_id: string;
    sender_type: string;
    sender_open_id?: string;
    text: string;
  };
}

export interface QueueMessage {
  text: string;
  messageId: string;
  sessionKey: string;
  /** 入队时间戳（毫秒），按此升序投递；Agent 合并回复时取最大者确认整批 */
  timestamp: number;
  /** 消息上下文：会话类型、发送者、引用原文 */
  meta?: QueueMessageMeta;
}

function fileTimestamp(file: string): number {
  const ts = parseInt(path.basename(file).split("_")[0], 10);
  return Number.isNaN(ts) ? 0 : ts;
}

/** 文件名 `${ts}_${safeId}.ext` 是否精确对应该 safeId（避免 endsWith 的后缀歧义） */
function matchesSafeId(filename: string, safeId: string): boolean {
  const base = filename.replace(/\.\w+$/, "");
  const idx = base.indexOf("_");
  return idx >= 0 && base.slice(idx + 1) === safeId;
}

function parseMessageFile(filePath: string): QueueMessage | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const meta: QueueMessageMeta = { ...(parsed.meta || {}) };
    // 兼容旧格式：顶层 chatType/senderOpenId 收进 meta
    if (parsed.chatType && !meta.chatType) meta.chatType = parsed.chatType;
    if (parsed.senderOpenId && !meta.senderOpenId) meta.senderOpenId = parsed.senderOpenId;
    return {
      text: typeof parsed.text === "string" ? parsed.text : raw,
      messageId: parsed.messageId || "",
      sessionKey: parsed.sessionKey || parsed.chatId || "",
      timestamp: parsed.timestamp || fileTimestamp(filePath),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 领取并消费下一条消息：rename 原子占用 → 读取 → 立即删除。
 * 领取即消费，不可恢复。仅用于 drain/dequeue-all（electron 本地 CLI 调度）场景；
 * poll-message 路径请用 claimSessionMessages（领取不删，靠回复确认）。
 */
export function claimNextMessage(filterSessionKey?: string): QueueMessage | null {
  if (!queueDir) return null;

  const dir = getSessionDir(filterSessionKey);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).sort();
  } catch {
    return null;
  }

  for (const file of files) {
    const srcPath = path.join(dir, file);
    const claimedPath = srcPath.replace(/\.qmsg$/, ".claimed");
    // rename 是原子操作：并发领取时只有一个进程/请求能成功占用
    try {
      fs.renameSync(srcPath, claimedPath);
    } catch {
      continue;
    }
    const parsed = parseMessageFile(claimedPath);
    try { fs.unlinkSync(claimedPath); } catch { /* ignore */ }
    if (parsed) return parsed;
  }
  return null;
}

/** 会话目录下是否存在待投递的新消息（仅 .qmsg；.claimed 是处理中不算新，
 * 阻塞 poll 进入时已被隐式确认删除，不参与挂起判断） */
function hasNewMessages(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".qmsg"));
  } catch {
    return false;
  }
}

/**
 * 领取该会话所有未确认消息（不删除）：
 * 1. 把所有 .qmsg 改名为 .claimed（标记"已投递、待完成确认"）；
 * 2. 返回该会话全部 .claimed（含本次新投递的 + 历史未确认的），按 timestamp 升序。
 *
 * 消息在 Agent 下一次挂阻塞 poll 时隐式确认删除（Agent 干完手头活才会挂 poll）；
 * 未确认则下次领取重新投递，因此幽灵连接领走也不会丢——这是"至少一次"投递的核心。
 * 代价是 Resume 后可能重复投递已处理过的消息（上下文完整时 Agent 自行判断跳过）：重复优于丢失。
 */
export function claimSessionMessages(filterSessionKey?: string): QueueMessage[] {
  if (!queueDir) return [];
  const dir = getSessionDir(filterSessionKey);

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  for (const f of files) {
    if (!f.endsWith(".qmsg")) continue;
    const src = path.join(dir, f);
    try {
      fs.renameSync(src, path.join(dir, f.replace(/\.qmsg$/, ".claimed")));
    } catch { /* 并发已被领取，忽略 */ }
  }

  let claimed: string[];
  try {
    claimed = fs.readdirSync(dir).filter((f) => f.endsWith(".claimed")).sort();
  } catch {
    return [];
  }

  const now = new Date();
  const items: QueueMessage[] = [];
  for (const f of claimed) {
    const fp = path.join(dir, f);
    const parsed = parseMessageFile(fp);
    if (!parsed) continue;
    items.push(parsed);
    try { fs.utimesSync(fp, now, now); } catch { /* ignore */ }
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

/**
 * 阻塞领取：有待投递新消息（.qmsg）立即返回；否则挂起等待新消息。
 * 调用方（poll handler）应在进入前先 confirmClaimedMessages 清掉处理中消息。
 * timeoutMs: 0=不等待立即返回；<0=无限阻塞；>0=超时毫秒。
 */
export function waitForSessionMessages(
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
  filterSessionKey?: string,
  isCancelled?: () => boolean,
): Promise<QueueMessage[]> {
  return new Promise((resolve) => {
    const dir = getSessionDir(filterSessionKey);
    if (hasNewMessages(dir)) { resolve(claimSessionMessages(filterSessionKey)); return; }
    if (timeoutMs === 0) { resolve([]); return; }

    const infinite = timeoutMs < 0;
    const deadline = infinite ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (isCancelled?.()) { clearInterval(timer); resolve([]); return; }
      if (hasNewMessages(dir)) { clearInterval(timer); resolve(claimSessionMessages(filterSessionKey)); return; }
      if (!infinite && Date.now() >= deadline) { clearInterval(timer); resolve([]); }
    }, intervalMs);
    timer.unref();
  });
}

/**
 * 确认已投递消息完成：删除会话中的 .claimed 并返回其 messageId（用于打 DONE 表情）。
 * 主路径：Agent 挂阻塞 poll = 声明手头活全部干完，进入时自动确认全部 .claimed。
 * messageId 指定时删除「时间戳 ≤ 目标消息」的 .claimed。
 * 未投递的 .qmsg 永不删除。session_key 缺省时全局兜底。
 */
export function confirmClaimedMessages(
  messageId?: string,
  filterSessionKey?: string,
): string[] {
  if (!queueDir) return [];
  const safeId = messageId ? messageId.replace(/[^a-zA-Z0-9_-]/g, "_") : "";
  // 指定会话目录优先（快路径）；未命中时全局兜底——messageId 全局唯一，
  // 防止调用方 session_key 形态偏差（转义/大小写）导致标记静默失败、消息反复重投
  const dirs = [...new Set(filterSessionKey
    ? [getSessionDir(filterSessionKey), ...queueMessageDirs()]
    : queueMessageDirs())];

  const removeClaimed = (dir: string, files: string[], cutoff: number): string[] => {
    const done: string[] = [];
    for (const f of files) {
      const filePath = path.join(dir, f);
      let mid = "";
      let msgTs = fileTimestamp(f);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        mid = parsed.messageId || "";
        if (typeof parsed.timestamp === "number") msgTs = parsed.timestamp;
      } catch { /* ignore */ }
      if (msgTs > cutoff) continue;
      try {
        fs.unlinkSync(filePath);
        if (mid) done.push(mid);
      } catch { /* ignore */ }
    }
    return done;
  };

  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".claimed"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    if (!safeId) {
      // 无 messageId：只清指定会话目录（全局兜底不适用，防误删他会话）
      if (filterSessionKey && dir === getSessionDir(filterSessionKey)) {
        return removeClaimed(dir, files, Number.POSITIVE_INFINITY);
      }
      continue;
    }

    const target = files.find((f) => matchesSafeId(f, safeId));
    if (!target) continue;
    return removeClaimed(dir, files, fileTimestamp(target));
  }
  return [];
}

export function getEarliestMessageTime(filterSessionKey?: string): number | null {
  if (!queueDir) return null;
  const dir = getSessionDir(filterSessionKey);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg")).sort();
    if (files.length === 0) return null;
    const file = files[0];
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw);
      return parsed.timestamp || parseInt(file.split("_")[0], 10) || null;
    } catch { return null; }
  } catch { /* ignore */ }
  return null;
}

/** 未处理完的消息数（.qmsg 待投递 + .claimed 已投递未确认）。
 * 计入 .claimed 是掉线自愈的关键：Agent 死后残留的未确认消息会让调度轮询继续触发，
 * 否则消息被幽灵连接领走后队列长度归零，永远无人拉起新 Agent。 */
export function getQueueLength(filterSessionKey?: string): number {
  if (!queueDir) return 0;
  const isPending = (f: string) => f.endsWith(".qmsg") || f.endsWith(".claimed");
  if (filterSessionKey) {
    const dir = getSessionDir(filterSessionKey);
    try { return fs.readdirSync(dir).filter(isPending).length; } catch { return 0; }
  }
  try {
    let total = 0;
    for (const sub of queueMessageDirs()) {
      try { total += fs.readdirSync(sub).filter(isPending).length; } catch { /* ignore */ }
    }
    return total;
  } catch { return 0; }
}

/** 全局队列分状态计数：pending = 排队待投递（.qmsg）；processing = 已投递待确认（.claimed） */
export function getQueueCounts(): { pending: number; processing: number } {
  const counts = { pending: 0, processing: 0 };
  if (!queueDir) return counts;
  const tally = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".qmsg")) counts.pending++;
        else if (f.endsWith(".claimed")) counts.processing++;
      }
    } catch { /* ignore */ }
  };
  for (const sub of queueMessageDirs()) tally(sub);
  return counts;
}

export interface QueueMessageView {
  index: number;
  fileId: string;
  preview: string;
  /** pending = 排队待投递（.qmsg）；processing = 已投递给 Agent 待回复确认（.claimed） */
  status?: "pending" | "processing";
  sessionKey?: string;
  messageId?: string;
  chatType?: string;
  timestamp?: number;
  senderOpenId?: string;
}

export function getQueueMessages(filterSessionKey?: string): QueueMessageView[] {
  if (!queueDir) return [];
  const dirs = filterSessionKey ? [getSessionDir(filterSessionKey)] : queueMessageDirs();
  const result: QueueMessageView[] = [];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg") || f.endsWith(".claimed")).sort();
      for (const f of files) {
        const status = f.endsWith(".claimed") ? "processing" as const : "pending" as const;
        try {
          const filePath = path.join(dir, f);
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          const ts = parsed.timestamp || fs.statSync(filePath).mtimeMs;
          result.push({
            index: result.length, fileId: f, status,
            preview: (parsed.text ?? "").slice(0, 200),
            sessionKey: parsed.sessionKey || parsed.chatId || undefined,
            messageId: parsed.messageId || undefined,
            chatType: parsed.meta?.chatType || parsed.chatType || undefined,
            timestamp: Math.round(ts),
            senderOpenId: parsed.meta?.senderOpenId || parsed.senderOpenId || undefined,
          });
        } catch {
          result.push({ index: result.length, fileId: f, status, preview: "(unreadable)" });
        }
      }
    } catch { /* ignore */ }
  }
  result.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  result.forEach((v, i) => { v.index = i; });
  return result;
}

export function deleteQueueMessage(fileId: string, filterSessionKey?: string): boolean {
  if (!queueDir || !fileId) return false;
  const basename = path.basename(fileId);
  if (basename !== fileId || !(fileId.endsWith(".qmsg") || fileId.endsWith(".claimed"))) return false;
  const dirs = filterSessionKey ? [getSessionDir(filterSessionKey)] : queueMessageDirs();
  for (const dir of dirs) {
    try {
      const filePath = path.join(dir, basename);
      if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
    } catch { /* ignore */ }
  }
  return false;
}

/** 按飞书 message_id 删除队列中 pending/processing 项（.qmsg / .claimed） */
export function deleteQueueMessagesByMessageId(messageId: string): { removed: number; sessionKeys: string[] } {
  if (!queueDir || !messageId) return { removed: 0, sessionKeys: [] };
  const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sessionKeys = new Set<string>();
  let removed = 0;
  for (const dir of queueMessageDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".qmsg") && !f.endsWith(".claimed")) continue;
        const filePath = path.join(dir, f);
        let sk = "";
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (parsed.messageId !== messageId && !matchesSafeId(f, safeId)) continue;
          sk = parsed.sessionKey || parsed.chatId || "";
        } catch { continue; }
        try {
          fs.unlinkSync(filePath);
          removed++;
          if (sk) sessionKeys.add(sk);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return { removed, sessionKeys: [...sessionKeys] };
}

export interface QueueSessionInfo {
  sessionKey: string;
  chatType: string;
  senderOpenId?: string;
  /** 有未领取的新消息（区别于崩溃重投的已领取消息）：调度器无视失败冷却立即拉起 */
  hasPending?: boolean;
}

/** meta 缺 chatType 时按 key 形态推断，防群/项目会话被误当 p2p 访客拉起 */
function inferChatType(sessionKey: string): string {
  const chatPart = sessionKey.includes("::") ? sessionKey.slice(0, sessionKey.indexOf("::")) : sessionKey;
  const rawChatId = chatPart.includes("|") ? chatPart.slice(chatPart.indexOf("|") + 1) : chatPart;
  if (rawChatId.startsWith("oc_") || rawChatId.startsWith("on_")) return "group";
  return "p2p";
}

/** 有未处理完消息的会话（含 .claimed 未确认：Agent 掉线后调度器据此重新拉起并重投） */
export function getDistinctSessions(): QueueSessionInfo[] {
  if (!queueDir) return [];
  const map = new Map<string, { chatType: string; senderOpenId?: string; hasPending?: boolean }>();
  for (const dir of queueMessageDirs()) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".qmsg") || f.endsWith(".claimed"));
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(dir, f), "utf-8");
          const parsed = JSON.parse(raw);
          const key = parsed.sessionKey || parsed.chatId || "";
          if (!key) continue;
          const entry = map.get(key) ?? { chatType: parsed.meta?.chatType || parsed.chatType || inferChatType(key), senderOpenId: parsed.meta?.senderOpenId || parsed.senderOpenId || undefined, hasPending: false };
          if (f.endsWith(".qmsg")) entry.hasPending = true;
          map.set(key, entry);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return [...map.entries()].map(([key, v]) => ({
    sessionKey: key,
    chatType: v.chatType,
    senderOpenId: v.senderOpenId,
    // 之前漏传该字段：调度器「有新消息无视失败冷却」机制因此失效，异常后的新消息被冷却挡住
    hasPending: v.hasPending,
  }));
}

const STALE_CLAIMED_MS = 72 * 60 * 60 * 1000;

/** 清理写入中断遗留的 .tmp 孤儿 + 超过 72h 未确认的 .claimed（死会话兜底，防无限堆积） */
export function cleanupStaleMessages(): void {
  if (!queueDir) return;
  const now = Date.now();
  for (const dir of queueMessageDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const isTmp = f.endsWith(".tmp");
        const isClaimed = f.endsWith(".claimed");
        if (!isTmp && !isClaimed) continue;
        const filePath = path.join(dir, f);
        const maxAge = isTmp ? STALE_TMP_MS : STALE_CLAIMED_MS;
        try {
          if (now - fs.statSync(filePath).mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

const QUEUE_FILE_SUFFIXES = [".qmsg", ".claimed", ".done", ".tmp"] as const;

/** 删除全部会话 queue 目录下的排队/处理中消息文件 */
export function clearAllQueueMessages(): number {
  if (!queueDir) return 0;
  let count = 0;
  for (const dir of queueMessageDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!QUEUE_FILE_SUFFIXES.some((ext) => f.endsWith(ext))) continue;
        try {
          fs.unlinkSync(path.join(dir, f));
          count++;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return count;
}
