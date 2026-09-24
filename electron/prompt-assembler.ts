import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { getConfig, getChannel } from "./config-store"
import { listEnabledHarnessRules, ruleAppliesTo } from "./harness-rule-store"
import { channelIdFromSessionKey, chatIdFromSessionKey, parseChatKey, resolveChannelAudience } from "../src/shared/channel-types.js"
import { projectIdFromSessionKey } from "../src/shared/project-types.js"
import { getProject, getProjectNodes, projectGroupIds } from "../src/shared/project-store.js"
import { readLockFile } from "./daemon-client"
import { getRuleTemplatePath, getDaemonPort, getAdminMcpProtocolSection } from "./workspace-injector"
import type { LaunchMeta } from "./agent-session-types"

export interface PromptAssemblyContext {
  meta?: LaunchMeta
  sessionKey?: string
  useMainWorkspace?: boolean
  /** 主用户私聊：协议内嵌 admin MCP 段并挂载 lk-harness-admin 工具 */
  includeAdmin?: boolean
  notifySessionKey?: string
  taskMessage?: string
  historyTurns?: HistoryTurn[]
  digitalIdentityOverride?: string
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim()
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return raw.trim()
  return raw.slice(end + 4).trim()
}

let cachedProtocol: { port: string; admin: boolean; body: string } | null = null

