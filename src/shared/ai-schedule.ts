// ── AI 给自己排程：校验、构造任务、触发判定的纯逻辑 ─────────────
// AI 通过 lk-harness-schedule 的 schedule_create / schedule_list / schedule_cancel 管理自己的定时任务。
// 任务绑定到「调用它的会话」（服务端按调用者身份定，AI 不能指定别人的会话），
// 并且必须有次数或过期时间、间隔不得太密、同一会话活跃数有上限——AI 排程是自动化，不是失控的循环。
// 这里全是无副作用函数；写文件、发消息在 daemon 里。

import { CronExpressionParser } from "cron-parser";
import { chatIdFromSessionKey, makeChatKey, normalizeSessionKey, parseChatKey } from "./channel-types.js";
import { projectIdFromSessionKey } from "./project-types.js";
import { isAiTask, type ScheduledTask } from "./scheduled-task-rules.js";

export { isAiTask };

/** 嵌入宿主协议的「自排程」段：挂载了 lk-harness-schedule 的会话（主用户会话、项目会话）才会收到 */
export const AI_SCHEDULE_PROMPT_SECTION = [
  "### AI 自排程（lk-harness-schedule）",
  "",
  "**schedule_create / schedule_list / schedule_cancel** — 给**你当前所在的会话**自己排定时任务（等 CI、定期检查、隔天复查）。",
  "- `mode=fresh`（默认）：每次由新 Agent 执行，有结论才投回本会话，没事可报时它可以静默（prompt 里写明什么情况下才汇报）；`mode=session`：到点提醒本会话自己做。",
].join("\n");

export const AI_SCHEDULE_LIMITS = {
  /** 同一会话同时存在的 AI 排程数 */
  maxActivePerSession: 5,
  /** 相邻两次触发的最小间隔（分钟） */
  minIntervalMinutes: 5,
  /** 单个排程最多触发次数 */
  maxRunsCap: 100,
  /** 单个排程最长存活（小时），14 天 */
  maxExpiryHours: 24 * 14,
  maxNameLength: 40,
  maxPromptLength: 4000,
} as const;

/** fresh = 每次全新 Agent 执行，结果投回本会话；session = 到点把提醒投进本会话，由它自己接着做 */
export type AiScheduleMode = "fresh" | "session";

export interface AiScheduleInput {
  name?: string;
  prompt?: string;
  cron?: string;
  everyMinutes?: number;
  mode?: string;
  maxRuns?: number;
  expiresInHours?: number;
}

/** 排程归属的会话（daemon 按调用者身份判出来，AI 无法自报） */
export interface AiScheduleOwner {
  /** 已规范化的会话 key */
  sessionKey: string;
  /** main = 通道的主会话；project = 项目会话；chat = 应用内通道里主用户的其他会话（其他目录、临时会话） */
  kind: "main" | "project" | "chat";
  channelId?: string;
  projectId?: string;
}

/** 判定调用者归属要查的外部信息（daemon 里的项目表和通道表） */
export interface AiScheduleOwnerEnv {
  project(id: string): { name: string; status: string } | undefined;
  channel(id: string): {
    id: string;
    /** 通道类型：app = 应用内，其余是飞书 / 微信 */
    type: string;
    mainUserEnabled?: boolean;
    mainUserChatId?: string;
    /** 通道的主目录；没配置是空串 */
    workspaceDir: string;
  } | undefined;
}

export type AiScheduleOwnerCheck = { ok: true; owner: AiScheduleOwner } | { ok: false; error: string };

/**
 * 调用者是谁决定排程归谁（AI 无法自报身份）：
 *  - 活跃的项目会话；
 *  - 通道主用户的主会话；
 *  - 应用内通道里，主用户聊天下的其他会话（其他目录、临时会话）：应用内没有「别人」，这些都是用户自己的会话。
 * 飞书 / 微信里主用户的其他目录会话、群聊、别人的私聊、定时任务的会话不开放。
 */
export function classifyAiScheduleOwner(invoker: string | undefined, env: AiScheduleOwnerEnv): AiScheduleOwnerCheck {
  const raw = invoker?.trim();
  if (!raw) return { ok: false, error: "须在 Harness 调度的 Agent 会话中调用" };
  const sessionKey = normalizeSessionKey(raw) || raw;
  const chatKey = chatIdFromSessionKey(sessionKey);
  const channelId = parseChatKey(chatKey).channelId || undefined;

  const projectId = projectIdFromSessionKey(sessionKey);
  if (projectId) {
    const project = env.project(projectId);
    if (!project) return { ok: false, error: "这个项目已不存在，不能排程" };
    if (project.status !== "active") {
      return { ok: false, error: `项目「${project.name}」${project.status === "paused" ? "已暂停" : "已完成"}，不能排程` };
    }
    return { ok: true, owner: { sessionKey, kind: "project", projectId, ...(channelId ? { channelId } : {}) } };
  }

  const rt = channelId ? env.channel(channelId) : undefined;
  const mainChat = rt?.mainUserEnabled ? rt.mainUserChatId : undefined;
  if (rt && mainChat && chatKey === makeChatKey(rt.id, mainChat)) {
    const mainSessionKey = rt.workspaceDir ? normalizeSessionKey(`${chatKey}::${rt.workspaceDir}`) || `${chatKey}::${rt.workspaceDir}` : "";
    if (mainSessionKey && sessionKey === mainSessionKey) {
      return { ok: true, owner: { sessionKey, kind: "main", channelId: rt.id } };
    }
    if (rt.type === "app") return { ok: true, owner: { sessionKey, kind: "chat", channelId: rt.id } };
  }
  return { ok: false, error: "只有主用户的会话和活跃的项目会话可以给自己排程（定时任务、群聊、别人的私聊不行；飞书 / 微信里只有主会话可以）" };
}

