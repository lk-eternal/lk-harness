import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { createProxyFetch } from "./llm-proxy"
import { getModel, getModels, type Api, type Model } from "@mariozechner/pi-ai/compat"
import type { LlmApiProtocol } from "../src/shared/agent-providers"

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_FILE = "models-dev-catalog.json"
const CACHE_TTL_MS = 24 * 3600 * 1000

interface CatalogEntry {
  api: LlmApiProtocol
  name?: string
}

interface ModelsDevProvider {
  npm?: string
  api?: string
  name?: string
  models?: Record<string, { id?: string; name?: string }>
}

interface CacheFile {
  fetchedAt: number
  index: Record<string, CatalogEntry>
}

let memIndex: Map<string, CatalogEntry> | null = null
let loadPromise: Promise<void> | null = null

const PI_SCAN_PROVIDERS = [
  "opencode-go", "opencode", "openrouter", "deepseek", "groq", "xai", "mistral", "google", "anthropic", "openai",
] as const

function cachePath(): string {
  return path.join(app.getPath("userData"), CACHE_FILE)
}

function npmToApi(npm: string | undefined): LlmApiProtocol {
  const n = (npm ?? "").toLowerCase()
  if (n.includes("anthropic")) return "anthropic-messages"
  if (n.includes("google") || n.includes("gemini")) return "google-generative-ai"
  if (n.includes("responses")) return "openai-responses"
  return "openai-completions"
}

function buildIndex(raw: Record<string, ModelsDevProvider>): Map<string, CatalogEntry> {
  const index = new Map<string, CatalogEntry>()
  for (const prov of Object.values(raw)) {
    const api = npmToApi(prov.npm)
    for (const m of Object.values(prov.models ?? {})) {
      const id = m.id?.trim()
      if (!id) continue
      index.set(id, { api, name: m.name?.trim() || id })
    }
  }
  return index
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

function writeDiskCache(index: Map<string, CatalogEntry>): void {
  const obj: Record<string, CatalogEntry> = {}
  for (const [k, v] of index) obj[k] = v
  const payload: CacheFile = { fetchedAt: Date.now(), index: obj }
  const dir = path.dirname(cachePath())
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = cachePath() + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8")
  fs.renameSync(tmp, cachePath())
}

async function fetchModelsDevIndex(): Promise<Map<string, CatalogEntry>> {
  const proxyFetch = createProxyFetch()
  const res = await (proxyFetch ?? fetch)(MODELS_DEV_URL, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, ModelsDevProvider>
  const index = buildIndex(raw)
  writeDiskCache(index)
  return index
}

export async function ensureModelsDevCatalog(): Promise<void> {
  if (memIndex) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const disk = readDiskCache()
    if (disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS) {
      memIndex = new Map(Object.entries(disk.index))
      return
    }
    try {
      memIndex = await fetchModelsDevIndex()
    } catch {
      if (disk) {
        memIndex = new Map(Object.entries(disk.index))
        return
      }
      memIndex = new Map()
    }
  })()
  return loadPromise
}

/** 后台预热，不阻塞启动 */
export function warmModelsDevCatalog(): void {
  void ensureModelsDevCatalog()
}

function ensureMemFromDisk(): void {
  if (memIndex) return
  const disk = readDiskCache()
  memIndex = disk ? new Map(Object.entries(disk.index)) : new Map()
}

export function lookupCatalogModel(modelId: string): CatalogEntry | undefined {
  ensureMemFromDisk()
  return memIndex?.get(modelId.trim())
}

function lookupPiModelApi(modelId: string): Api | null {
  const id = modelId.trim()
  if (!id) return null
  for (const pid of PI_SCAN_PROVIDERS) {
    try {
      const m = getModel(pid as Parameters<typeof getModel>[0], id as never)
      if (m?.api) return m.api
    } catch { /* not in this provider */ }
  }
  return null
}

export function resolveCustomModelApi(modelId: string, fallback?: LlmApiProtocol): LlmApiProtocol {
  const fromCatalog = lookupCatalogModel(modelId)?.api
  if (fromCatalog) return fromCatalog
  const fromPi = lookupPiModelApi(modelId)
  if (fromPi) return fromPi as LlmApiProtocol
  return fallback ?? "openai-completions"
}

/** 规范化自定义网关 URL（用于 /models 与 completions） */
export function normalizeGatewayRoot(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "")
  url = url.replace(/\/chat\/completions$/i, "")
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
