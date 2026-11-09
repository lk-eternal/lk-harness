// AI 排程的累计触发次数：单独一个状态文件，不写进 scheduled-tasks.json。
// 任务文件一变调度器就会重载；每次触发都改它会让调度器不停重载、也会和设置页的保存互相覆盖。
// daemon 写，Electron 读（设置页显示「已触发 n/m 次」）。

import * as path from "node:path";
import { atomicWriteUtf8, readJsonFile } from "./atomic-json.js";
import { configDir } from "./data-paths.js";

export function aiScheduleStateFile(userDataRoot: string): string {
  return path.join(configDir(userDataRoot), "ai-schedule-state.json");
}

/** 读失败 / 文件损坏 / 内容不合法一律当作没有记录（只丢次数，不影响任务本身） */
export function readAiScheduleRuns(file: string): Record<string, number> {
  let raw: { runs?: unknown };
  try {
    raw = readJsonFile<{ runs?: unknown }>(file, {});
  } catch {
    return {};
  }
  const runs = raw?.runs;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) return {};
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(runs as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[id] = Math.floor(n);
  }
  return out;
}

export function writeAiScheduleRuns(file: string, runs: Record<string, number>): void {
  atomicWriteUtf8(file, JSON.stringify({ runs }, null, 2));
}
