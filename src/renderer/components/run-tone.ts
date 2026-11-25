import type { TaskRunTone } from "../../shared/task-run-log-rules"

/** 运行记录一行的文字颜色：失败 / 错过醒目，正常的不抢眼（设置页和对话页的定时栏共用） */
export const RUN_TONE_CLASS: Record<TaskRunTone, string> = {
  ok: "text-success",
  muted: "text-fg-muted",
  warn: "text-warning",
  bad: "text-danger",
}
