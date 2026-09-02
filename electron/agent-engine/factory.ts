import type { AgentResource } from "../../src/shared/channel-types"
import type { AgentEngine, AgentEngineKind } from "./types"
import { cursorSdkEngine } from "./cursor-sdk"
import { llmEngine } from "./llm"

const ENGINES: AgentEngine[] = [cursorSdkEngine, llmEngine]

export function agentEngineKind(resource: AgentResource): AgentEngineKind | null {
  switch (resource.type) {
    case "sdk": return "cursor-sdk"
    case "llm-builtin":
    case "llm-custom": return "llm"
    default: return null
  }
}

export function getAgentEngine(resource: AgentResource): AgentEngine {
  const kind = agentEngineKind(resource)
  if (kind === "cursor-sdk") return cursorSdkEngine
  if (kind === "llm") return llmEngine
  throw new Error(`不支持的 Agent 资源类型「${resource.type}」`)
}

export function getAllAgentEngines(): AgentEngine[] {
  return ENGINES
}

export function isSupportedAgentResource(resource: AgentResource): boolean {
  return agentEngineKind(resource) !== null
}
