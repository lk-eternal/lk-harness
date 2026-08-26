import type { AgentResource } from "../src/shared/channel-types"
import type { LlmApiProtocol } from "../src/shared/agent-providers"
import { getModel, getModels, type Model, type Api } from "@mariozechner/pi-ai/compat"
import {
  resolveCustomModelApi,
  normalizeGatewayRoot,
  fetchGatewayModels,
  listBuiltinModels,
  lookupCatalogModel,
} from "./llm-model-catalog.js"

export function llmProviderId(resource: AgentResource): string {
  if (resource.type === "llm-builtin") return resource.providerId ?? "openai"
  if (resource.type === "llm-custom") return resource.id
  return ""
}

function normalizeCustomBaseUrl(baseUrl: string, api: Api): string {
  return normalizeGatewayRoot(baseUrl)
}

export function resolveLlmModel(resource: AgentResource, modelId?: string): Model<Api> | null {
  if (resource.type === "llm-builtin") {
    const pid = resource.providerId ?? "openai"
    const id = modelId?.trim() || pickDefaultModelId(pid)
    if (!id) return null
    try {
      return getModel(pid as Parameters<typeof getModel>[0], id as never)
    } catch {
      const models = getModels(pid as Parameters<typeof getModels>[0])
      return models[0] ?? null
    }
  }
  if (resource.type === "llm-custom") {
    const id = modelId?.trim()
    if (!id || !resource.baseUrl?.trim()) return null
    const api = resolveCustomModelApi(id, resource.apiProtocol) as Api
    const meta = lookupCatalogModel(id)
    return {
      id,
      name: meta?.name ?? id,
      api,
      provider: resource.id,
      baseUrl: normalizeCustomBaseUrl(resource.baseUrl, api),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      compat: api === "openai-completions" ? { supportsDeveloperRole: false } : undefined,
    } as Model<Api>
  }
  return null
}

function pickDefaultModelId(providerId: string): string {
  const models = getModels(providerId as Parameters<typeof getModels>[0])
  return models[0]?.id ?? ""
}

export function listLlmModelsForResource(resource: AgentResource): { id: string; label: string }[] {
  if (resource.type === "llm-builtin") {
    return listBuiltinModels(resource.providerId ?? "openai")
  }
  if (resource.type === "llm-custom") {
    return (resource.modelIds ?? []).filter(Boolean).map((id) => ({
      id,
      label: lookupCatalogModel(id)?.name ?? id,
    }))
  }
  return []
}

/** 自定义网关：从远�?/models 拉列表（需 API Key�?*/
export async function listCustomGatewayModels(resource: AgentResource): Promise<{ id: string; label: string }[]> {
  const key = llmApiKey(resource)
  const base = resource.baseUrl?.trim()
  if (!key || !base) return []
  return fetchGatewayModels(base, key)
}

export function llmApiKey(resource: AgentResource): string | undefined {
  return resource.apiKey?.trim() || undefined
}

export function isLlmResource(resource: AgentResource): boolean {
  return resource.type === "llm-builtin" || resource.type === "llm-custom"
}

export function customApiProtocol(resource: AgentResource): LlmApiProtocol | undefined {
  return resource.type === "llm-custom" ? resource.apiProtocol : undefined
}
