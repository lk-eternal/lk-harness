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
import type { LlmLaunchOptions } from "./agent-llm"
import { llmProviderId } from "./llm-config"
import { assembleLlmHostProtocolBlocks, resolveDaemonPortForPrompt } from "./prompt-assembler"
import { piAdditionalSkillPaths } from "./skill-paths"
import { turnsFromPiMessages } from "./carryover"
import type { TranscriptTurn } from "./agent-engine/types"
import { buildPiHostMcpConfig } from "./pi-mcp-config"

function harnessAgentDir(): string {
  return getAgentDir()
}

function sessionDirForKey(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 32)
  return path.join(app.getPath("userData"), "pi-sessions", hash)
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

function buildAppendSystemPrompt(opts: LlmLaunchOptions): string[] {
  const blocks = assembleLlmHostProtocolBlocks({
    meta: opts.meta,
    sessionKey: opts.sessionKey,
    useMainWorkspace: opts.useMainWorkspace,
    includeAdmin: opts.includeAdmin,
    digitalIdentityOverride: opts.digitalIdentityOverride,
    notifySessionKey: opts.notifySessionKey,
    taskMessage: opts.taskMessage,
  })
  return [blocks.join("\n")]
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
  const mcpConfig = buildPiHostMcpConfig(daemonPort, includeAdmin)
  const mcpAdapter = await (await import("./pi-mcp-loader.js")).loadMcpExtension(mcpConfig)

  // Always inject Harness protocol into appendSystemPrompt so resumed sessions
  // rebuild the same system-prompt prefix as cold start (KV cache prefix match).
  // Wake/resume instructions stay in the user bootstrap turn (agent-llm.ts).
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: buildAppendSystemPrompt(opts),
    additionalSkillPaths: piAdditionalSkillPaths(),
    ...(mcpAdapter ? { extensionFactories: [mcpAdapter] } : {}),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    model,
    thinkingLevel: model.reasoning ? "medium" : "off",
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
