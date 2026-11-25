// ── 定时任务运行记录：每次到点留一条短记录，设置页据此显示「上次什么时候跑、结果怎样」 ─────────
// 渲染进程要用这里的类型和文案，所以本文件不许引入带 node 依赖的模块；读写文件在 task-run-log.ts。

import { formatFireTime } from "./session-schedule.js";

/**
 * 一次到点的结果：
 *  - triggered：已触发。独立运行的任务结果还没回来（或这一轮没有走到出结果就中断了）；直投 Agent 会话的任务到这里就是终点；
 *  - reported：已汇报，AI 提交了结果；
 *  - quiet：无需汇报，AI 说没事可报，或运行结束时没提交结果（没提交就静默，不再给用户发提示）；
 *  - no-result：旧版本留下的记录（执行完了却没提交结果，而任务要求通知到 IM），现在不再产生；
 *  - undelivered：没送出去（没投进队列，或结果发不出去），detail 写原因；
 *  - skipped：AI 排程本次跳过，detail 写原因；
 *  - missed：错过，电脑休眠 / 关机 / 应用没开，没触发。
 */
export type TaskRunKind =
  | "triggered"
  | "reported"
  | "quiet"
  | "no-result"
  | "undelivered"
  | "skipped"
  | "missed";

export interface TaskRunRecord {
  /** 计划触发时间（毫秒）；手动触发是点击时间；missed 是合并的这批里最近一个错过的触发点 */
  at: number;
  kind: TaskRunKind;
  /** 一句短原因 / 去向，不存任务正文和结果内容 */
  detail?: string;
  /** 设置页「立即执行」触发的 */
  manual?: true;
  /** missed：这一批错过了几次 */
  count?: number;
}

/** 任务 id → 运行记录，新的在前 */
export type TaskRunLog = Record<string, TaskRunRecord[]>;

/** 每个任务只留最近这么多条 */
export const MAX_RUNS_PER_TASK = 20;

const MAX_DETAIL_LENGTH = 80;

const KIND_LABEL: Record<TaskRunKind, string> = {
  triggered: "已触发",
  reported: "已汇报",
  quiet: "无需汇报",
  "no-result": "没提交结果",
  undelivered: "没送出去",
  skipped: "跳过",
  missed: "错过",
};

export type TaskRunTone = "ok" | "muted" | "warn" | "bad";

const KIND_TONE: Record<TaskRunKind, TaskRunTone> = {
  reported: "ok",
  triggered: "muted",
  quiet: "muted",
  "no-result": "warn",
  skipped: "warn",
  undelivered: "bad",
  missed: "bad",
};

/** 界面上用什么颜色提示：失败和错过要醒目，正常的不抢眼 */
export function runTone(kind: TaskRunKind): TaskRunTone {
  return KIND_TONE[kind];
}

function clipDetail(detail: string | undefined): string | undefined {
  const text = detail?.trim();
  if (!text) return undefined;
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

/** 新记录放最前，超出条数上限的旧记录丢掉 */
export function appendRun(records: readonly TaskRunRecord[], rec: TaskRunRecord): TaskRunRecord[] {
  const { detail, ...rest } = rec;
  const clipped = clipDetail(detail);
  return [{ ...rest, ...(clipped ? { detail: clipped } : {}) }, ...records].slice(0, MAX_RUNS_PER_TASK);
}

/**
 * 把触发点 at 的那条记录改成最终结果（独立运行的任务，结果要等 AI 做完才知道）。
 * from 给了就只改当前还是这个状态的记录，避免后到的「没提交结果」盖掉先到的「没送出去」。
 * 找不到记录（重启后接不上、已被挤出上限）时原样返回同一个数组。
 */
export function settleRun(
  records: readonly TaskRunRecord[],
  at: number,
  patch: { kind: TaskRunKind; detail?: string },
  from?: TaskRunKind,
): readonly TaskRunRecord[] {
  const index = records.findIndex((r) => r.at === at && (from === undefined || r.kind === from));
  if (index < 0) return records;
  const old = records[index];
  const detail = clipDetail(patch.detail);
  const settled: TaskRunRecord = {
    at: old.at,
    kind: patch.kind,
    ...(detail ? { detail } : {}),
    ...(old.manual ? { manual: true as const } : {}),
  };
  return records.map((r, i) => (i === index ? settled : r));
}

function parseRecord(raw: unknown): TaskRunRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return undefined;
  if (typeof r.kind !== "string" || !(r.kind in KIND_LABEL)) return undefined;
  const detail = typeof r.detail === "string" ? clipDetail(r.detail) : undefined;
  const count = typeof r.count === "number" && Number.isFinite(r.count) ? Math.floor(r.count) : 0;
  return {
    at: r.at,
    kind: r.kind as TaskRunKind,
    ...(detail ? { detail } : {}),
    ...(r.manual === true ? { manual: true as const } : {}),
    ...(count > 1 ? { count } : {}),
  };
}

