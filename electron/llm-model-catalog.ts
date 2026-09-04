import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { createProxyFetch } from "./llm-proxy"
import { catalogDir } from "../src/shared/data-paths.js"
import { getModel, getModels, type Api, type Model } from "@mariozechner/pi-ai/compat"
import type { LlmApiProtocol } from "../src/shared/agent-providers"

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_FILE = "models-dev-catalog-v2.json"
const CACHE_TTL_MS = 6 * 3600 * 1000

interface CatalogEntry {
  api: LlmApiProtocol
  name?: string
  reasoning?: boolean
  input?: ("text" | "image")[]
  contextWindow?: number
  maxTokens?: number
}

interface ModelsDevModel {
  id?: string
  name?: string
  reasoning?: boolean
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  provider?: { npm?: string }
}

interface ModelsDevProvider {
  npm?: string
  api?: string
  name?: string
  models?: Record<string, ModelsDevModel>
}

interface CacheFile {
  fetchedAt: number
  index: Record<string, CatalogEntry>
  byProvider?: Record<string, Record<string, CatalogEntry>>
}

let memIndex: Map<string, CatalogEntry> | null = null
let memByProvider: Map<string, Map<string, CatalogEntry>> | null = null
let loadPromise: Promise<void> | null = null

const PI_SCAN_PROVIDERS = [
  "opencode-go", "opencode", "openrouter", "deepseek", "groq", "xai", "mistral", "google", "anthropic", "openai",
] as const

function cachePath(): string {
  return path.join(catalogDir(app.getPath("userData")), CACHE_FILE)
}

function npmToApi(npm: string | undefined): LlmApiProtocol {
  const n = (npm ?? "").toLowerCase()
  if (n.includes("anthropic")) return "anthropic-messages"
  if (n.includes("google") || n.includes("gemini")) return "google-generative-ai"
  if (n === "@ai-sdk/openai") return "openai-responses"
  if (n.includes("responses")) return "openai-responses"
  return "openai-completions"
}

function buildIndex(raw: Record<string, ModelsDevProvider>): {
  index: Map<string, CatalogEntry>
  byProvider: Map<string, Map<string, CatalogEntry>>
} {
  const index = new Map<string, CatalogEntry>()
  const byProvider = new Map<string, Map<string, CatalogEntry>>()
  for (const [provId, prov] of Object.entries(raw)) {
    const provKey = prov.api ? normalizeGatewayRoot(prov.api) : provId
    for (const m of Object.values(prov.models ?? {})) {
      const id = m.id?.trim()
      if (!id) continue
      const api = npmToApi(m.provider?.npm ?? prov.npm)
      const inputs = (m.modalities?.input ?? []).map((s) => s.toLowerCase())
      const entry: CatalogEntry = {
        api,
        name: m.name?.trim() || id,
        ...(m.reasoning !== undefined ? { reasoning: !!m.reasoning } : {}),
        ...(inputs.length ? { input: inputs.includes("image") ? ["text", "image"] : ["text"] } : {}),
        ...(m.limit?.context ? { contextWindow: m.limit.context } : {}),
        ...(m.limit?.output ? { maxTokens: m.limit.output } : {}),
      }
      index.set(id, entry)
      if (!byProvider.has(provKey)) byProvider.set(provKey, new Map())
      byProvider.get(provKey)!.set(id, entry)
      if (provId && provId !== provKey) {
        if (!byProvider.has(provId)) byProvider.set(provId, new Map())
        byProvider.get(provId)!.set(id, entry)
      }
    }
  }
  return { index, byProvider }
}

function readDiskCache(): CacheFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CacheFile
    if (!raw.fetchedAt || !raw.index) return null
    return raw
  } catch {
    return null
  }
}

function writeDiskCache(
  index: Map<string, CatalogEntry>,
  byProvider: Map<string, Map<string, CatalogEntry>>,
): void {
  const obj: Record<string, CatalogEntry> = {}
  for (const [k, v] of index) obj[k] = v
  const byProvObj: Record<string, Record<string, CatalogEntry>> = {}
  for (const [p, m] of byProvider) {
    byProvObj[p] = {}
    for (const [id, entry] of m) byProvObj[p][id] = entry
  }
  const payload: CacheFile = { fetchedAt: Date.now(), index: obj, byProvider: byProvObj }
  const dir = path.dirname(cachePath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = cachePath() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
  fs.renameSync(tmp, cachePath())
}

async function fetchModelsDevIndex(): Promise<{
  index: Map<string, CatalogEntry>
  byProvider: Map<string, Map<string, CatalogEntry>>
}> {
  const proxyFetch = createProxyFetch()
  const res = await (proxyFetch ?? fetch)(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, ModelsDevProvider>
  const built = buildIndex(raw)
  writeDiskCache(built.index, built.byProvider)
  return built
}

export async function ensureModelsDevCatalog(force = false): Promise<void> {
  if (memIndex && memByProvider && !force) {
    const disk = readDiskCache()
    if (disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS) return
    void refreshCatalogInBackground()
    return
  }
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const disk = readDiskCache()
    if (!force && disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS) {
      memIndex = new Map(Object.entries(disk.index))
      memByProvider = disk.byProvider
        ? new Map(Object.entries(disk.byProvider).map(([k, v]) => [k, new Map(Object.entries(v))]))
        : new Map()
      return
    }
    try {
      const built = await fetchModelsDevIndex()
      memIndex = built.index
      memByProvider = built.byProvider
    } catch {
      if (disk) {
        memIndex = new Map(Object.entries(disk.index))
        memByProvider = disk.byProvider
          ? new Map(Object.entries(disk.byProvider).map(([k, v]) => [k, new Map(Object.entries(v))]))
          : new Map()
        return
      }
      memIndex = new Map()
      memByProvider = new Map()
    }
  })()
  const p = loadPromise
  loadPromise = null
  return p
}

