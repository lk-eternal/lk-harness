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
    // 协议不读配置：pi 内置表 > models.dev（provider.npm 推断）> completions
    const api = resolveCustomModelApi(id) as Api
    const pi = lookupPiModel(id)
    const meta = lookupCatalogModel(id)
    // 自定义网关只换端点与凭据；推理/输入模态/窗口这些能力描述沿用 pi 目录。
    // 之前硬编码 reasoning:false + input:["text"]，推理模型走 responses 网关会被上游直接拒（500）
    return {
      id,
      name: pi?.name ?? meta?.name ?? id,
      api,
      provider: resource.id,
      baseUrl: normalizeGatewayRoot(resource.baseUrl),
      reasoning: pi?.reasoning ?? false,
      input: pi?.input ?? ["text"],
      cost: pi?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: pi?.contextWindow ?? 128000,
      maxTokens: pi?.maxTokens ?? 8192,
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
