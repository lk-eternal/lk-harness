// 定时任务运行记录的文件读写（规则、文案在 task-run-log-rules.ts）。
// 单独一个文件，不写进 scheduled-tasks.json：任务文件一变调度器就会重载，每次触发都改它会让调度器不停重载。
// daemon 写，Electron 读（设置页显示「上次什么时候跑、结果怎样」）。
// 记录只是辅助信息：读不出来当作没有记录，丢了不影响任务本身。

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteUtf8 } from "./atomic-json.js";
import { configDir } from "./data-paths.js";
import {
  appendRun,
  parseTaskRunLog,
  settleRun,
  type TaskRunKind,
  type TaskRunLog,
  type TaskRunRecord,
} from "./task-run-log-rules.js";

export function taskRunLogFile(userDataRoot: string): string {
  return path.join(configDir(userDataRoot), "task-run-log.json");
}

interface TaskRunLogFile {
  /** daemon 最后一次确认自己还活着的时间；下次启动据此找出这段空档里错过的触发点 */
  aliveAt?: number;
  runs: TaskRunLog;
}

function load(file: string): TaskRunLogFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { runs: {} };
  }
  const obj = raw && typeof raw === "object" ? (raw as { aliveAt?: unknown; runs?: unknown }) : {};
  const aliveAt = typeof obj.aliveAt === "number" && Number.isFinite(obj.aliveAt) && obj.aliveAt > 0 ? obj.aliveAt : undefined;
  return { ...(aliveAt !== undefined ? { aliveAt } : {}), runs: parseTaskRunLog(obj.runs) };
}

function save(file: string, data: TaskRunLogFile): void {
  atomicWriteUtf8(file, JSON.stringify(data));
}

export function readTaskRuns(file: string): TaskRunLog {
  return load(file).runs;
}

export function readAliveAt(file: string): number | undefined {
  return load(file).aliveAt;
}

/** 记一条：放在这个任务记录的最前面 */
export function recordTaskRun(file: string, taskId: string, rec: TaskRunRecord): void {
  const data = load(file);
  save(file, { ...data, runs: { ...data.runs, [taskId]: appendRun(data.runs[taskId] ?? [], rec) } });
}

/** 把触发点 at 的那条记录改成最终结果；找不到或 from 对不上就什么都不写 */
export function settleTaskRun(
  file: string,
  taskId: string,
  at: number,
  patch: { kind: TaskRunKind; detail?: string },
  from?: TaskRunKind,
): void {
  const data = load(file);
  const before = data.runs[taskId] ?? [];
  const after = settleRun(before, at, patch, from);
  if (after === before) return;
  save(file, { ...data, runs: { ...data.runs, [taskId]: [...after] } });
}

/**
 * 记下「现在还活着」。顺带清掉已经不存在的任务的记录（AI 排程用完就被清理，不清会越积越多）；
 * liveTaskIds 不给（任务文件读不出来）就只记时间，不清。
 */
export function touchAlive(file: string, now: number, liveTaskIds?: ReadonlySet<string>): void {
  const data = load(file);
  const runs = liveTaskIds
    ? Object.fromEntries(Object.entries(data.runs).filter(([taskId]) => liveTaskIds.has(taskId)))
    : data.runs;
  save(file, { aliveAt: now, runs });
}