export type AiScheduleResult =
  | { ok: true; task: ScheduledTask; nextRuns: string[] }
  | { ok: false; error: string };

// ── 间隔 / cron ────────────────────────────────────────

/**
 * 「每 N 分钟」转 cron。只收能均匀切开一小时 / 一天的间隔，
 * 否则 cron 会在整点附近出现一次比 N 短的间隔（例如每 7 分钟：…:56 之后 :00 只隔 4 分钟）。
 */
export function everyMinutesToCron(n: number): { ok: true; cron: string } | { ok: false; error: string } {
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "every_minutes 必须是正整数" };
  if (n < 60) {
    if (60 % n !== 0) return { ok: false, error: `every_minutes=${n} 不能均匀切开一小时，请用 5/6/10/12/15/20/30 分钟，或直接给 cron` };
    return { ok: true, cron: n === 1 ? "* * * * *" : `*/${n} * * * *` };
  }
  if (n % 60 !== 0) return { ok: false, error: `every_minutes=${n} 请用整小时（60 的倍数），或直接给 cron` };
  const hours = n / 60;
  if (24 % hours !== 0) return { ok: false, error: `every_minutes=${n}（${hours} 小时）不能均匀切开一天，请用 1/2/3/4/6/8/12/24 小时，或直接给 cron` };
  return { ok: true, cron: hours === 24 ? "0 0 * * *" : hours === 1 ? "0 * * * *" : `0 */${hours} * * *` };
}

const GAP_SAMPLE = 12;

/** 接下来若干次触发里相邻最小间隔（分钟）；cron 无效返回 null；不足两次触发返回 Infinity */
export function minGapMinutes(cron: string, from: Date = new Date()): number | null {
  try {
    const it = CronExpressionParser.parse(cron.trim(), { currentDate: from });
    const times = it.take(GAP_SAMPLE).map((d) => d.toDate().getTime());
    if (times.length < 2) return Number.POSITIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < times.length; i++) min = Math.min(min, times[i] - times[i - 1]);
    return min / 60_000;
  } catch {
    return null;
  }
}

function previewRuns(cron: string, from: Date, count = 3): string[] {
  try {
    return CronExpressionParser.parse(cron.trim(), { currentDate: from })
      .take(count)
      .map((d) => d.toDate().toLocaleString("zh-CN", { hour12: false }));
  } catch {
    return [];
  }
}

// ── 创建 ───────────────────────────────────────────────

function positiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 校验 AI 的排程请求并构造任务。
 * activeCount = 该会话现有的活跃 AI 排程数（含未到期、未用完的）。
 */
