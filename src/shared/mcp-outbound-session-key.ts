import {
  findScheduledTaskBySessionKey,
  resolveTaskOutboundChatKey,
  type ScheduledTask,
} from "./scheduled-task.js";

/** MCP send_* 出站路由：交互会话用 invoker；独立定时任务用 notify/outbound chatKey */
export function resolveMcpSendSessionKey(
  invoker: string | undefined,
  tasks: ScheduledTask[],
  mainUserChatIdForTask?: (task: ScheduledTask) => string | null | undefined,
): string | undefined {
  const sk = invoker?.trim();
  if (!sk) return undefined;
  const task = findScheduledTaskBySessionKey(sk, tasks);
  if (task && task.independent !== false) {
    const main = mainUserChatIdForTask?.(task);
    const notify = resolveTaskOutboundChatKey(task, main);
    if (notify) return notify;
  }
  return sk;
}
