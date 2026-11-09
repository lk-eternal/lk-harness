// 项目缺陷监控的去重记录：每个项目见过哪些缺陷。daemon 读写。
// 读坏了 / 没有文件 = 没有记录 = 下一次查询只建基线、不通知（宁可漏一轮，也不把存量缺陷当新缺陷刷一遍屏）。

import * as path from "node:path";
import { atomicWriteUtf8, readJsonFile } from "./atomic-json.js";
import { configDir } from "./data-paths.js";
import type { BugWatchEntry, BugWatchState } from "./project-bug-watch.js";

export function bugWatchStateFile(userDataRoot: string): string {
  return path.join(configDir(userDataRoot), "bug-watch-state.json");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function sanitizeEntry(raw: unknown): BugWatchEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.storyId !== "string" || !e.storyId) return undefined;
  if (!e.seen || typeof e.seen !== "object" || Array.isArray(e.seen)) return undefined;
  const seen: Record<string, string> = {};
  for (const [id, status] of Object.entries(e.seen as Record<string, unknown>)) {
    if (typeof status === "string") seen[id] = status;
  }
  return {
    storyId: e.storyId,
    ...(typeof e.storyName === "string" && e.storyName ? { storyName: e.storyName } : {}),
    seen,
    baselineAt: isFiniteNumber(e.baselineAt) ? e.baselineAt : 0,
    checkedAt: isFiniteNumber(e.checkedAt) ? e.checkedAt : 0,
  };
}

export function readBugWatchState(file: string): BugWatchState {
  let raw: { projects?: unknown };
  try {
    raw = readJsonFile<{ projects?: unknown }>(file, {});
  } catch {
    return {};
  }
  const projects = raw?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
  const out: BugWatchState = {};
  for (const [projectId, entry] of Object.entries(projects as Record<string, unknown>)) {
    const clean = sanitizeEntry(entry);
    if (clean) out[projectId] = clean;
  }
  return out;
}

export function writeBugWatchState(file: string, state: BugWatchState): void {
  atomicWriteUtf8(file, JSON.stringify({ projects: state }, null, 2));
}