export function buildAiScheduleTask(
  input: AiScheduleInput,
  owner: AiScheduleOwner,
  ctx: { now: number; activeCount: number; id: string },
): AiScheduleResult {
  const L = AI_SCHEDULE_LIMITS;
  const fail = (error: string): AiScheduleResult => ({ ok: false, error });

  const name = input.name?.trim() ?? "";
  if (!name) return fail("缺少 name：给这个排程起个能看懂的短名字");
  if (name.length > L.maxNameLength) return fail(`name 太长（最多 ${L.maxNameLength} 字）`);

  const prompt = input.prompt?.trim() ?? "";
  if (!prompt) return fail("缺少 prompt：到点时要执行的内容（写成自包含的指令，执行者看不到你现在的上下文）");
  if (prompt.length > L.maxPromptLength) return fail(`prompt 太长（最多 ${L.maxPromptLength} 字）`);

  const mode = input.mode?.trim() || "fresh";
  if (mode !== "fresh" && mode !== "session") return fail('mode 只能是 "fresh"（每次新 Agent 执行，结果投回本会话）或 "session"（到点提醒本会话自己做）');

  const hasCron = !!input.cron?.trim();
  const hasEvery = input.everyMinutes !== undefined && input.everyMinutes !== null;
  if (hasCron === hasEvery) return fail("cron 和 every_minutes 必须二选一");
  let cron = input.cron?.trim() ?? "";
  if (hasEvery) {
    const r = everyMinutesToCron(input.everyMinutes as number);
    if (!r.ok) return fail(r.error);
    cron = r.cron;
  }

  const now = new Date(ctx.now);
  const gap = minGapMinutes(cron, now);
  if (gap === null) return fail(`cron 表达式无效：${cron}`);
  if (gap < L.minIntervalMinutes) return fail(`触发太密：相邻两次最短只隔 ${Math.round(gap * 100) / 100} 分钟，最小间隔 ${L.minIntervalMinutes} 分钟`);

  if (input.maxRuns !== undefined && input.maxRuns !== null) {
    if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > L.maxRunsCap) {
      return fail(`max_runs 必须是 1~${L.maxRunsCap} 的整数`);
    }
  }
  if (input.expiresInHours !== undefined && input.expiresInHours !== null) {
    if (!positiveNumber(input.expiresInHours) || input.expiresInHours > L.maxExpiryHours) {
      return fail(`expires_in_hours 必须在 0~${L.maxExpiryHours} 小时之间`);
    }
  }
  if (input.maxRuns === undefined && input.expiresInHours === undefined) {
    return fail("必须设置 max_runs（最多触发几次）或 expires_in_hours（多久后过期）至少一个：AI 排程不允许无限期运行");
  }

  if (ctx.activeCount >= L.maxActivePerSession) {
    return fail(`本会话已有 ${ctx.activeCount} 个排程（上限 ${L.maxActivePerSession}）：先用 schedule_list 看看，schedule_cancel 取消不再需要的`);
  }

  const task: ScheduledTask = {
    id: ctx.id,
    name,
    cron,
    content: prompt,
    enabled: true,
    independent: mode === "fresh",
    ...(owner.channelId ? { channelId: owner.channelId } : {}),
    ...(mode === "fresh" ? { notify: "agent" as const } : {}),
    ...(owner.kind === "project" && owner.projectId ? { targetProjectId: owner.projectId } : {}),
    createdBy: "ai",
    createdAt: ctx.now,
    ownerSessionKey: owner.sessionKey,
    ...(input.maxRuns !== undefined && input.maxRuns !== null ? { maxRuns: input.maxRuns } : {}),
    ...(positiveNumber(input.expiresInHours) ? { expiresAt: ctx.now + Math.round(input.expiresInHours * 3_600_000) } : {}),
  };
  return { ok: true, task, nextRuns: previewRuns(cron, now) };
}

// ── 触发判定 ───────────────────────────────────────────

export type AiFireDecision =
  | { fire: true; run: number; last: boolean }
  | { fire: false; retire: string };

/** AI 排程到点了：还能不能触发、是第几次、是不是最后一次；不能触发就给出作废原因 */
export function evaluateAiTaskFire(
  task: Pick<ScheduledTask, "maxRuns" | "expiresAt">,
  runsSoFar: number,
  now: number,
): AiFireDecision {
  if (task.expiresAt !== undefined && now >= task.expiresAt) return { fire: false, retire: "已过期" };
  if (task.maxRuns !== undefined && runsSoFar >= task.maxRuns) return { fire: false, retire: `已触发满 ${task.maxRuns} 次` };
  const run = runsSoFar + 1;
  return { fire: true, run, last: task.maxRuns !== undefined && run >= task.maxRuns };
}

// ── 列表 / 归属 ────────────────────────────────────────

/**
 * 设置页保存任务列表时合并：AI 排程不归设置页管（不能新增 / 改 / 删，只能取消），一律以文件里的为准；
 * 否则界面里的旧快照会把 AI 刚建的排程盖掉。界面专用的临时字段（runCount）不落盘。
 */
export function mergeSavedTasksKeepingAi(saved: readonly ScheduledTask[], current: readonly ScheduledTask[]): ScheduledTask[] {
  const userTasks = saved.filter((t) => !isAiTask(t)).map((t) => {
    const { runCount: _runCount, ...rest } = t;
    return rest;
  });
  return [...userTasks, ...current.filter(isAiTask)];
}

/** 某会话名下的 AI 排程 */
export function aiTasksOwnedBy(tasks: readonly ScheduledTask[], ownerSessionKey: string): ScheduledTask[] {
  return tasks.filter((t) => isAiTask(t) && t.ownerSessionKey === ownerSessionKey);
}

/** 还没作废的（没过期、没用完）。已作废但尚未被清理的不占名额 */
export function isAiTaskLive(task: ScheduledTask, runsSoFar: number, now: number): boolean {
  return evaluateAiTaskFire(task, runsSoFar, now).fire;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** schedule_list 里一行 */
export function describeAiTask(task: ScheduledTask, runsSoFar: number, now: number): string {
  const kind = task.independent === false ? "到点提醒本会话" : "每次新 Agent 执行，结果投回本会话";
  const progress = task.maxRuns !== undefined ? `已触发 ${runsSoFar}/${task.maxRuns} 次` : `已触发 ${runsSoFar} 次`;
  const expiry = task.expiresAt !== undefined ? `，${stamp(task.expiresAt)} 过期` : "";
  const state = isAiTaskLive(task, runsSoFar, now) ? "" : "（已作废，稍后清理）";
  return `- id=${task.id}｜${task.name}｜cron: ${task.cron}｜${kind}｜${progress}${expiry}${state}`;
}
