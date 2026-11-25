import { createHash } from "node:crypto"
import { app } from "electron"
import { getConfig, getChannel } from "./config-store"
import { listEnabledHarnessRules, ruleAppliesTo } from "./harness-rule-store"
import { CHANNEL_TYPE_LABELS, channelIdFromSessionKey, chatIdFromSessionKey, parseChatKey, resolveChannelAudience, resolveChannelScene, type MessageChannel } from "../src/shared/channel-types.js"
import { projectIdFromSessionKey } from "../src/shared/project-types.js"
import { getProject, projectNodes } from "../src/shared/project-store.js"
import { findScheduledTaskBySessionKey } from "../src/shared/scheduled-task.js"
import { buildTaskProtocolSection } from "../src/shared/task-delivery.js"
import { shouldMountMemoryMcp, type HarnessMcpEndpoint } from "../src/shared/harness-mcp-store.js"
import { IDENTITY_BLOCK, buildCapabilityBlock } from "../src/shared/capability-index.js"
import { readSessionMemory, type SessionMemoryEntry } from "../src/shared/session-memory.js"
import { MESSAGE_FORMAT_BLOCK, buildTurnEnvelope, type EnvelopeMessage, type EnvelopeNodeRouting, type EnvelopeQuote } from "../src/shared/turn-envelope.js"
import { buildVisitorPromptSection, type VisitorLimits } from "../src/shared/visitor-limits.js"
import { joinPromptBlocks, promptAttr } from "../src/shared/prompt-markup.js"
import { readTasksFromFile } from "./cron-scheduler"
import { getSkillCatalog } from "./skill-catalog"
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
  /** 入队时间（毫秒），作为这条消息的发送时间交给 AI */
  timestamp?: number
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

/** 会话所属的通道：先认会话键里的通道，没有再认启动参数里的聊天键 */
function resolvePromptChannel(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey">): { channelId?: string; channel?: MessageChannel } {
  let channelId = ctx.sessionKey ? channelIdFromSessionKey(ctx.sessionKey) : undefined
  let channel = channelId ? getChannel(channelId) : undefined
  if (!channel && ctx.meta?.chatId) {
    const parsed = parseChatKey(ctx.meta.chatId)
    if (parsed.channelId) {
      channel = getChannel(parsed.channelId)
      channelId = parsed.channelId
    }
  }
  return { channelId, channel }
}

