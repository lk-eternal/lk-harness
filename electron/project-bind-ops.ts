// ── 给已有项目补接入 / 取消接入（管理 MCP 的 bind / unbind、设置页项目详情共用） ───────────
// 建项时的接入见 project-create.ts；这里管建好之后的增减。谁能接到哪些通道的规则同建项（project-bindings.ts 的 planBindingChoices）：
// 应用内通道的调用者（含设置页）可以动任何通道，飞书 / 微信通道的调用者只能动自己所在的通道。

import { getChannel } from "./config-store"
import { clearAppChatRecords } from "./app-chat"
import { purgeSessionRouting, readLockFile } from "./daemon-client"
import { attachPlannedBindings } from "./project-commands"
import { bindingChannelFacts, bindingSessionKey, mainChatKeyOfChannel } from "./project-bind"
import { leaveProjectSession, stopSessionAgent } from "./session-dispatcher"
import { channelIdFromSessionKey } from "../src/shared/channel-types.js"
import type {
  ProjectBindingChoice,
  ProjectBindingOutcome,
  ProjectBindResult,
  ProjectUnbindResult,
} from "../src/shared/project-app-types.js"
import { planBindingChoices, reachableChannels, type PlannedBinding } from "../src/shared/project-bindings.js"
import { getCurrentProjectId, saveProject, setCurrentProjectId } from "../src/shared/project-store.js"
import {
  parseExistingGroupChatBinding,
  projectBindings,
  projectBoundToChannel,
  projectGroupBindings,
  projectMainBindings,
  removeProjectBinding,
  sameChatKey,
  type Project,
  type ProjectBinding,
} from "../src/shared/project-types.js"

/** 给项目补接入。已经接着的主聊天不重复接，已经有专属群的通道不再新建（要换群先取消接入）；一个都没接成就当失败 */
export async function bindProjectChoices(
  project: Project,
  choices: ProjectBindingChoice[],
  invokerChannelId: string | undefined,
): Promise<ProjectBindResult> {
  const planned = planBindingChoices(choices, bindingChannelFacts(), invokerChannelId)
  if (!planned.ok) return planned

  const skipped: ProjectBindingOutcome[] = []
  const todo: PlannedBinding[] = []
  for (const it of planned.items) {
    const base = { channelId: it.channel.id, channelName: it.channel.name, mode: it.mode }
    if (it.mode === "inline" && projectMainBindings(project).some((b) => b.channelId === it.channel.id)) {
      skipped.push({ ...base, ok: true })
    } else if (it.mode === "group" && projectGroupBindings(project).some((b) => b.channelId === it.channel.id)) {
      skipped.push({ ...base, ok: false, warning: "这个通道已经接入了专属群，不再重复新建（要换群，先取消原来的接入）" })
    } else {
      todo.push(it)
    }
  }
  const attached = todo.length ? await attachPlannedBindings(readLockFile()?.port, project, todo) : []
  const outcomes = [...skipped, ...attached]
  const failed = outcomes.filter((o) => !o.ok).map((o) => `「${o.channelName}」${o.warning ?? "没接成"}`)
  if (!outcomes.some((o) => o.ok)) return { ok: false, error: failed.join("；") || "没有可接入的内容" }
  return {
    ok: true,
    projectId: project.id,
    name: project.name,
    bindings: outcomes,
    ...(failed.length ? { warning: `${failed.join("；")}。其余接入已生效，请如实告诉用户` } : {}),
  }
}

/** 要取消的是项目的哪个入口：inline=主聊天；group / bind=专属群（通道上有多个群时要给 group_chat_id） */
function findBindingToRemove(project: Project, choice: ProjectBindingChoice): ProjectBinding | { error: string } {
  const channelId = choice.channelId
  if (choice.mode === "inline") {
    return projectMainBindings(project).find((b) => b.channelId === channelId) ?? { error: "项目没有接入这个通道的主聊天" }
  }
  const groups = projectGroupBindings(project).filter((b) => b.channelId === channelId)
  if (choice.groupChatId?.trim()) {
    const parsed = parseExistingGroupChatBinding(choice.groupChatId, channelId)
    if ("error" in parsed) return { error: parsed.error }
    return groups.find((b) => sameChatKey(b.chatKey!, parsed.chatKey)) ?? { error: "项目没有接入这个群" }
  }
  if (groups.length === 1) return groups[0]
  return { error: groups.length ? "这个通道上接入了多个群，要给 group_chat_id 指明是哪一个" : "项目没有接入这个通道的专属群" }
}

/**
 * 取消项目在一个通道上的一个入口：把项目从那里移走，那条会话（Agent、路由、应用内聊天记录）一起收掉，
 * 停在它上面的主聊天挪回主会话。项目至少要留一个入口，不然所有通道都看不到它（想整个去掉请归档或删除项目）。
 * 专属群只是不再接入：不改名、不解散，聊天记录原样留着。
 */
export async function unbindProjectChoice(
  project: Project,
  choice: ProjectBindingChoice,
  invokerChannelId: string | undefined,
): Promise<ProjectUnbindResult> {
  const channelId = String(choice?.channelId ?? "").trim()
  if (!channelId) return { ok: false, error: "要给 channel_id" }
  if (choice.mode !== "inline" && choice.mode !== "group" && choice.mode !== "bind") {
    return { ok: false, error: "mode 只能是 inline（主聊天）/ group 或 bind（专属群）" }
  }
  const facts = bindingChannelFacts()
  const invokerIsApp = facts.find((c) => c.id === invokerChannelId)?.type === "app"
  // 应用内通道的调用者还能取消早已删掉的通道上留下的接入（通道没了，planBindingChoices 里就找不到它）
  const allowed = reachableChannels(facts, invokerChannelId).some((c) => c.id === channelId)
    || (invokerIsApp && projectBoundToChannel(project, channelId))
  if (!allowed) return { ok: false, error: `不能动通道 ${channelId} 上的接入（飞书 / 微信里只能动自己所在的通道）` }

  const found = findBindingToRemove(project, { ...choice, channelId })
  if ("error" in found) return { ok: false, error: found.error }
  if (projectBindings(project).length <= 1) {
    return { ok: false, error: "这是项目唯一的接入，取消后任何通道都看不到它了：先接入别的通道，或者直接归档 / 删除项目" }
  }

  const sessionKey = bindingSessionKey(project, found)
  const removed = removeProjectBinding(project, found)
  if (!removed) return { ok: false, error: "项目没有这个接入" }
  saveProject(project)

  const port = readLockFile()?.port
  if (removed.kind === "main") {
    const chatKey = mainChatKeyOfChannel(removed.channelId)
    if (chatKey && getCurrentProjectId(chatKey) === project.id) {
      if (port) await leaveProjectSession(port, chatKey)
      else setCurrentProjectId(null, chatKey)
    }
  }
  if (sessionKey) {
    await stopSessionAgent(sessionKey)
    if (port) await purgeSessionRouting(port, sessionKey)
    const ch = channelIdFromSessionKey(sessionKey)
    if (ch && getChannel(ch)?.type === "app") await clearAppChatRecords({ sessionKey })
  }
  const channelName = getChannel(channelId)?.name ?? channelId
  return {
    ok: true,
    projectId: project.id,
    name: project.name,
    removed: removed.kind === "main" ? `${channelName} 的主聊天` : `${channelName} 的专属群`,
    ...(removed.kind === "group" ? { note: "群没有改名也没有解散，只是不再接入这个项目" } : {}),
  }
}