/** 读文件得到的内容不可信：不合法的条目丢掉，合法的保留，每个任务按条数上限截断 */
export function parseTaskRunLog(raw: unknown): TaskRunLog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TaskRunLog = {};
  for (const [taskId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const records = list
      .map(parseRecord)
      .filter((r): r is TaskRunRecord => r !== undefined)
      .slice(0, MAX_RUNS_PER_TASK);
    if (records.length > 0) out[taskId] = records;
  }
  return out;
}

export function runKindLabel(rec: Pick<TaskRunRecord, "kind" | "count">): string {
  const label = KIND_LABEL[rec.kind];
  return rec.kind === "missed" && rec.count !== undefined && rec.count > 1 ? `${label} ${rec.count} 次` : label;
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 过去的时间：今天 / 昨天写成「今天 09:00」「昨天 09:00」，更早写「月/日 时:分」 */
export function formatRunTime(at: number, now: number): string {
  const d = new Date(at);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (daysAgo === 0) return `今天 ${clock}`;
  if (daysAgo === 1) return `昨天 ${clock}`;
  return formatFireTime(at, now);
}

function runTimeText(rec: TaskRunRecord, now: number): string {
  return `${formatRunTime(rec.at, now)}${rec.manual ? "（手动）" : ""}`;
}

/** 详情里的一行：「今天 09:00 已汇报 · IM」 */
export function describeRun(rec: TaskRunRecord, now: number): string {
  return `${runTimeText(rec, now)} ${runKindLabel(rec)}${rec.detail ? ` · ${rec.detail}` : ""}`;
}

/** 这两种不算「执行过」：到点没跑起来（错过），或被关卡挡掉（跳过） */
const NOT_EXECUTED: ReadonlySet<TaskRunKind> = new Set<TaskRunKind>(["missed", "skipped"]);

/** 最近一次执行的时间：真的触发过的记录里最新的一条（没送出去也算触发过）；一次都没有返回 undefined */
export function lastExecutedAt(records: readonly TaskRunRecord[] | undefined): number | undefined {
  let latest: number | undefined;
  for (const r of records ?? []) {
    if (NOT_EXECUTED.has(r.kind)) continue;
    if (latest === undefined || r.at > latest) latest = r.at;
  }
  return latest;
}

/**
 * 任务列表的顺序：停用的排最后；其余按最近一次执行的时间从新到旧（刚执行完的在最前面），
 * 还没执行过的排在执行过的后面；时间相同 / 都没执行过的保持原来的先后。
 * 停用的任务内部也按同样的规则排。
 */
export function sortTasksForList<T extends { id: string; enabled: boolean }>(tasks: readonly T[], log: TaskRunLog): T[] {
  return tasks
    .map((task, index) => ({ task, index, ran: lastExecutedAt(log[task.id]) }))
    .sort((a, b) => {
      if (a.task.enabled !== b.task.enabled) return a.task.enabled ? -1 : 1;
      if (a.ran !== b.ran) {
        if (a.ran === undefined) return 1;
        if (b.ran === undefined) return -1;
        return b.ran - a.ran;
      }
      return a.index - b.index;
    })
    .map((x) => x.task);
}

/** 任务列表里的一行：「上次：今天 09:00 已汇报」；还没有记录返回空串 */
export function describeLastRun(records: readonly TaskRunRecord[] | undefined, now: number): string {
  const last = records?.[0];
  return last ? `上次：${runTimeText(last, now)} ${runKindLabel(last)}` : "";
}
