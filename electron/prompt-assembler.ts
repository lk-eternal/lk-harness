import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { getConfig } from "./config-store"
import { listEnabledHarnessRules } from "./harness-rule-store"
import { shouldIncludeAdminMcp } from "../src/shared/harness-mcp-store.js"
import { readLockFile } from "./daemon-client"
import { getRuleTemplatePath, getLlmHostRuleTemplatePath, getDaemonPort, ADMIN_SKILL_CONTENT } from "./workspace-injector"
import { scheduledTaskNotifyPromptLines } from "../src/shared/scheduled-task"
import type { LaunchMeta } from "./agent-launcher"

export interface PromptAssemblyContext {
  meta?: LaunchMeta
  sessionKey?: string
  useMainWorkspace?: boolean
  notifySessionKey?: string
  taskMessage?: string
  digitalIdentityOverride?: string
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim()
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return raw.trim()
  return raw.slice(end + 4).trim()
}

let cachedBuiltin: { port: string; body: string } | null = null
let cachedLlmHost: { port: string; body: string } | null = null

export interface TurnMessage {
  text: string
  messageId?: string
  meta?: {
    chatType?: string
    senderOpenId?: string
    senderType?: string
    quotedContent?: string
  }
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

export function loadBuiltinProtocol(daemonPort?: number | null): string {
  const port = String(portForAssembly(daemonPort) ?? "")
  if (cachedBuiltin && cachedBuiltin.port === port) return cachedBuiltin.body
  const tplPath = getRuleTemplatePath()
  let raw = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, "utf-8") : ""
  raw = substituteDaemonPort(raw, port)
  const body = stripFrontmatter(raw)
  cachedBuiltin = { port, body }
  return body
}

/** LLM 宿主模式协议（无 poll，由 harness Session Worker 代管） */
export function loadLlmHostProtocol(daemonPort?: number | null): string {
  const port = String(portForAssembly(daemonPort) ?? "")
  if (cachedLlmHost && cachedLlmHost.port === port) return cachedLlmHost.body
  const tplPath = getLlmHostRuleTemplatePath()
  let raw = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, "utf-8") : loadBuiltinProtocol(daemonPort)
  raw = substituteDaemonPort(raw, port)
  const body = stripFrontmatter(raw)
  cachedLlmHost = { port, body }
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

function appendUserHarnessRules(parts: string[]): void {
  const rules = listEnabledHarnessRules()
  if (!rules.length) return
  parts.push("---")
  parts.push("## 用户 Harness 规则")
  for (const r of rules) {
    parts.push(`### ${r.name}`)
    parts.push(stripFrontmatter(r.content))
  }
}

function appendAdminSkill(parts: string[], ctx: PromptAssemblyContext): void {
  if (!shouldIncludeAdminMcp(ctx.meta, ctx.sessionKey)) return
  parts.push("---")
  parts.push("## LK Harness 自管理 Skill")
  parts.push(ADMIN_SKILL_CONTENT.trim())
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
  if (ctx.sessionKey) parts.push(`[session_key=${ctx.sessionKey}]`)
  if (ctx.notifySessionKey?.trim()) {
    parts.push(...scheduledTaskNotifyPromptLines(ctx.notifySessionKey.trim()))
  }
  if (ctx.meta?.chatType) parts.push(`[chat_type=${ctx.meta.chatType}]`)
}

export function computePromptHash(ctx: Pick<PromptAssemblyContext, "meta" | "sessionKey" | "useMainWorkspace" | "digitalIdentityOverride">, daemonPort?: number | null): string {
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const h = createHash("md5")
  h.update(loadLlmHostProtocol(portForAssembly(daemonPort)))
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) h.update(identity)
  for (const r of listEnabledHarnessRules()) {
    h.update(r.id)
    h.update(r.content)
  }
  if (shouldIncludeAdminMcp(ctx.meta, ctx.sessionKey)) h.update(ADMIN_SKILL_CONTENT)
  return h.digest("hex").slice(0, 16)
}

export function assembleLlmHostProtocolBlocks(ctx: PromptAssemblyContext, daemonPort?: number | null): string[] {
  const parts: string[] = []
  parts.push("---")
  parts.push("## LK Harness LLM 宿主协议（必须严格遵守）")
  parts.push(loadLlmHostProtocol(portForAssembly(daemonPort)))
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) {
    parts.push("---")
    parts.push("## 数字身份")
    parts.push(identity)
  }
  appendUserHarnessRules(parts)
  appendAdminSkill(parts, ctx)
  return parts
}

