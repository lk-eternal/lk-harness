import { createHash } from "node:crypto"
import { app } from "electron"
import { getConfig, getChannel } from "./config-store"
import { listEnabledHarnessRules, ruleAppliesTo } from "./harness-rule-store"
import { channelIdFromSessionKey, chatIdFromSessionKey, parseChatKey, resolveChannelAudience, resolveChannelScene } from "../src/shared/channel-types.js"
import { projectIdFromSessionKey } from "../src/shared/project-types.js"
import { getProject, projectNodes } from "../src/shared/project-store.js"
import { findScheduledTaskBySessionKey } from "../src/shared/scheduled-task.js"
import { buildTaskProtocolSection } from "../src/shared/task-delivery.js"
import { shouldMountMemoryMcp, type HarnessMcpEndpoint } from "../src/shared/harness-mcp-store.js"
import { IDENTITY_BLOCK, buildCapabilityBlock } from "../src/shared/capability-index.js"
import { memoryForPrompt, readSessionMemory } from "../src/shared/session-memory.js"
import { buildVisitorPromptSection, type VisitorLimits } from "../src/shared/visitor-limits.js"
import { joinPromptBlocks, promptAttr } from "../src/shared/prompt-markup.js"
import { readTasksFromFile } from "./cron-scheduler"
import { readLockFile } from "./daemon-client"
import { getDaemonPort } from "./workspace-injector"
import type { LaunchMeta } from "./agent-session-types"

export interface PromptAssemblyContext {
  meta?: LaunchMeta
  sessionKey?: string
  useMainWorkspace?: boolean
  /** 主用户私聊：能力里列出自管理组并挂载 lk-harness-admin 工具 */
  includeAdmin?: boolean
  notifySessionKey?: string
  taskMessage?: string
  historyTurns?: HistoryTurn[]
  digitalIdentityOverride?: string
  /** 访客档（其他人的受限会话）：提示词里告诉 AI 它能做什么、不能做什么；变了就算规则变了 */
  visitor?: VisitorLimits
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim()
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return raw.trim()
  return raw.slice(end + 4).trim()
}

export interface QuotedMessagePayload {
  message_id: string
  sender_type: string
  sender_open_id?: string
  text: string
}

export interface TurnMessage {
  text: string
  messageId?: string
  meta?: {
    chatType?: string
    senderOpenId?: string
    senderType?: string
    quoted_message?: QuotedMessagePayload
  }
}

/** 跨账本搬运历史：role + text + 可选引用，无 message_id，不进 poll 去重 */
export interface HistoryTurn {
  role: "user" | "assistant"
  text: string
  quoted_message?: QuotedMessagePayload
}

/** 当前实例 Daemon 的端口：优先 lock 文件（与当前 profile 实例一致） */
export function resolveDaemonPortForPrompt(): number | null {
  const lock = readLockFile()
  if (lock?.port) return lock.port
  const injected = getDaemonPort()
  if (injected) return injected
  const cfg = getConfig().daemonPort
  return cfg > 0 ? cfg : null
}

function isProjectSession(meta?: LaunchMeta, sessionKey?: string): boolean {
  return meta?.chatType === "project" || !!sessionKey?.includes("::project_")
}

export function shouldSkipDigitalIdentity(meta?: LaunchMeta, sessionKey?: string, useMainWorkspace?: boolean): boolean {
  return !!useMainWorkspace || isProjectSession(meta, sessionKey) || meta?.chatType === "task" || meta?.chatType === "temp"
}

function resolveDigitalIdentity(skipIdentity: boolean, override?: string): string {
  if (skipIdentity) return ""
  return (override ?? getConfig().digitalIdentity ?? "").trim()
}

function resolvePromptRuleScope(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey">): { channelId?: string; audience: "main" | "others"; scene?: "dm" | "group" } {
  const sessionKey = ctx.sessionKey ?? ""
  const chatType = ctx.meta?.chatType
  const chatKey = sessionKey ? chatIdFromSessionKey(sessionKey) : (ctx.meta?.chatId ?? "")
  let channelId = sessionKey ? channelIdFromSessionKey(sessionKey) : undefined
  let channel = channelId ? getChannel(channelId) : undefined
  if (!channel && ctx.meta?.chatId) {
    const parsed = parseChatKey(ctx.meta.chatId)
    if (parsed.channelId) {
      channel = getChannel(parsed.channelId)
      channelId = parsed.channelId
    }
  }
  const scene = resolveChannelScene({
    mainUserEnabled: channel?.mainUserEnabled,
    mainUserChatId: channel?.mainUserChatId,
    chatKey,
    chatType,
    sessionKey,
  })
  const audience = scene === "main" ? "main" : "others"
  return { channelId: channel?.id ?? channelId, audience, ...(scene === "dm" || scene === "group" ? { scene } : {}) }
}

