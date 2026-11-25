// ── 对话页「这个会话的定时」：哪些任务算绑定到某个会话，以及一行怎么写 ─────────
// 绑定有两种来源：
//   - AI 给自己排的程（createdBy=ai）：记着创建它的会话（ownerSessionKey）；
//   - 用户在设置页 / 管理工具里建的任务，投递目标是这个会话（独立与否都算）：
//       通知 AI：投给项目会话 / 所选的具体会话 / 通道的主会话（任务内容或结果会进它的上下文）；
//       通知我 + 应用内通道：发到所选的会话（只显示给用户，不唤醒 Agent）。
// 渲染进程（对话页）要用这里的格式化函数，所以本文件不许引入带 node 依赖的模块
// （scheduled-task.ts / ai-schedule.ts / project-types.ts）。取任务、算下次触发时间的部分在 session-schedule-build.ts。

import { appChatSessionId } from "./app-chat-types.js";
import { isAiTask, resolveTaskNotify, taskAgentSessionKey, type ScheduledTask } from "./scheduled-task-rules.js";
import type { TaskRunRecord } from "./task-run-log-rules.js";

/** 当前会话是谁（主进程按会话键解析，归属判断只看这几项） */
export interface SessionScheduleContext {
  sessionKey: string;
  /** 项目会话：所属项目 id */
  projectId?: string;
  /** 这个会话是某个通道的主会话：该通道 id */
  mainOfChannelId?: string;
}

/**
 * 到点怎么跑：
 *  - inject：不开新 Agent，把任务内容直接送进这个会话（通知 AI：由它自己做，会占用上下文；通知我：只显示给用户）；
 *  - report：全新 Agent 独立执行，结果作为一条消息送进这个会话（通知 AI：唤醒它处理；通知我：只显示给用户）。
 */
export type SessionScheduleDelivery = "inject" | "report";

/** 送进这个会话的东西是给谁的：ai = 通知 AI（进它的上下文并唤醒）；me = 通知我（以 AI 口吻显示给用户，不唤醒 Agent） */
export type SessionScheduleTarget = "ai" | "me";

/** 对话页列表里的一行（主进程算好后经 IPC 传过来，全是可序列化的原始字段） */
export interface SessionScheduleItem {
  id: string;
  name: string;
  cron: string;
  /** ai = AI 给自己排的；user = 用户在设置页建的 */
  origin: "ai" | "user";
  delivery: SessionScheduleDelivery;
  /** 缺省 = ai */
  target?: SessionScheduleTarget;
  enabled: boolean;
  /** 独立运行的任务正在跑 */
  running: boolean;
  /** 下次触发时间（毫秒时间戳）；停用 / 算不出来 / 在下次触发前就会过期时没有 */
  nextAt?: number;
  /** AI 排程：已触发次数 */
  runCount?: number;
  maxRuns?: number;
  /** AI 排程：到期时间（毫秒时间戳） */
  expiresAt?: number;
  /** 最近几次运行（新的在前，最多 RECENT_RUNS_LIMIT 条）；点开一行时显示 */
  recent?: TaskRunRecord[];
}

/** 每个任务在会话栏里带多少条最近运行 */
export const RECENT_RUNS_LIMIT = 5;

/** 任务到点是不是要投给某个 Agent 会话（通知 AI：非独立运行投内容，独立运行投结果） */
export function deliversToAgentSession(task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId">): boolean {
  return resolveTaskNotify(task) === "agent";
}

export function scheduleDelivery(task: Pick<ScheduledTask, "independent">): SessionScheduleDelivery {
  return task.independent === false ? "inject" : "report";
}

/** 送进会话的东西是给 AI 的还是给用户的（只有通知我是给用户的） */
export function scheduleTarget(task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId">): SessionScheduleTarget {
  return resolveTaskNotify(task) === "im" ? "me" : "ai";
}

function sameSession(a: string, b: string): boolean {
  return !!a && !!b && appChatSessionId(a) === appChatSessionId(b);
}

