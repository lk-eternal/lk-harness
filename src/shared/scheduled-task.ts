// ── 定时任务共享类型与文件存取 ───────────────────────────
// Electron 主进程与 Daemon 子进程共用（同一份 scheduled-tasks.json）。

import * as fs from "node:fs";
import * as path from "node:path";
import { makeChatKey } from "./channel-types.js";
import { atomicWriteUtf8 } from "./atomic-json.js";

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
  /** MCP 投递目标会话 ID（裸 oc_xxx 或完整 chatKey）；与 channelId 拼 outbound key，空则主用户私聊 */
  notifyChatId?: string;
}

export class ScheduledTasksReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTasksReadError";
  }
}

function parseScheduledTasksPayload(parsed: unknown): ScheduledTask[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (t: unknown): t is ScheduledTask =>
      typeof t === "object" && t !== null &&
      typeof (t as ScheduledTask).id === "string" &&
      typeof (t as ScheduledTask).name === "string" &&
      typeof (t as ScheduledTask).cron === "string" &&
      typeof (t as ScheduledTask).content === "string",
  ).map((t) => ({ ...t, enabled: t.enabled !== false }));
}

/** 读取任务文件：缺失返回 []；损坏备份后抛错（禁止静默降级为空） */
export function readScheduledTasksFile(file: string): ScheduledTask[] {
  if (!fs.existsSync(file)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
    return parseScheduledTasksPayload(JSON.parse(raw));
  } catch (e) {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch { /* ignore backup failure */ }
    const detail = e instanceof Error ? e.message : String(e);
    throw new ScheduledTasksReadError(`定时任务文件损坏: ${file} (${detail})`);
  }
}

export function writeScheduledTasksFile(file: string, tasks: ScheduledTask[]): void {
  atomicWriteUtf8(file, JSON.stringify(tasks, null, 2));
}

/** 独立定时任务 sessionKey = task.id（裸 id，无 ch_|::） */
export function findScheduledTaskBySessionKey(
  sessionKey: string,
  tasks: ScheduledTask[],
): ScheduledTask | undefined {
  const key = sessionKey.trim();
  if (!key || key.includes("|") || key.includes("::")) return undefined;
  return tasks.find((t) => t.id === key);
}

/** 独立运行定时任务（默认 independent=true）的 sessionKey */
export function isIndependentTaskSessionKey(
  sessionKey: string,
  tasks: ScheduledTask[],
): boolean {
  const task = findScheduledTaskBySessionKey(sessionKey, tasks);
  return !!task && task.independent !== false;
}

export function formatScheduledTaskLabel(name: string): string {
  return `⏰ ${name}`;
}

/** 由任务配置拼出 outbound 投递用的 notify_session_key（仅显式 notifyChatId） */
export function buildNotifySessionKey(task: Pick<ScheduledTask, "notifyChatId" | "channelId">): string | undefined {
  const raw = task.notifyChatId?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ch_") && raw.includes("|")) return raw;
  const channelId = task.channelId?.trim();
  if (!channelId) return undefined;
  return makeChatKey(channelId, raw);
}

/** 独立任务 MCP / 路由用 outbound chatKey：notifyChatId 优先，否则通道主用户私聊 */
export function resolveTaskOutboundChatKey(
  task: Pick<ScheduledTask, "notifyChatId" | "channelId">,
  mainUserChatId?: string | null,
): string | undefined {
  const explicit = buildNotifySessionKey(task);
  if (explicit) return explicit;
  const channelId = task.channelId?.trim();
  const main = mainUserChatId?.trim();
  if (!channelId || !main) return undefined;
  return makeChatKey(channelId, main);
}