async function refreshCatalogInBackground(): Promise<void> {
  if (loadPromise) return
  try {
    const built = await fetchModelsDevIndex()
    memIndex = built.index
    memByProvider = built.byProvider
  } catch { /* 保留旧缓存 */ }
}

/** 后台预热，不阻塞启动 */
export function warmModelsDevCatalog(): void {
  void ensureModelsDevCatalog()
}

function ensureMemFromDisk(): void {
  if (memIndex && memByProvider) return
  const disk = readDiskCache()
  memIndex = disk ? new Map(Object.entries(disk.index)) : new Map()
  memByProvider = disk?.byProvider
    ? new Map(Object.entries(disk.byProvider).map(([k, v]) => [k, new Map(Object.entries(v))]))
    : new Map()
}

export function lookupCatalogModel(modelId: string, baseUrl?: string): CatalogEntry | undefined {
  ensureMemFromDisk()
  const id = modelId.trim()
  if (baseUrl) {
    const key = normalizeGatewayRoot(baseUrl)
    const hit = memByProvider?.get(key)?.get(id) ?? memByProvider?.get(baseUrl.trim())?.get(id)
    if (hit) return hit
  }
  const hit = memIndex?.get(id)
  if (!hit) {
    const disk = readDiskCache()
    const stale = !disk || Date.now() - disk.fetchedAt > CACHE_TTL_MS
    if (stale) void refreshCatalogInBackground()
  }
  return hit
}

/** 模型 id 在 pi 内置哪个供应商目录里（含能力字段）——实际发包用的就是这张表 */
export function lookupPiModel(modelId: string): Model<Api> | null {
  const id = modelId.trim()
  if (!id) return null
  for (const pid of PI_SCAN_PROVIDERS) {
    try {
      const m = getModel(pid as Parameters<typeof getModel>[0], id as never)
      if (m?.api) return m
    } catch { /* not in this provider */ }
  }
  return null
}

function lookupPiModelApi(modelId: string): Api | null {
  return lookupPiModel(modelId)?.api ?? null
}

/**
 * 自定义网关协议判定：models.dev 为准（按网关 baseUrl 找对应提供商，per-model npm 已细分）
 * pi 内置表只作断网/缓存缺失时的兜底，最后退回 completions
 */
export function resolveCustomModelApi(modelId: string, baseUrl?: string): LlmApiProtocol {
  const fromCatalog = lookupCatalogModel(modelId, baseUrl)?.api
  if (fromCatalog) return fromCatalog
  const fromPi = lookupPiModelApi(modelId)
  if (fromPi) return fromPi as LlmApiProtocol
  return "openai-completions"
}

/** 规范化自定义网关根 URL：pi 按 api 自己拼 /chat/completions、/responses 或 /messages，尾缀必须剥掉 */
export function normalizeGatewayRoot(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "")
  url = url.replace(/\/(chat\/completions|responses|messages)$/i, "")
  return url
}

export async function fetchGatewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; label: string }[]> {
  await ensureModelsDevCatalog()
  const root = normalizeGatewayRoot(baseUrl)
  const url = `${root}/models`

  const parse = (json: { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] }) => {
    const rows = json.data ?? json.models ?? []
    return rows
      .map((m) => {
        const id = m.id?.trim()
        if (!id) return null
        const meta = lookupCatalogModel(id)
        return { id, label: meta?.name ?? ("name" in m && m.name ? String(m.name) : id) }
      })
      .filter((m): m is { id: string; label: string } => !!m)
  }

  const fetchOnce = async (useKey: boolean): Promise<{ id: string; label: string }[]> => {
    const headers: Record<string, string> = {}
    if (useKey && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    const proxyFetch = createProxyFetch()
    const res = await (proxyFetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(body.trim() || `HTTP ${res.status}`)
    }
    return parse((await res.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] })
  }

  // 无 Key 时先尝试公开列表
  let models: { id: string; label: string }[] = []
  try {
    models = await fetchOnce(true)
  } catch {
    models = []
  }
  if (models.length <= 1) {
    try {
      const pub = await fetchOnce(false)
      if (pub.length > models.length) models = pub
    } catch { /* 保持 Key 结果 */ }
  }
  if (models.length === 0 && apiKey.trim()) {
    models = await fetchOnce(true)
  }
  return models
}

/** builtin 供应商：pi-ai 模型表 */
export function listBuiltinModels(providerId: string): { id: string; label: string }[] {
  try {
    return getModels(providerId as Parameters<typeof getModels>[0]).map((m: Model<Api>) => ({
      id: m.id,
      label: m.name || m.id,
    }))
  } catch {
    return []
  }
}
