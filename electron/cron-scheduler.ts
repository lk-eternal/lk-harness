import * as path from "node:path"
import cron from "node-cron"
import { CronExpressionParser } from "cron-parser"
import { app } from "electron"
import { readScheduledTasksFile, writeScheduledTasksFile, type ScheduledTask } from "../src/shared/scheduled-task"

function resolveTasksFile(): string {
  return path.join(app.getPath("userData"), "scheduled-tasks.json")
}

export function getTasksFilePath(): string {
  return resolveTasksFile()
}

export function readTasksFromFile(): ScheduledTask[] {
  try {
    return readScheduledTasksFile(resolveTasksFile())
  } catch {
    return []
  }
}

export function writeTasksToFile(tasks: ScheduledTask[]): void {
  try {
    readScheduledTasksFile(resolveTasksFile())
  } catch {
    return
  }
  try {
    writeScheduledTasksFile(resolveTasksFile(), tasks)
  } catch { /* ignore */ }
}

export function validateCron(expression: string): boolean {
  return cron.validate(expression)
}

const PREVIEW_COUNT = 5

export function previewCronNextRuns(expression: string): { ok: true; runs: string[] } | { ok: false; error: string } {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { ok: false, error: "表达式为空" }
  }
  if (!cron.validate(trimmed)) {
    return { ok: false, error: "与当前调度器校验不符" }
  }
  try {
    const interval = CronExpressionParser.parse(trimmed, { currentDate: new Date() })
    const dates = interval.take(PREVIEW_COUNT)
    const runs = dates.map((d) =>
      d.toDate().toLocaleString("zh-CN", { hour12: false }),
    )
    return { ok: true, runs }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 下一次计划触发时间（本地），用于 /task ls 等；失败时返回说明性短句。
 *
 * @param expression cron 表达式
 * @returns 已格式化的本地时间字符串或错误说明
 */
export function getNextCronFireLabel(expression: string): string {
  const r = previewCronNextRuns(expression.trim())
  if (!r.ok) {
    return `无法推算（${r.error}）`
  }
  return r.runs[0] ?? "—"
}