/** 每条规则一个标签，规则正文里自带的标题层级原样保留，不和外层标题混；没有适用的规则返回空串 */
function buildUserRulesBlock(ctx?: Pick<PromptAssemblyContext, "meta" | "sessionKey">): string {
  const scope = resolvePromptRuleScope(ctx ?? {})
  const rules = listEnabledHarnessRules().filter((r) => ruleAppliesTo(r, scope.channelId, scope.audience, scope.scene))
  if (!rules.length) return ""
  const items = rules.map((r) => `<rule name="${promptAttr(r.name)}">\n${stripFrontmatter(r.content)}\n</rule>`)
  return ["# 用户规则", ...items].join("\n\n")
}

/** 这个会话挂的是哪种内置端点：和 agent-sdk / pi-embedded 挂载工具时的判定一致 */
function resolveMcpEndpoint(ctx: Pick<PromptAssemblyContext, "meta" | "visitor">): HarnessMcpEndpoint {
  return ctx.meta?.chatType === "task" ? "task" : ctx.visitor ? "visitor" : "interactive"
}

/** 首轮要不要带入会话记忆：与 lk-harness-memory 工具的挂载条件同一个判定（交互会话，不含独立任务和访客） */
function ctxIncludeMemory(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey" | "visitor">): boolean {
  return shouldMountMemoryMcp({ endpoint: resolveMcpEndpoint(ctx), sessionKey: ctx.sessionKey })
}

/**
 * 独立定时任务会话的协议段：告诉 AI 它的输出没人看、结果要用 send_result 交付，以及结果会去哪。
 * 不是独立任务会话（含非独立任务、普通会话）返回空串。读任务文件失败也按「不是」处理，不阻断拉起。
 */
function resolveTaskProtocolSection(ctx: Pick<PromptAssemblyContext, "sessionKey">): string {
  const sk = ctx.sessionKey?.trim()
  if (!sk) return ""
  try {
    const task = findScheduledTaskBySessionKey(sk, readTasksFromFile())
    if (!task) return ""
    return buildTaskProtocolSection(task, {
      channelName: (id) => (id ? getChannel(id)?.name : undefined),
      projectName: (id) => getProject(id)?.name,
    })
  } catch {
    return ""
  }
}

/** 宿主提示词的各个块（身份、能力、数字身份、用户规则、任务段、访客段），没内容的块不出现；块之间用 joinPromptBlocks 连 */
export function assembleProtocolBlocks(ctx: PromptAssemblyContext): string[] {
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  const blocks = [
    IDENTITY_BLOCK,
    buildCapabilityBlock({
      endpoint: resolveMcpEndpoint(ctx),
      includeAdmin: ctx.includeAdmin === true,
      includeProject: isProjectSession(ctx.meta, ctx.sessionKey),
      sessionKey: ctx.sessionKey,
    }),
    identity ? `# 数字身份\n${identity}` : "",
    buildUserRulesBlock(ctx),
    resolveTaskProtocolSection(ctx),
    ctx.visitor ? buildVisitorPromptSection(ctx.visitor) : "",
  ]
  return blocks.filter((b) => b.length > 0)
}

export function hashSystemPrompt(text: string): string {
  return createHash("md5").update(text).digest("hex").slice(0, 16)
}

/** 宿主提示词的指纹：就是实际给 AI 的那段文本的哈希，给了什么就是什么，不再另列一份「哪些输入算数」 */
export function computePromptHash(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey" | "useMainWorkspace" | "digitalIdentityOverride" | "includeAdmin" | "visitor">): string {
  return hashSystemPrompt(joinPromptBlocks(assembleProtocolBlocks(ctx)))
}

/**
 * SDK Session Worker：每轮全量注入宿主协议块（身份、能力、数字身份、用户规则……）。
 * skillCatalog：本机 Skill 名单，只在账本新开或名单变了的那一轮给（之后的轮次不带，已经在历史里了）。
 */
