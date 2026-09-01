import {
  launchAgent as launchCliAgent,
  stopSessionAgent as stopCliSession,
  stopAllSessionAgents as stopAllCliSessions,
  isSessionAgentRunning as isCliSessionRunning,
} from "../agent-launcher"
import { execAgentSync } from "../agent-cli"
import { applyProxyEnv } from "../agent-cli"
import { getConfig, primaryWorkspaceForCli } from "../config-store"
import { injectCliMcpToProjectDir } from "../workspace-injector"
import type { AgentEngine, AgentLaunchParams, ListedModel } from "./types"

function parseListModelsStdout(stdout: string): ListedModel[] {
  const models: ListedModel[] = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || /^available models/i.test(trimmed)) continue
    const match = trimmed.match(/^(\S+)\s+[??]\s+(.+?)(\s+\((?:default|current)\))?\s*$/)
    if (match) models.push({ id: match[1], label: match[2].trim(), current: !!match[3] })
  }
  return models
}

export const cursorCliEngine: AgentEngine = {
  kind: "cursor-cli",

  async launch(p: AgentLaunchParams) {
    if (p.cliMcpAdmin !== undefined) {
      injectCliMcpToProjectDir(p.workspaceDir, p.cliMcpAdmin)
    }
    return launchCliAgent({
      sessionKey: p.sessionKey,
      chatType: p.chatType,
      meta: p.meta,
      useMainWorkspace: p.useMainWorkspace,
      digitalIdentityOverride: p.digitalIdentityOverride,
      senderOpenId: p.senderOpenId,
      chatName: p.chatName,
      taskMessage: p.taskMessage,
      notifySessionKey: p.notifySessionKey,
      workspaceDir: p.workspaceDir,
      model: p.model,
      resumeScope: p.resumeScope,
      persistentPoll: p.persistentPoll,
    })
  },

  isRunning: isCliSessionRunning,
  stop: async (key) => { stopCliSession(key) },
  stopAll: async () => { stopAllCliSessions() },

  async listModels() {
    const config = getConfig()
    const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
    applyProxyEnv(env, config)
    const ws = primaryWorkspaceForCli()
    const run = execAgentSync(["--list-models"], env, { timeoutMs: 30_000, logLabel: "list-models", cwd: ws })
    if (!run.ok) return { ok: false, error: run.error || run.stderr.trim() || "获取模型列表失败" }
    const models = parseListModelsStdout(run.stdout)
    if (models.length === 0) return { ok: false, error: "未解析到任何模型" }
    return { ok: true, models }
  },
}
