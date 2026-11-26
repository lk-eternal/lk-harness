import { isAiTask } from "../src/shared/ai-schedule.js"
import type { ScheduledTask } from "../src/shared/scheduled-task"
import type { BoundTaskBrief, SessionScheduleContext } from "../src/shared/session-schedule.js"
import { tasksBoundToSessions } from "../src/shared/session-schedule-build.js"
import { getChannels } from "./config-store"
import { readTasksFromFile, writeTasksToFile } from "./cron-scheduler"
import { httpPost, readLockFile } from "./daemon-client"
import { broadcastLog } from "./ui-logger"

function briefOf(task: ScheduledTask): BoundTaskBrief {
  return { id: task.id, name: task.name, origin: isAiTask(task) ? "ai" : "user" }
}

/** 删会话 / 删项目前：哪些任务挂在这些会话上（确认框列名字用；和真正删除用同一套判定） */
export function listBoundTasks(ctxs: readonly SessionScheduleContext[]): BoundTaskBrief[] {
  return tasksBoundToSessions(readTasksFromFile(), ctxs, getChannels()).map(briefOf)
}

/**
 * 取消 AI 排程：走 daemon（正在跑的先停用，不直接删）；daemon 不在就直接改文件。
 * 直接从文件里抹掉会让还在跑的那次找不到自己，所以有 daemon 时不这么做。
 */
export async function cancelAiTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
  const task = readTasksFromFile().find((t) => t.id === taskId && isAiTask(t))
  if (!task) return { ok: false, error: "排程不存在（可能已结束并被清理）" }
  const lock = readLockFile()
  if (lock?.port) {
    try {
      const r = (await httpPost(`http://127.0.0.1:${lock.port}/api/ai-task-cancel`, { taskId }, 5000)) as { ok?: boolean; error?: string } | null
      return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "取消失败" }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  writeTasksToFile(readTasksFromFile().filter((t) => t.id !== taskId))
  return { ok: true }
}

/**
 * 会话 / 项目已经删掉后，把挂在它上面的任务一起删：设置页建的任务在主进程里「读—删—写」，
 * AI 排程走取消。返回实际删掉的任务；取消失败的记日志，不回滚已经删掉的会话。
 */
export async function removeBoundTasks(ctxs: readonly SessionScheduleContext[]): Promise<BoundTaskBrief[]> {
  const bound = tasksBoundToSessions(readTasksFromFile(), ctxs, getChannels())
  const removed: BoundTaskBrief[] = []

  for (const task of bound.filter(isAiTask)) {
    const r = await cancelAiTask(task.id)
    if (r.ok) removed.push(briefOf(task))
    else broadcastLog(`[删除会话] 取消 AI 排程「${task.name}」失败: ${r.error}`, "WARN")
  }

  const userTasks = bound.filter((t) => !isAiTask(t))
  if (userTasks.length > 0) {
    const ids = new Set(userTasks.map((t) => t.id))
    writeTasksToFile(readTasksFromFile().filter((t) => !ids.has(t.id)))
    removed.push(...userTasks.map(briefOf))
  }
  return removed
}