export function clearProtocolTemplateCache(): void {
  cachedProtocol = null
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

/** Prompt 内嵌协议用的 Daemon 端口：优先 lock 文件（与当前 profile 实例一致） */
export function resolveDaemonPortForPrompt(): number | null {
  const lock = readLockFile()
  if (lock?.port) return lock.port
  const injected = getDaemonPort()
  if (injected) return injected
  const cfg = getConfig().daemonPort
  return cfg > 0 ? cfg : null
}

function portForAssembly(explicit?: number | null): number | null {
  if (explicit != null && explicit > 0) return explicit
  return resolveDaemonPortForPrompt()
}

function substituteDaemonPort(raw: string, port: string): string {
  if (!port) return raw
  return raw
    .replace(/\{\{DAEMON_PORT\}\}/g, port)
    .replace(/127\.0\.0\.1:19528\b/g, `127.0.0.1:${port}`)
    .replace(/Daemon 端口为 [`']19528[`']/g, `Daemon 端口为 \`${port}\``)
}

function substituteAdminSection(raw: string, includeAdmin: boolean): string {
  const section = includeAdmin ? getAdminMcpProtocolSection() : ""
  return raw.replace(/\{\{ADMIN_MCP_SECTION\}\}/g, section)
}

/** 会话协议（无 poll，由 harness Session Worker 代管） */
export function loadProtocol(daemonPort?: number | null, includeAdmin = false): string {
  const port = String(portForAssembly(daemonPort) ?? "")
  if (cachedProtocol && cachedProtocol.port === port && cachedProtocol.admin === includeAdmin) return cachedProtocol.body
  const tplPath = getRuleTemplatePath()
  if (!fs.existsSync(tplPath)) throw new Error(`协议模板缺失: ${tplPath}`)
  let raw = fs.readFileSync(tplPath, "utf-8")
  raw = substituteDaemonPort(raw, port)
  raw = substituteAdminSection(raw, includeAdmin)
  const body = stripFrontmatter(raw)
  cachedProtocol = { port, admin: includeAdmin, body }
  return body
}

export function shouldSkipDigitalIdentity(meta?: LaunchMeta, sessionKey?: string, useMainWorkspace?: boolean): boolean {
  const isProject = meta?.chatType === "project" || !!sessionKey?.includes("::project_")
  return !!useMainWorkspace || isProject || meta?.chatType === "task" || meta?.chatType === "temp"
}

function resolveDigitalIdentity(skipIdentity: boolean, override?: string): string {
  if (skipIdentity) return ""
  return (override ?? getConfig().digitalIdentity ?? "").trim()
}

function resolvePromptRuleScope(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey">): { channelId?: string; audience: "main" | "others" } {
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
  const audience = resolveChannelAudience({
    mainUserEnabled: channel?.mainUserEnabled,
    mainUserChatId: channel?.mainUserChatId,
    chatKey,
    chatType,
    sessionKey,
  })
  return { channelId: channel?.id ?? channelId, audience }
}

function appendUserHarnessRules(parts: string[], ctx?: Pick<PromptAssemblyContext, "meta" | "sessionKey">): void {
  const scope = resolvePromptRuleScope(ctx ?? {})
  const rules = listEnabledHarnessRules().filter((r) => ruleAppliesTo(r, scope.channelId, scope.audience))
  if (!rules.length) return
  parts.push("---")
  parts.push("## 用户 Harness 规则")
  for (const r of rules) {
    parts.push(`### ${r.name}`)
    parts.push(stripFrontmatter(r.content))
  }
}

function appendTaskAndMeta(
  parts: string[],
  ctx: PromptAssemblyContext,
): void {
  if (ctx.taskMessage?.trim()) {
    parts.push("---")
    parts.push("任务内容:")
    parts.push(ctx.taskMessage.trim())
  }
  parts.push("---")
  parts.push("会话元数据:")
  if (ctx.meta?.chatType) parts.push(`[chat_type=${ctx.meta.chatType}]`)
}

function ctxIncludeAdmin(ctx: PromptAssemblyContext): boolean {
  return ctx.includeAdmin === true
}

export function computePromptHash(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey" | "useMainWorkspace" | "digitalIdentityOverride" | "includeAdmin">, daemonPort?: number | null): string {
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const includeAdmin = ctxIncludeAdmin(ctx)
  const h = createHash("md5")
  h.update(loadProtocol(portForAssembly(daemonPort), includeAdmin))
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) h.update(identity)
  const scope = resolvePromptRuleScope(ctx)
  for (const r of listEnabledHarnessRules().filter((x) => ruleAppliesTo(x, scope.channelId, scope.audience))) {
    h.update(r.id)
    h.update(r.content)
    h.update(JSON.stringify(r.scope ?? { mode: "main" }))
  }
  h.update(scope.audience)
  h.update(scope.channelId ?? "")
  return h.digest("hex").slice(0, 16)
}

export function assembleProtocolBlocks(ctx: PromptAssemblyContext, daemonPort?: number | null): string[] {
  const parts: string[] = []
  parts.push("---")
  parts.push(loadProtocol(portForAssembly(daemonPort), ctxIncludeAdmin(ctx)))
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) {
    parts.push("---")
    parts.push("## 数字身份")
    parts.push(identity)
  }
  appendUserHarnessRules(parts, ctx)
  return parts
}

export function hashSystemPrompt(text: string): string {
  return createHash("md5").update(text).digest("hex").slice(0, 16)
}

/** Pi LLM 冷启动：仅用户侧指令 + 任务/元数据（协议在 system prompt） */
export function assembleColdStartBootstrap(ctx: PromptAssemblyContext, daemonPort?: number | null): string {
  const parts: string[] = [
    "[冷启动] 请先非阻塞 poll-message（wait=false）检查待处理消息，按 lk-harness 协议处理；有 messageId 的消息必须逐条回复。",
  ]
  appendTaskAndMeta(parts, ctx)
  const port = portForAssembly(daemonPort)
  if (port) parts.push(`[daemon_port=${port}]`)
  return parts.join("\n")
}

/** SDK Session Worker：每轮全量注入宿主协议块（协议含 admin 段 + 身份 + 用户规则） */
export function assembleSdkWorkerTurnPrompt(
  messages: TurnMessage[],
  ctx: PromptAssemblyContext,
  opts?: { firstTurn?: boolean; taskMessage?: string; historyTurns?: HistoryTurn[] },
): string {
  const chunks: string[] = []
  chunks.push(...assembleProtocolBlocks(ctx))
  chunks.push("---")
  chunks.push(assembleTurnPrompt(messages, ctx, {
    firstTurn: opts?.firstTurn,
    taskMessage: opts?.taskMessage,
    historyTurns: opts?.historyTurns,
  }))
  return chunks.join("\n")
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
  const nodes = projectGroupIds(proj).flatMap((gid) => getProjectNodes(gid).map((n) => ({ id: n.id, label: n.label })))
  if (!nodes.length) return undefined
  return {
    nodes,
    rule: `判断用户消息内容是否对应某节点，如果明确命中→先调 project_get_node(project_id=${proj.id}, node_id=命中id) 获取完整提示词再干；未命中则直接处理用户消息即可`,
  }
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
  const payload: Record<string, unknown> = {
    ...(Object.keys(sessionMeta).length ? { session: sessionMeta } : {}),
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
