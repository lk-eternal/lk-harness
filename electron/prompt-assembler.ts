import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { getConfig } from "./config-store"
import { listEnabledClawRules } from "./claw-rule-store"
import { shouldIncludeAdminMcp } from "../src/shared/claw-mcp-store.js"
import { readLockFile } from "./daemon-client"
import { getRuleTemplatePath, getDaemonPort, ADMIN_SKILL_CONTENT } from "./workspace-injector"
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

export function loadBuiltinProtocol(daemonPort?: number | null): string {
  const port = String(portForAssembly(daemonPort) ?? "")
  if (cachedBuiltin && cachedBuiltin.port === port) return cachedBuiltin.body
  const tplPath = getRuleTemplatePath()
  let raw = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, "utf-8") : ""
  if (port) {
    raw = raw.replace(/\{\{DAEMON_PORT\}\}/g, port)
    raw = raw.replace(/127\.0\.0\.1:19528\b/g, `127.0.0.1:${port}`)
    raw = raw.replace(/Daemon 端口为 [`']19528[`']/g, `Daemon 端口为 \`${port}\``)
  }
  const body = stripFrontmatter(raw)
  cachedBuiltin = { port, body }
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

function appendUserClawRules(parts: string[]): void {
  const rules = listEnabledClawRules()
  if (!rules.length) return
  parts.push("---")
  parts.push("## 用户 Claw 规则")
  for (const r of rules) {
    parts.push(`### ${r.name}`)
    parts.push(stripFrontmatter(r.content))
  }
}

function appendAdminSkill(parts: string[], ctx: PromptAssemblyContext): void {
  if (!shouldIncludeAdminMcp(ctx.meta, ctx.sessionKey)) return
  parts.push("---")
  parts.push("## Cursor Claw 自管理 Skill")
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
  h.update(loadBuiltinProtocol(portForAssembly(daemonPort)))
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) h.update(identity)
  for (const r of listEnabledClawRules()) {
    h.update(r.id)
    h.update(r.content)
  }
  if (shouldIncludeAdminMcp(ctx.meta, ctx.sessionKey)) h.update(ADMIN_SKILL_CONTENT)
  return h.digest("hex").slice(0, 16)
}

export function assembleProtocolBlocks(ctx: PromptAssemblyContext, daemonPort?: number | null): string[] {
  const parts: string[] = []
  parts.push("---")
  parts.push("## Cursor Claw 协议（必须严格遵守）")
  parts.push(loadBuiltinProtocol(portForAssembly(daemonPort)))
  const skipIdentity = shouldSkipDigitalIdentity(ctx.meta, ctx.sessionKey, ctx.useMainWorkspace)
  const identity = resolveDigitalIdentity(skipIdentity, ctx.digitalIdentityOverride)
  if (identity) {
    parts.push("---")
    parts.push("## 数字身份")
    parts.push(identity)
  }
  appendUserClawRules(parts)
  appendAdminSkill(parts, ctx)
  return parts
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
      "直接开始执行上述任务；执行中按 cursor-claw 协议同步进度，完成后挂阻塞 poll 收尾。",
      "禁止向用户发送问候、唤醒说明等任何多余消息。",
    ]
    : [
      "[SESSION_RESUME / 系统指令] 会话已由后台唤醒（历史上下文完整保留），有新消息待处理。",
      "立即执行：非阻塞检查 poll-message（wait=false），按 cursor-claw 协议处理所有消息并逐条回复，完成后挂阻塞 poll 收尾。",
      "禁止向用户发送问候、唤醒说明等任何多余消息。",
    ]
  if (ctx.rulesUpdated) {
    lines.push("⚠️ 协议模板或 Claw 规则已更新（上下文中的规则是旧版快照）：以下为最新全文，必须严格按此执行。")
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
