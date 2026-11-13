// ── 定时任务共享类型与文件存取 ───────────────────────────
// Electron 主进程与 Daemon 子进程共用（同一份 scheduled-tasks.json）。

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteUtf8 } from "./atomic-json.js";
import type { ScheduledTask } from "./scheduled-task-rules.js";

// 类型与纯规则在 scheduled-task-rules.ts（渲染进程也要用，不能带 node 依赖）；这里转出，旧的 import 路径照常可用
export * from "./scheduled-task-rules.js";

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

/**
 * 会话键长得像任务会话（裸 id），任务表里却已经没有这个任务：任务跑完 / 被删后留下的路由登记。
 * 聊天会话的键一定带通道前缀或目录（`ch_x|chat`、`…::dir`），裸 temp_* 是临时会话，所以它不会是任何一个对话。
 */
export function isOrphanTaskSessionKey(sessionKey: string, tasks: ScheduledTask[]): boolean {
  const key = sessionKey.trim();
  if (!key || key.startsWith("temp_") || key.includes("|") || key.includes("::")) return false;
  return !findScheduledTaskBySessionKey(key, tasks);
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

/**
 * 独立任务发到飞书的卡片头部：「⏰ 任务名」，配色按任务 id 定。
 * 独立任务不是任何一个会话的回合。它的出站目标是聊天键、不带会话，
 * 头部如果照常借「这个聊天当前的活跃会话」，结果就会被标成某个项目 / 目录会话发的
 * （活跃会话想指哪就指哪，比如一个已经归档的项目）。
 * 只管独立任务；其余返回 undefined，调用方照旧按会话取头部。
 */
export function taskCardHeader(input: {
  sessionKey?: string;
  invokerSessionKey?: string;
  tasks: ScheduledTask[];
}): { title: string; colorKey: string } | undefined {
  const key = (input.invokerSessionKey || input.sessionKey)?.trim();
  if (!key) return undefined;
  const task = findScheduledTaskBySessionKey(key, input.tasks);
  if (!task || task.independent === false) return undefined;
  return { title: formatScheduledTaskLabel(task.name?.trim() || "定时任务"), colorKey: task.id };
}
