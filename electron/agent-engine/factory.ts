import type { AgentResource } from "../../src/shared/channel-types"
import type { AgentEngine, AgentEngineKind } from "./types"
import { cursorCliEngine } from "./cursor-cli"
import { cursorSdkEngine } from "./cursor-sdk"
import { llmEngine } from "./llm"

export function agentEngineKind(resource: AgentResource): AgentEngineKind {
  switch (resource.type) {
    case "sdk": return "cursor-sdk"
    case "llm-builtin":
    case "llm-custom": return "llm"
    default: return "cursor-cli"
  }
}

export function getAgentEngine(resource: AgentResource): AgentEngine {
  switch (agentEngineKind(resource)) {
    case "cursor-sdk": return cursorSdkEngine
    case "llm": return llmEngine
    default: return cursorCliEngine
  }
}

export function usesSdkRuntime(resource: AgentResource): boolean {
  return resource.type === "sdk"
}

export function usesLlmRuntime(resource: AgentResource): boolean {
  return resource.type === "llm-builtin" || resource.type === "llm-custom"
}