export function assembleSdkWorkerTurnPrompt(
  messages: TurnMessage[],
  ctx: PromptAssemblyContext,
  opts?: { firstTurn?: boolean; taskMessage?: string; historyTurns?: HistoryTurn[]; skillCatalog?: string },
): string {
  const blocks = assembleProtocolBlocks(ctx)
  if (opts?.skillCatalog) blocks.push(opts.skillCatalog)
  blocks.push(assembleTurnPrompt(messages, ctx, {
    firstTurn: opts?.firstTurn,
    taskMessage: opts?.taskMessage,
    historyTurns: opts?.historyTurns,
  }))
  return joinPromptBlocks(blocks)
}

/** 项目会话每轮自然语言附带：节点索引 + 发现协议（按钮 [PROJECT_ACTION] 轮跳过，抗长会话遗忘） */
function projectNodeReminder(sessionKey: string | undefined, messages: TurnMessage[]): Record<string, unknown> | undefined {
  if (!sessionKey) return undefined
  let pid: string | undefined
  try { pid = projectIdFromSessionKey(sessionKey) } catch { return undefined }
  if (!pid) return undefined
  if (messages.some((m) => (m.text ?? "").trimStart().startsWith("[PROJECT_ACTION]"))) return undefined
  if (!messages.some((m) => (m.text ?? "").trim())) return undefined
  let proj: { id: string; groupId?: string; groupIds?: string[] } | undefined
  try { proj = getProject(pid) ?? undefined } catch { return undefined }
  if (!proj) return undefined
  const nodes = projectNodes(proj).map((n) => ({ id: n.id, label: n.label }))
  if (!nodes.length) return undefined
  return {
    nodes,
    rule: `判断用户消息内容是否对应某节点，如果明确命中→先调 project_get_node(project_id=${proj.id}, node_id=命中id) 获取完整提示词再干；未命中则直接处理用户消息即可`,
  }
}

/** 首轮带给 AI 的会话记忆（key → 内容）；没挂记忆工具的会话（独立任务、访客）不带 */
function firstTurnMemory(ctx: PromptAssemblyContext): Record<string, string> | undefined {
  const sessionKey = ctx.sessionKey?.trim()
  if (!sessionKey || !ctxIncludeMemory(ctx)) return undefined
  return memoryForPrompt(readSessionMemory(app.getPath("userData"), sessionKey))
}

/** Session Worker 向 Agent 交付一批用户消息（JSON 结构化，避免正文与元数据混淆） */
export function assembleTurnPrompt(
  messages: TurnMessage[],
  ctx: PromptAssemblyContext,
  opts?: { firstTurn?: boolean; taskMessage?: string; historyTurns?: HistoryTurn[] },
): string {
  const history = (opts?.historyTurns ?? []).filter((t) => t.text?.trim()).map((t) => ({
    sender_type: t.role,
    ...(t.quoted_message ? { quoted_message: t.quoted_message } : {}),
    text: t.text.trim(),
  }))
  const sessionMeta: Record<string, string> = {}
  if (ctx.meta?.chatType) sessionMeta.chat_type = ctx.meta.chatType
  const memory = opts?.firstTurn ? firstTurnMemory(ctx) : undefined
  const payload: Record<string, unknown> = {
    ...(Object.keys(sessionMeta).length ? { session: sessionMeta } : {}),
    ...(memory ? { memory } : {}),
    messages: [
      ...history,
      ...messages.map((m) => ({
        ...(m.messageId && !m.messageId.startsWith("internal_") ? { message_id: m.messageId } : {}),
        ...(m.meta?.senderType ? { sender_type: m.meta.senderType } : {}),
        ...(m.meta?.senderOpenId ? { sender_open_id: m.meta.senderOpenId } : {}),
        ...(m.meta?.quoted_message ? { quoted_message: m.meta.quoted_message } : {}),
        text: m.text.trim(),
      })),
    ],
  }
  if (opts?.taskMessage?.trim()) payload.task = opts.taskMessage.trim()
  const nodeProtocol = projectNodeReminder(ctx.sessionKey, messages)
  if (nodeProtocol) payload.node_protocol = nodeProtocol
  return `[本轮投递]\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}