/**
 * 这个任务是不是绑定到当前会话（投递目标是它，独立与否都算）。
 * notifyChannelId = 任务实际通知的通道（没设通道的任务按「第一个启用的通道」，由调用方解析）。
 *  - AI 排程：创建它的会话；
 *  - 通知 AI：绑了项目认项目会话；选了具体会话认那个会话；都没选认通知通道的主会话（只认应用内通道里这一个主会话）；
 *  - 通知我：只有应用内通道选的会话才是「这个会话」（会话键带目录）；飞书 / 微信的接收方不在应用内会话里；
 *  - 不通知：不投任何会话。
 */
export function taskBoundToSession(
  task: ScheduledTask,
  ctx: SessionScheduleContext,
  notifyChannelId: string | undefined,
): boolean {
  if (isAiTask(task)) return sameSession(task.ownerSessionKey?.trim() ?? "", ctx.sessionKey);
  const mode = resolveTaskNotify(task);
  if (mode === "none") return false;
  if (mode === "im") {
    const chat = task.notifyChatId?.trim() ?? "";
    return chat.includes("::") && sameSession(chat, ctx.sessionKey);
  }
  const projectId = task.targetProjectId?.trim();
  if (projectId) return ctx.projectId === projectId;
  const picked = taskAgentSessionKey(task);
  if (picked) return sameSession(picked, ctx.sessionKey);
  return !!ctx.mainOfChannelId && !!notifyChannelId && ctx.mainOfChannelId === notifyChannelId;
}

// ── cron → 一句人话 ────────────────────────────────────

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

