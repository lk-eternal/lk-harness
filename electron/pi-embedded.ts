import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent"
import { withLlmProxyOptions, llmProxyConfigured } from "./llm-proxy"
import { pushUiLog } from "./ui-logger"
import type { Model, Api } from "@mariozechner/pi-ai/compat"
import { app } from "electron"
import { ensureSessionLayoutMigrated } from "../src/shared/session-layout-migrate.js"
import { sessionPiDir } from "../src/shared/session-entry-paths.js"
import type { LlmLaunchOptions } from "./agent-llm"
import { llmProviderId } from "./llm-config"
import { buildHostPrompt, resolveDaemonPortForPrompt } from "./prompt-assembler"
import { countPiPhysicalTurns, turnsFromPiMessages } from "./carryover"
import type { TranscriptTurn } from "./agent-engine/types"
import { buildPiHostMcpConfig } from "./pi-mcp-config"
import type { HarnessMcpEndpoint } from "../src/shared/harness-mcp-store.js"

function harnessAgentDir(): string {
  return getAgentDir()
}

function userDataRoot(): string {
  return process.env.APP_DATA_DIR?.trim() || app.getPath("userData")
}

function sessionDirForKey(sessionKey: string): string {
  const root = userDataRoot()
  ensureSessionLayoutMigrated(root)
  return sessionPiDir(root, sessionKey)
}

export function piSessionDir(sessionKey: string): string {
  return sessionDirForKey(sessionKey)
}

function findExistingSessionFile(sessionDir: string): string | undefined {
  try {
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))
    if (files.length === 0) return undefined
    files.sort()
    return path.join(sessionDir, files[files.length - 1]!)
  } catch {
    return undefined
  }
}

export function hasPersistedPiSession(sessionKey: string): boolean {
  return !!findExistingSessionFile(sessionDirForKey(sessionKey))
}

export function clearPiSession(sessionKey: string): void {
  const dir = sessionDirForKey(sessionKey)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

/** 账本口径：落盘 jsonl 物理消息数（不展开一条用户消息里的多条正文） */
export function countPiSessionPhysicalTurns(sessionKey: string): number {
  const file = findExistingSessionFile(sessionDirForKey(sessionKey))
  if (!file) return 0
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n")
    const messages: { role?: string; content?: string | { type?: string; text?: string }[] }[] = []
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const row = JSON.parse(t) as { type?: string; message?: { role?: string; content?: unknown } }
        if (row.type !== "message" || !row.message) continue
        messages.push(row.message as { role?: string; content?: string | { type?: string; text?: string }[] })
      } catch { /* 坏行跳过 */ }
    }
    return countPiPhysicalTurns(messages)
  } catch { return 0 }
}

/** 搬运用：读落盘 jsonl 最近正文（跳过工具块与报错空回合） */
export function readPiSessionTurns(sessionKey: string): TranscriptTurn[] {
  const file = findExistingSessionFile(sessionDirForKey(sessionKey))
  if (!file) return []
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n")
    const messages: { role?: string; content?: string | { type?: string; text?: string }[] }[] = []
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const row = JSON.parse(t) as { type?: string; message?: { role?: string; content?: unknown } }
        if (row.type !== "message" || !row.message) continue
        messages.push(row.message as { role?: string; content?: string | { type?: string; text?: string }[] })
      } catch { /* 坏行跳过 */ }
    }
    return turnsFromPiMessages(messages)
  } catch { return [] }
}

/**
 * 不让 Pi 自己扫 Skill 目录并生成清单：名单由 buildAppendSystemPrompt 统一给（和 SDK 引擎一致）。
 * 开着的话 Pi 会再列一份自己扫到的，两份对不上，还多占上下文。
 */
export const PI_SKILL_LOADING = { noSkills: true } as const

/** 协议、规则和 Skill 名单整份放系统提示词（和 SDK 引擎同一个构建函数）；系统提示词每个请求都在，不用判断「给过没有」 */
export function buildAppendSystemPrompt(opts: LlmLaunchOptions): string[] {
  return [buildHostPrompt({
    meta: opts.meta,
    sessionKey: opts.sessionKey,
    useMainWorkspace: opts.useMainWorkspace,
    includeAdmin: opts.includeAdmin,
    visitor: opts.visitor,
    digitalIdentityOverride: opts.digitalIdentityOverride,
    notifySessionKey: opts.notifySessionKey,
    taskMessage: opts.taskMessage,
  }).text]
}