function resolvePromptRuleScope(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey">): { channelId?: string; audience: "main" | "others"; scene?: "dm" | "group" } {
  const sessionKey = ctx.sessionKey ?? ""
  const chatType = ctx.meta?.chatType
  const chatKey = sessionKey ? chatIdFromSessionKey(sessionKey) : (ctx.meta?.chatId ?? "")
  const { channelId, channel } = resolvePromptChannel(ctx)
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

/** 宿主提示词的各个块（身份、能力、消息格式、数字身份、用户规则、任务段、访客段），没内容的块不出现；块之间用 joinPromptBlocks 连 */
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
    MESSAGE_FORMAT_BLOCK,
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

/** 宿主提示词整份：协议块加本机 Skill 名单。Pi 整份当系统提示词，SDK 按指纹决定哪一轮给 */
export interface HostPrompt {
  text: string
  /** 文本的指纹：账本里 AI 手里的那一版是不是现在这一版，就比它 */
  hash: string
}

export function buildHostPrompt(ctx: PromptAssemblyContext): HostPrompt {
  const skills = getSkillCatalog(Date.now(), ctx.visitor?.skillAllow)
  const text = joinPromptBlocks([...assembleProtocolBlocks(ctx), skills.text])
  return { text, hash: hashSystemPrompt(text) }
}

const HOST_PROMPT_UPDATE_NOTICE = "（以下协议、规则和 Skill 名单有更新，以这份为准）"

export interface HostPromptDelivery {
  /** 放进这一轮的文本；账本里已经有旧版时，开头说明以这份为准 */
  text: string
  /** 这一轮送达成功后记下的指纹 */
  hash: string
  reason: "new-ledger" | "changed"
}

/**
 * SDK 这一轮要不要给宿主提示词：账本里 AI 手里那一版（deliveredHash）和现在的一样就不给。
 * 新账本、搬运、规则或 Skill 变了、上次没送达，都是同一个判断。
 */
export function planHostPrompt(ctx: PromptAssemblyContext, deliveredHash: string | undefined): HostPromptDelivery | undefined {
  const host = buildHostPrompt(ctx)
  if (host.hash === deliveredHash) return undefined
  return deliveredHash
    ? { text: `${HOST_PROMPT_UPDATE_NOTICE}\n${host.text}`, hash: host.hash, reason: "changed" }
    : { text: host.text, hash: host.hash, reason: "new-ledger" }
}

/** SDK Session Worker 的一轮：hostPrompt 是 planHostPrompt 定下要给的整份宿主提示词，放在信封之前；不给就只有信封 */
export function assembleSdkWorkerTurnPrompt(
  messages: TurnMessage[],
  ctx: PromptAssemblyContext,
  opts?: { withMemory?: boolean; taskMessage?: string; historyTurns?: HistoryTurn[]; hostPrompt?: string },
): string {
  return joinPromptBlocks([
    opts?.hostPrompt ?? "",
    assembleTurnPrompt(messages, ctx, {
      withMemory: opts?.withMemory,
      taskMessage: opts?.taskMessage,
      historyTurns: opts?.historyTurns,
    }),
  ])
}

/** 项目会话每轮自然语言附带：节点索引 + 发现协议（按钮 [PROJECT_ACTION] 轮跳过，抗长会话遗忘） */
function projectNodeRouting(sessionKey: string | undefined, messages: TurnMessage[]): EnvelopeNodeRouting | undefined {
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
  return { projectId: proj.id, nodes }
}

/** 新账本第一轮带给 AI 的会话记忆；没挂记忆工具的会话（独立任务、访客）不带 */
function memoryForTurn(ctx: PromptAssemblyContext): SessionMemoryEntry[] | undefined {
  const sessionKey = ctx.sessionKey?.trim()
  if (!sessionKey || !ctxIncludeMemory(ctx)) return undefined
  return readSessionMemory(app.getPath("userData"), sessionKey)
}

function toEnvelopeQuote(q: QuotedMessagePayload): EnvelopeQuote {
  return { id: q.message_id, from: q.sender_type, sender: q.sender_open_id, text: q.text }
}

function toEnvelopeHistory(t: HistoryTurn): EnvelopeMessage {
  return { from: t.role, text: t.text.trim(), quote: t.quoted_message ? toEnvelopeQuote(t.quoted_message) : undefined }
}

/** internal_ 开头的是应用内部下发的队列 id，不是真实消息 id，不交给 AI */
function toEnvelopeMessage(m: TurnMessage): EnvelopeMessage {
  return {
    id: m.messageId && !m.messageId.startsWith("internal_") ? m.messageId : undefined,
    at: m.timestamp,
    from: m.meta?.senderType,
    sender: m.meta?.senderOpenId,
    text: m.text.trim(),
    quote: m.meta?.quoted_message ? toEnvelopeQuote(m.meta.quoted_message) : undefined,
  }
}

/** Session Worker 向 Agent 交付一批用户消息：包成 turn 标签，正文原样放入（格式见 turn-envelope） */
export function assembleTurnPrompt(
  messages: TurnMessage[],
  ctx: PromptAssemblyContext,
  opts?: { withMemory?: boolean; taskMessage?: string; historyTurns?: HistoryTurn[] },
): string {
  const channelType = resolvePromptChannel(ctx).channel?.type
  return buildTurnEnvelope({
    chat: ctx.meta?.chatType,
    channel: channelType ? CHANNEL_TYPE_LABELS[channelType] : undefined,
    now: Date.now(),
    memory: opts?.withMemory ? memoryForTurn(ctx) : undefined,
    task: opts?.taskMessage?.trim(),
    history: (opts?.historyTurns ?? []).filter((t) => t.text?.trim()).map(toEnvelopeHistory),
    messages: messages.map(toEnvelopeMessage),
    nodeRouting: projectNodeRouting(ctx.sessionKey, messages),
  })
}
