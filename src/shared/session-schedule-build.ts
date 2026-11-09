// ── 对话页「这个会话的定时」：取出绑定到某会话的任务，算好显示要用的字段 ─────────
// 在主进程里跑（要读任务文件、算 cron 的下次触发时间）。不能被渲染进程引用：这里有 cron-parser。
// 判断归属和格式化的纯函数在 session-schedule.ts（渲染进程也用）。

import { CronExpressionParser } from "cron-parser";
import { evaluateAiTaskFire } from "./ai-schedule.js";
import {
  resolveTaskChannelId,
  type ScheduledTask,
} from "./scheduled-task.js";
import { isAiTask } from "./scheduled-task-rules.js";
import {
  scheduleDelivery,
  taskBoundToSession,
  type SessionScheduleContext,
  type SessionScheduleItem,
} from "./session-schedule.js";

/** cron 在 from 之后的下一次触发（毫秒时间戳）；表达式无效返回 undefined */
export function nextCronFireAt(expression: string, from: number): number | undefined {
  const expr = expression.trim();
  if (!expr) return undefined;
  try {
    return CronExpressionParser.parse(expr, { currentDate: new Date(from) }).next().toDate().getTime();
  } catch {
    return undefined;
  }
}

/**
 * 对话页删除一个用户建的任务：返回删掉它之后的任务列表。
 * AI 排程不能在这里删：它要走 daemon 的取消（正在跑的先停用，不直接删），直接从文件里抹掉会让还在跑的那次找不到自己。
 */
export function removeUserTask(
  tasks: readonly ScheduledTask[],
  taskId: string,
): { ok: true; tasks: ScheduledTask[] } | { ok: false; error: string } {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: "任务不存在（可能已被删除）" };
  if (isAiTask(task)) return { ok: false, error: "AI 排程请用取消，不能直接删除" };
  return { ok: true, tasks: tasks.filter((t) => t.id !== taskId) };
}

export interface BuildSessionSchedulesInput {
  tasks: readonly ScheduledTask[];
  ctx: SessionScheduleContext;
  /** AI 排程累计触发次数（ai-schedule-state.json） */
  aiRuns: Readonly<Record<string, number>>;
  now: number;
  /** 没设所属通道的任务按「第一个启用的通道」算，和设置页、daemon 的口径一致 */
  channels: readonly { id: string; enabled?: boolean }[];
  /** 正在运行的独立任务 id */
  runningTaskIds: ReadonlySet<string>;
  /** 下次触发时间；默认按 cron 表达式算，测试可替换 */
  nextFireAt?: (cron: string, from: number) => number | undefined;
}

/**
 * 绑定到 ctx 这个会话的全部定时，按「已启用在前、下次触发早的在前」排。
 * 已经作废的 AI 排程不列出：被取消（停用，等着清理）、用完次数、已过期——它们不会再触发，列出来只会误导。
 * 用户在设置页停用的任务照常列出（置灰），可以看到、也能立即运行或删除。
 */
export function buildSessionSchedules(input: BuildSessionSchedulesInput): SessionScheduleItem[] {
  const { tasks, ctx, aiRuns, now, channels, runningTaskIds } = input;
  const nextFireAt = input.nextFireAt ?? nextCronFireAt;
  const items: SessionScheduleItem[] = [];

  for (const task of tasks) {
    if (!taskBoundToSession(task, ctx, resolveTaskChannelId(task, channels))) continue;

    const ai = isAiTask(task);
    const runs = aiRuns[task.id] ?? 0;
    if (ai && (!task.enabled || !evaluateAiTaskFire(task, runs, now).fire)) continue;

    let nextAt = task.enabled ? nextFireAt(task.cron, now) : undefined;
    // 下次触发时已经过期：它不会再跑了，别显示一个不会发生的时间
    if (ai && nextAt !== undefined && task.expiresAt !== undefined && nextAt >= task.expiresAt) nextAt = undefined;

    items.push({
      id: task.id,
      name: task.name,
      cron: task.cron,
      origin: ai ? "ai" : "user",
      delivery: scheduleDelivery(task),
      enabled: task.enabled,
      running: runningTaskIds.has(task.id),
      ...(nextAt !== undefined ? { nextAt } : {}),
      ...(ai ? { runCount: runs } : {}),
      ...(task.maxRuns !== undefined ? { maxRuns: task.maxRuns } : {}),
      ...(task.expiresAt !== undefined ? { expiresAt: task.expiresAt } : {}),
    });
  }

  return items.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const an = a.nextAt ?? Number.POSITIVE_INFINITY;
    const bn = b.nextAt ?? Number.POSITIVE_INFINITY;
    return an !== bn ? an - bn : a.name.localeCompare(b.name, "zh-CN");
  });
}
