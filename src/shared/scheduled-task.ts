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
  /** 任务自己选的供应商（Agent 资源 id），空 = 跟随通道的供应商。只在同时配了 model 时生效：供应商换了，模型必须是它家的 */
  resourceId?: string;
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

/**
 * 独立任务（裸 id 会话）拉起时用哪个通道：任务绑定的通道，没绑就是第一个启用的通道。
 * 队列唤醒拉起任务和界面显示任务的模型共用这一条规则，两边才不会各取各的。
 */
export function resolveTaskChannelId(
  task: Pick<ScheduledTask, "channelId"> | undefined,
  channels: readonly { id: string; enabled?: boolean }[],
): string | undefined {
  return task?.channelId || channels.find((c) => c.enabled)?.id;
}

/**
 * 任务入队时登记在它会话里的模型覆盖（会话换模、界面读取都看这份记录）。
 * 任务没配模型就不登记；供应商：任务自己选的 > 所属通道的。
 * cron 触发（daemon）和手动触发（经 /enqueue）共用，两条路径登记的才一样。
 */
export function taskSessionOverride(
  input: { model?: string; modelParams?: string; resourceId?: string },
  channelResourceId?: string,
): { model: string; modelParams: string; resourceId?: string } | undefined {
  const model = input.model?.trim();
  if (!model) return undefined;
  const resourceId = input.resourceId?.trim() || channelResourceId?.trim();
  return { model, modelParams: input.modelParams ?? "", ...(resourceId ? { resourceId } : {}) };
}

const modelSetting = (t: Pick<ScheduledTask, "channelId" | "model" | "modelParams" | "resourceId">): string =>
  [t.channelId, t.model, t.modelParams, t.resourceId].map((v) => v?.trim() ?? "").join("\u0001");

/**
 * 保存任务后，哪些任务的「跑在哪、用什么模型」改了：所属通道、供应商、模型、参数任一变化。
 * 只看保存前后都存在的任务；新建和删除的不算。
 * 这些任务在会话里登记过的旧模型覆盖要作废：daemon 只在任务有模型时才登记，
 * 改回「跟随」或换了供应商后，旧覆盖不清就会盖过新设置。
 */
export function tasksWithChangedModelSetting(
  before: readonly ScheduledTask[],
  after: readonly ScheduledTask[],
): string[] {
  const old = new Map(before.map((t) => [t.id, modelSetting(t)]));
  return after.filter((t) => old.has(t.id) && old.get(t.id) !== modelSetting(t)).map((t) => t.id);
}

/**
 * 独立任务发到飞书的卡片页脚：这次运行用的模型。
 * 独立任务不建流式卡（流式卡收口时才带「模型 · 耗时」页脚），它的消息是单独发出的卡片，页脚由发送处补上。
 * 只管独立任务；没登记模型 / 登记的是空白时不加页脚。
 */
export function taskCardFooter(input: {
  sessionKey?: string;
  invokerSessionKey?: string;
  tasks: ScheduledTask[];
  modelLabelOf: (sessionKey: string) => string | undefined;
}): string | undefined {
  const key = (input.invokerSessionKey || input.sessionKey)?.trim();
  if (!key || !isIndependentTaskSessionKey(key, input.tasks)) return undefined;
  return input.modelLabelOf(key)?.trim() || undefined;
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

