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
  /** 结果通知群 chat_id（裸 oc_xxx）；与 channelId 拼成 notify_session_key */
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

/** 由任务配置拼出 outbound 投递用的 notify_session_key */
export function buildNotifySessionKey(task: Pick<ScheduledTask, "notifyChatId" | "channelId">): string | undefined {
  const raw = task.notifyChatId?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("ch_") && raw.includes("|")) return raw;
  const channelId = task.channelId?.trim();
  if (!channelId) return undefined;
  return makeChatKey(channelId, raw);
}

/** 注入 Prompt 元数据：说明 notify_session_key 是 outbound 主通信 key */
export function scheduledTaskNotifyPromptLines(notifySessionKey: string): string[] {
  return [
    `[notify_session_key=${notifySessionKey}]`,
    "【投递规则】send_text / send_image / send_file / send_question 等所有 outbound 消息，必须且只能使用 notify_session_key 作为 session_key（这是本任务的主要通信 key）。",
    "当前 session_key 仅用于 poll-message 拉取与保活，禁止用于 outbound 投递；禁止向主用户私聊发送任务通知。",
  ];
}
