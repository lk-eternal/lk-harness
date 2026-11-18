// 定时任务 / AI 排程「投递到项目会话」时，项目会话能不能用。
// 单独成文件：依赖 project-types（带 node:path），设置页（渲染进程）不能引到，所以不放进 task-delivery.ts。

import { chatIdFromSessionKey } from "./channel-types.js";
import { projectBoundToChannel, projectSessionKeyOfChannel, projectSessionKeys, type Project } from "./project-types.js";

export type ProjectAgentTarget =
  | { ok: true; sessionKey: string; chatKey: string; label: string }
  | { ok: false; error: string; /** 目标永久失效（项目没了 / 已归档），AI 排程应作废 */ retire: boolean };

/**
 * 项目会话作为投递目标是否可用。项目在每个通道上各有一条会话，投哪条看任务所属的通道：
 * 项目没接入这个通道就不投（不会越过隔离去别的通道的会话里）。没指定通道才退回项目的第一条会话。
 */
export function resolveProjectAgentTarget(
  projectId: string,
  project: Pick<Project, "name" | "archivedAt" | "bindings"> | undefined,
  channelId?: string,
): ProjectAgentTarget {
  if (!project) return { ok: false, retire: true, error: `项目 ${projectId} 已不存在` };
  const label = `项目「${project.name}」的会话`;
  if (project.archivedAt) return { ok: false, retire: true, error: `项目「${project.name}」已归档` };
  const holder = { id: projectId, bindings: project.bindings };
  if (channelId && !projectBoundToChannel(holder, channelId)) {
    return { ok: false, retire: false, error: `项目「${project.name}」没有接入这个任务所在的消息通道，无法投递（先在项目设置里绑定这个通道）` };
  }
  const sessionKey = channelId ? projectSessionKeyOfChannel(holder, channelId) : projectSessionKeys(holder)[0];
  if (!sessionKey) {
    return { ok: false, retire: false, error: `项目「${project.name}」还没有会话（还没有进入过项目）` };
  }
  return { ok: true, sessionKey, chatKey: chatIdFromSessionKey(sessionKey), label };
}
