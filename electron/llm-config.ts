import type { AgentResource } from "../src/shared/channel-types"
import type { LlmApiProtocol } from "../src/shared/agent-providers"
import { getModel, getModels, type Model, type Api } from "@mariozechner/pi-ai/compat"
import {
  resolveCustomModelApi,
  normalizeGatewayRoot,
  fetchGatewayModels,
  listBuiltinModels,
  lookupCatalogModel,
  lookupPiModel,
} from "./llm-model-catalog.js"

export function llmProviderId(resource: AgentResource): string {
  if (resource.type === "llm-builtin") return resource.providerId ?? "openai"
  if (resource.type === "llm-custom") return resource.id
  return ""
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
    // 自定义网关以 models.dev 为准（按 baseUrl 找对应提供商）；pi 表只作断网/缺失兜底
    const api = resolveCustomModelApi(id, resource.baseUrl) as Api
    const meta = lookupCatalogModel(id, resource.baseUrl) ?? lookupCatalogModel(id)
    const pi = lookupPiModel(id)
    return {
      id,
      name: pi?.name ?? meta?.name ?? id,
      api,
      provider: resource.id,
      baseUrl: normalizeGatewayRoot(resource.baseUrl),
      reasoning: meta?.reasoning ?? pi?.reasoning ?? false,
      input: meta?.input ?? pi?.input ?? ["text"],
      cost: pi?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: meta?.contextWindow ?? pi?.contextWindow ?? 128000,
      maxTokens: meta?.maxTokens ?? pi?.maxTokens ?? 8192,
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

/** 自定义网关：GET /models 需带 API Key */
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