function intIn(s: string | undefined, min: number, max: number): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** 「每 N」里的 N；`*` 和 `步长 1` 都当「每 1」 */
function stepOf(s: string | undefined, max: number): number | null {
  if (s === "*") return 1;
  const m = /^\*\/(\d+)$/.exec(s ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : null;
}

/** 星期字段：单个 / 逗号列表 / 范围，0 和 7 都是周日；认不出返回 null */
function weekdaysText(s: string): string | null {
  const range = /^(\d)-(\d)$/.exec(s);
  if (range) {
    const a = intIn(range[1], 0, 7);
    const b = intIn(range[2], 0, 7);
    if (a === null || b === null || a > b) return null;
    if (a === 1 && b === 5) return "工作日";
    return `每周${WEEKDAY[a % 7]}至周${WEEKDAY[b % 7]}`;
  }
  const days: number[] = [];
  for (const part of s.split(",")) {
    const d = intIn(part, 0, 7);
    if (d === null) return null;
    days.push(d % 7);
  }
  return days.length === 1 ? `每周${WEEKDAY[days[0]]}` : `每周${days.map((d) => WEEKDAY[d]).join("、")}`;
}

/**
 * cron 的简短说法（「每 5 分钟」「每天 09:00」「工作日 09:30」）。
 * 只认常见写法，认不出的原样给出（`cron 0 9 1-15 * *`），宁可难看也不能说错。
 */
export function describeCronShort(cron: string): string {
  const raw = cron.trim();
  const fallback = `cron ${raw}`;
  const parts = raw.split(/\s+/).filter(Boolean);
  let fields = parts;

  if (parts.length === 6) {
    // 带秒的写法：只认「每秒 / 每 N 秒」和「秒字段为 0」
    const [sec, ...rest] = parts;
    if (rest.every((f) => f === "*")) {
      const n = stepOf(sec, 59);
      return n === null ? fallback : n === 1 ? "每秒" : `每 ${n} 秒`;
    }
    if (sec !== "0") return fallback;
    fields = rest;
  } else if (parts.length !== 5) {
    return fallback;
  }

  const [min, hour, dom, mon, dow] = fields;
  if (mon !== "*") return fallback;

  const clock = (): string | null => {
    const m = intIn(min, 0, 59);
    const h = intIn(hour, 0, 23);
    return m === null || h === null ? null : `${pad2(h)}:${pad2(m)}`;
  };

  if (dom === "*" && dow === "*") {
    const everyMin = stepOf(min, 59);
    if (hour === "*" && everyMin !== null) return everyMin === 1 ? "每 1 分钟" : `每 ${everyMin} 分钟`;
    const m = intIn(min, 0, 59);
    if (m !== null) {
      if (hour === "*") return m === 0 ? "每小时整点" : `每小时第 ${m} 分`;
      const everyHour = stepOf(hour, 23);
      if (everyHour !== null && hour !== "*") {
        const at = m === 0 ? "" : `（第 ${m} 分）`;
        return everyHour === 1 ? `每小时${at}` : `每 ${everyHour} 小时${at}`;
      }
    }
    const c = clock();
    return c ? `每天 ${c}` : fallback;
  }

  if (dom === "*") {
    const c = clock();
    const days = weekdaysText(dow);
    return c && days ? `${days} ${c}` : fallback;
  }

  if (dow === "*") {
    const c = clock();
    const d = intIn(dom, 1, 31);
    return c && d !== null ? `每月 ${d} 日 ${c}` : fallback;
  }

  return fallback;
}

// ── 时间 / 摘要 ────────────────────────────────────────

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 触发时间的简写：今天只写时分，明天写「明天」，再往后写月/日 */
export function formatFireTime(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return hm;
  if (days === 1) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 已触发进度 + 有效期（只有 AI 排程有） */
function limitText(item: SessionScheduleItem, now: number): string {
  if (item.origin !== "ai") return "";
  const runs = item.runCount ?? 0;
  const progress = item.maxRuns !== undefined ? `已触发 ${runs}/${item.maxRuns} 次` : `已触发 ${runs} 次`;
  if (item.expiresAt === undefined) return progress;
  return `${progress} · ${formatFireTime(item.expiresAt, now)} 到期`;
}

function nextText(item: SessionScheduleItem, now: number): string {
  if (!item.enabled) return "已停用";
  if (item.running) return "运行中";
  return item.nextAt !== undefined ? `下次 ${formatFireTime(item.nextAt, now)}` : "";
}

/** 到点怎么跑，一个短语（列表副标题的开头）；target 缺省 = 通知 AI */
export function deliveryLabel(delivery: SessionScheduleDelivery, target: SessionScheduleTarget = "ai"): string {
  if (target === "me") return delivery === "inject" ? "直接发给你" : "独立执行，结果发给你";
  return delivery === "inject" ? "提醒本会话" : "独立执行";
}

/** 一行的副标题：怎么跑 · 频率 · 进度 · 下次 */
export function describeScheduleItem(item: SessionScheduleItem, now: number): string {
  return [deliveryLabel(item.delivery, item.target), describeCronShort(item.cron), limitText(item, now), nextText(item, now)]
    .filter(Boolean)
    .join(" · ");
}

/** 悬停说明：把「到点会发生什么」讲完整 */
export function describeScheduleDetail(item: SessionScheduleItem): string {
  const inject = item.delivery === "inject";
  const what = item.target === "me"
    ? inject
      ? "到点不启动 Agent，把任务内容以 AI 口吻直接发到这个会话，只显示给你看。"
      : "到点由全新 Agent 独立执行，提交的结果以 AI 口吻发到这个会话，只显示给你看，不唤醒任何 Agent。"
    : inject
      ? "到点把任务内容发进这个会话，由它自己执行；会占用这个会话的上下文。"
      : "到点由全新 Agent 独立执行，提交的结果会作为一条消息投回这个会话。";
  const who = item.origin === "ai" ? "AI 给自己排的程。" : "在设置页创建的定时任务。";
  return `${who}${what}`;
}

/** 「立即运行」按钮的悬停提示 */
export function runNowHint(item: SessionScheduleItem): string {
  const act = item.delivery === "inject"
    ? item.target === "me" ? "立即把任务内容发到这个会话一次" : "立即把任务内容发进这个会话一次"
    : "立即让新 Agent 执行一次";
  return `${act}（不改变原计划，也不计入已触发次数）`;
}

/** 折叠条上的一句话：几个定时、最近一次什么时候 */
export function summarizeSchedules(items: readonly SessionScheduleItem[], now: number): string {
  const active = items.filter((i) => i.enabled);
  if (items.length === 0) return "";
  const count = `${items.length} 个定时`;
  if (active.length === 0) return `${count} · 已停用`;
  if (active.some((i) => i.running)) return `${count} · 运行中`;
  const next = active.map((i) => i.nextAt).filter((t): t is number => t !== undefined);
  return next.length === 0 ? count : `${count} · 下次 ${formatFireTime(Math.min(...next), now)}`;
}
