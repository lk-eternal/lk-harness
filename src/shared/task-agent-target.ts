// 定时任务 / AI 排程「投递到项目会话」时，项目会话能不能用。
// 单独成文件：依赖 project-types（带 node:path），设置页（渲染进程）不能引到，所以不放进 task-delivery.ts。

import { chatIdFromSessionKey } from "./channel-types.js";
import { projectSessionKey, type Project } from "./project-types.js";

export type ProjectAgentTarget =
  | { ok: true; sessionKey: string; chatKey: string; label: string }
  | { ok: false; error: string; /** 目标永久失效（项目没了 / 已归档），AI 排程应作废 */ retire: boolean };

/** 项目会话作为投递目标是否可用；会话 key 优先用项目记录的，没有则按独立群拼 */
export function resolveProjectAgentTarget(
  projectId: string,
  project: Pick<Project, "name" | "archivedAt" | "sessionKey" | "groupChatId"> | undefined,
): ProjectAgentTarget {
  if (!project) return { ok: false, retire: true, error: `项目 ${projectId} 已不存在` };
  const label = `项目「${project.name}」的会话`;
  if (project.archivedAt) return { ok: false, retire: true, error: `项目「${project.name}」已归档` };
  const sessionKey = project.sessionKey || (project.groupChatId ? projectSessionKey(project.groupChatId, projectId) : "");
  if (!sessionKey) {
    return { ok: false, retire: false, error: `项目「${project.name}」还没有会话（还没有进入过项目）` };
  }
  return { ok: true, sessionKey, chatKey: chatIdFromSessionKey(sessionKey), label };
}