export function assembleProtocolBlocks(ctx: PromptAssemblyContext, daemonPort?: number | null): string[] {
  const parts: string[] = []
  parts.push("---")
  parts.push("## LK Harness 协议（必须严格遵守）")
  parts.push(loadBuiltinProtocol(portForAssembly(daemonPort)))
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) {
    parts.push("---")
    parts.push("## 数字身份")
    parts.push(identity)
  }
  appendUserHarnessRules(parts)
  appendAdminSkill(parts, ctx)
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

export function assembleColdStartPrompt(ctx: PromptAssemblyContext, daemonPort?: number | null): string {
  const parts = assembleProtocolBlocks(ctx, daemonPort)
  appendTaskAndMeta(parts, ctx)
  return parts.join("\n")
}

export function assembleWakePrompt(
  ctx: PromptAssemblyContext & { rulesUpdated?: boolean; portChanged?: boolean; taskMessage?: string },
  daemonPort?: number | null,
): string {
  const resolvedPort = portForAssembly(daemonPort)
  const lines = ctx.taskMessage?.trim()
    ? [
      "[SESSION_RESUME / 系统指令] 会话已由后台唤醒（历史上下文完整保留），有新任务待执行。",
      "---",
      "任务内容:",
      ctx.taskMessage.trim(),
      "---",
      "直接开始执行上述任务；执行中按 lk-harness 协议同步进度，完成后挂阻塞 poll 收尾。",
      "禁止向用户发送问候、唤醒说明等任何多余消息。",
    ]
    : [
      "[SESSION_RESUME / 系统指令] 会话已由后台唤醒（历史上下文完整保留），有新消息待处理。",
      "立即执行：非阻塞检查 poll-message（wait=false），按 lk-harness 协议处理所有消息并逐条回复，完成后挂阻塞 poll 收尾。",
      "禁止向用户发送问候、唤醒说明等任何多余消息。",
    ]
  if (ctx.rulesUpdated) {
    lines.push("⚠️ 协议模板或 Harness 规则已更新（上下文中的规则是旧版快照）：以下为最新全文，必须严格按此执行。")
    lines.push(...assembleProtocolBlocks(ctx, daemonPort))
  } else if (ctx.portChanged && resolvedPort) {
    lines.push(`⚠️ Daemon 端口已变更：poll/send 必须使用 [daemon_port=${resolvedPort}]，勿用上下文中的旧端口。`)
  }
  lines.push("---", "会话元数据:", `[session_key=${ctx.sessionKey ?? ""}]`)
  if (resolvedPort) lines.push(`[daemon_port=${resolvedPort}]`)
  if (ctx.notifySessionKey?.trim()) {
    lines.push(...scheduledTaskNotifyPromptLines(ctx.notifySessionKey.trim()))
  }
  if (ctx.meta?.chatType) lines.push(`[chat_type=${ctx.meta.chatType}]`)
  return lines.join("\n")
}

/** Session Worker 向 Pi 交付一批用户消息（无 poll 指令） */
export function assembleTurnPrompt(
  messages: TurnMessage[],
  ctx: PromptAssemblyContext,
  opts?: { firstTurn?: boolean; taskMessage?: string },
): string {
  const lines: string[] = []
  if (opts?.taskMessage?.trim()) {
    lines.push(
      "[宿主交付 / 任务]",
      "以下是待执行的任务内容，完成后用 send_text 汇报结果。",
      "---",
      opts.taskMessage.trim(),
      "---",
    )
  } else if (opts?.firstTurn) {
    lines.push("[宿主交付] 以下是待处理的用户消息，请逐条回复（send_text，带 message_id + session_key）。")
  } else {
    lines.push("[宿主交付] 以下是新到达的用户消息，请处理并回复。")
  }
  lines.push("禁止向用户发送问候、唤醒说明等任何多余消息。")
  lines.push("---")
  for (const m of messages) {
    if (m.messageId) lines.push(`[message_id=${m.messageId}]`)
    if (m.meta?.senderType) lines.push(`[sender_type=${m.meta.senderType}]`)
    if (m.meta?.senderOpenId) lines.push(`[sender_open_id=${m.meta.senderOpenId}]`)
    if (m.meta?.quotedContent?.trim()) {
      lines.push("[quoted]")
      lines.push(m.meta.quotedContent.trim())
    }
    lines.push(m.text.trim())
    lines.push("---")
  }
  lines.push("会话元数据:", `[session_key=${ctx.sessionKey ?? ""}]`)
  if (ctx.meta?.chatType) lines.push(`[chat_type=${ctx.meta.chatType}]`)
  if (ctx.notifySessionKey?.trim()) {
    lines.push(...scheduledTaskNotifyPromptLines(ctx.notifySessionKey.trim()))
  }
  return lines.join("\n")
}