function resolveSessionManager(cwd: string, sessionKey: string): SessionManager {
  const sessionDir = sessionDirForKey(sessionKey)
  fs.mkdirSync(sessionDir, { recursive: true })
  const existing = findExistingSessionFile(sessionDir)
  if (existing) return SessionManager.open(existing, sessionDir, cwd)
  return SessionManager.create(cwd, sessionDir)
}

export interface HarnessPiSession {
  session: AgentSession
  sessionManager: SessionManager
  resumed: boolean
}

export async function createHarnessPiSession(
  opts: LlmLaunchOptions,
  model: Model<Api>,
  apiKey: string,
): Promise<HarnessPiSession> {
  const cwd = opts.workspaceDir?.trim() || process.cwd()
  const agentDir = harnessAgentDir()
  fs.mkdirSync(agentDir, { recursive: true })

  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false })
  const providerId = llmProviderId(opts.resource)
  if (opts.resource.type === "llm-custom") {
    modelRuntime.registerProvider(providerId, {
      name: opts.resource.name,
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey,
      authHeader: true,
      models: [{
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: model.input as ("text" | "image")[],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: model.compat,
      }],
    })
  }
  await modelRuntime.setRuntimeApiKey(providerId, apiKey)
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const sessionManager = resolveSessionManager(cwd, opts.sessionKey)
  const existingCtx = sessionManager.buildSessionContext()
  const resumed = existingCtx.messages.length > 0

  const daemonPort = resolveDaemonPortForPrompt()
  const includeAdmin = opts.includeAdmin === true
  // 项目会话另挂 lk-harness-project（与 agent-sdk 一致；宿主无 chatType，按 sessionKey 启发式，同 shouldIncludeAdminMcp 惯例）
  const includeProject = opts.sessionKey?.includes("::project_") === true
  // 独立定时任务没有流式卡片，结果只能靠 send_result 交付：走 task 端点（与 agent-sdk 一致）
  // 访客（其他人的受限会话）：内置端点只有提问和撤回提问，用户 MCP 只挂点名开放的
  const mcpEndpoint: HarnessMcpEndpoint = opts.chatType === "task" ? "task" : opts.visitor ? "visitor" : "interactive"
  const mcpConfig = buildPiHostMcpConfig(daemonPort, includeAdmin, includeProject, opts.sessionKey, mcpEndpoint, opts.visitor?.mcpAllow)
  const mcpAdapter = await (await import("./pi-mcp-loader.js")).loadMcpExtension(mcpConfig)

  // Always inject Harness protocol into appendSystemPrompt so resumed sessions
  // rebuild the same system-prompt prefix as cold start (KV cache prefix match).
  // Wake/resume instructions stay in the user bootstrap turn (agent-llm.ts).
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: buildAppendSystemPrompt(opts),
    ...PI_SKILL_LOADING,
    ...(mcpAdapter ? { extensionFactories: [mcpAdapter] } : {}),
  })
  await resourceLoader.reload()

  // 会话级推理档覆盖优先，其次模型默认；store 未就绪沿用旧规则
  let thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" =
    model.reasoning ? "medium" : "off"
  try {
    const { initSessionThinkingStore, getSessionThinking } = await import("../src/shared/session-thinking-store.js")
    initSessionThinkingStore(app.getPath("userData"))
    thinkingLevel = getSessionThinking(opts.sessionKey) ?? thinkingLevel
  } catch { /* 沿用模型默认 */ }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    model,
    thinkingLevel,
    // 访客：关掉读写文件 / 执行命令 / 搜索这些本机工具（MCP 工具走扩展，不受影响，挂哪些由上面的 MCP 配置决定）
    ...(opts.visitor ? { excludeTools: opts.visitor.piExcludeTools } : {}),
  })
  wrapAgentStreamWithProxy(session)

  return { session, sessionManager, resumed }
}

function wrapAgentStreamWithProxy(session: AgentSession): void {
  if (!llmProxyConfigured()) return
  const orig = session.agent.streamFunction
  session.agent.streamFunction = (model, context, options) =>
    orig(model, context, withLlmProxyOptions(options))
  pushUiLog("LLM", "INFO", "Pi Agent \u5df2\u542f\u7528 HTTP \u4ee3\u7406")
}
