// ── 项目接入聊天入口：执行层（建专属群、绑已有群、接主聊天、清项目的所有会话） ───────────────
// 谁能选什么、选得对不对由 src/shared/project-bindings.ts 判断；这里只管把选定的入口落到项目上。
// 一个项目可以同时接入多个入口，每个入口一条独立会话（会话键 = 聊天键::project_<id>），互不合并。

import { getChannel, getChannels } from "./config-store"
import { httpPost } from "./daemon-client"
import { APP_CHANNEL_CHAT_ID, makeChatKey, parseChatKey } from "../src/shared/channel-types.js"
import { isRepoInfoKey } from "../src/shared/project-repo-info.js"
import { findProjectByGroupChat, saveProject } from "../src/shared/project-store.js"
import {
  addProjectBinding,
  parseExistingGroupChatBinding,
  projectSessionKey,
  projectSessionKeys,
  type Project,
  type ProjectBinding,
} from "../src/shared/project-types.js"
import type { BindingChannelFacts } from "../src/shared/project-bindings.js"

/** 通道配置 → 规划接入点要用的事实（不含密钥） */
export function bindingChannelFacts(): BindingChannelFacts[] {
  return getChannels().map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    enabled: c.enabled !== false,
    mainUserEnabled: c.mainUserEnabled,
    mainUserChatId: c.mainUserChatId,
    mainUserOpenId: c.mainUserOpenId,
  }))
}

/** 飞书群描述上限 100 字：写项目目标；没写目标的写第一个代码仓库那行（目录 + 分支） */
function projectGroupDescription(project: Project): string {
  const goal = (project.goal || "").trim()
  const repoLine = Object.entries(project.metadata ?? {}).find(([k, v]) => isRepoInfoKey(k) && v.trim())?.[1] ?? ""
  return (goal || repoLine).slice(0, 100)
}

/** 独立群的群名 */
export function projectGroupName(project: Pick<Project, "name">): string {
  return `📦 ${project.name}`
}

/** 通道主聊天的聊天键：应用内对话是固定的那个；飞书 / 微信是主用户的私聊；还没绑主用户返回 undefined */
export function mainChatKeyOfChannel(channelId: string): string | undefined {
  const ch = getChannel(channelId)
  if (!ch) return undefined
  if (ch.type === "app") return makeChatKey(ch.id, APP_CHANNEL_CHAT_ID)
  const chatId = ch.mainUserChatId?.trim()
  return chatId ? makeChatKey(ch.id, chatId) : undefined
}

/**
 * 项目接入这个通道的主聊天。知道主聊天是谁（应用内对话、已绑定的主用户）就顺手记下会话键，
 * 定时任务投递、删项目清会话都靠它；不知道的话等第一次进入项目时再补。
 */
export function connectMainBinding(project: Project, channelId: string, chatKey?: string): ProjectBinding {
  const key = chatKey ?? mainChatKeyOfChannel(channelId)
  const binding = addProjectBinding(project, {
    kind: "main",
    channelId,
    ...(key ? { sessionKey: projectSessionKey(key, project.id) } : {}),
  })
  saveProject(project)
  return binding
}

export type GroupBindResult =
  | { ok: true; binding: ProjectBinding; chatKey: string; rawChatId: string; groupName?: string }
  | { ok: false; error: string }

/** 建项目专属群并接入（群主 = ownerOpenId，也被拉进群）；失败不改项目 */
export async function createGroupBinding(
  port: number,
  project: Project,
  channelId: string,
  ownerOpenId: string,
): Promise<GroupBindResult> {
  if (!ownerOpenId) return { ok: false, error: "缺少操作者 open_id（建独立群要把他设为群主并拉进群）" }
  try {
    const r = await httpPost(`http://127.0.0.1:${port}/create-project-group`, {
      name: projectGroupName(project),
      description: projectGroupDescription(project),
      channelId,
      ownerOpenId,
    }, 15000) as { ok?: boolean; chatKey?: string; error?: string } | null
    if (!r?.ok || !r.chatKey) return { ok: false, error: r?.error || "建群失败" }
    const binding = addProjectBinding(project, {
      kind: "group",
      channelId,
      chatKey: r.chatKey,
      sessionKey: projectSessionKey(r.chatKey, project.id),
    })
    saveProject(project)
    return { ok: true, binding, chatKey: r.chatKey, rawChatId: parseChatKey(r.chatKey).chatId, groupName: projectGroupName(project) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 绑定已有飞书群（机器人要已经在群里）；群已经属于别的项目就拒绝；失败不改项目 */
export function bindExistingGroup(project: Project, channelId: string, existingInput: string): GroupBindResult {
  const parsed = parseExistingGroupChatBinding(existingInput, channelId)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  const taken = findProjectByGroupChat(parsed.chatKey)
  if (taken && taken.id !== project.id) {
    return { ok: false, error: `该群已绑定项目「${taken.name}」(${taken.id})` }
  }
  const binding = addProjectBinding(project, {
    kind: "group",
    channelId,
    chatKey: parsed.chatKey,
    sessionKey: projectSessionKey(parsed.chatKey, project.id),
  })
  saveProject(project)
  return { ok: true, binding, chatKey: parsed.chatKey, rawChatId: parsed.rawChatId }
}

/**
 * 一个入口上这个项目的会话键：入口上记着就用记着的；没记着时专属群由群号推出来，主聊天由通道的主聊天推出来。
 * 推不出来（通道没绑主用户、老项目没进入过）返回 undefined。
 */
export function bindingSessionKey(project: Pick<Project, "id">, binding: ProjectBinding): string | undefined {
  if (binding.sessionKey) return binding.sessionKey
  const chatKey = binding.kind === "group" ? binding.chatKey : mainChatKeyOfChannel(binding.channelId)
  return chatKey ? projectSessionKey(chatKey, project.id) : undefined
}

/**
 * 删项目时要收拾的所有会话键：项目每个入口上记着的会话，加上应用内对话通道的会话——
 * 应用内的会话键只由通道推出来，不管项目记没记过都一并清，不然项目被别的通道改过绑定之后，应用里会留下找不到项目的幽灵会话。
 */
export function projectCleanupSessionKeys(project: Project): string[] {
  const keys = new Set(projectSessionKeys(project))
  for (const ch of getChannels()) {
    if (ch.type === "app") keys.add(projectSessionKey(makeChatKey(ch.id, APP_CHANNEL_CHAT_ID), project.id))
  }
  return [...keys]
}