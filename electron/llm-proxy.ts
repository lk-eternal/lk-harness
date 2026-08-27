import { ProxyAgent, fetch as undiciFetch } from "undici"
import { applyProxyEnv } from "./agent-cli"
import { getConfig } from "./config-store"

/** Provider-scoped env for pi-ai (HTTP_PROXY / HTTPS_PROXY / NO_PROXY). */
export function buildPiProviderEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  applyProxyEnv(env, getConfig())
  return env
}

function resolveProxyUrl(env: Record<string, string>): string {
  return (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || "").trim()
}

/** Undici fetch that routes HTTPS through the configured HTTP(S) proxy. */
export function createProxyFetch(env?: Record<string, string>): typeof fetch | undefined {
  const providerEnv = env ?? buildPiProviderEnv()
  const proxyUrl = resolveProxyUrl(providerEnv)
  if (!proxyUrl) return undefined
  const agent = new ProxyAgent(proxyUrl)
  const proxyFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as object),
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1])
  return proxyFetch as unknown as typeof fetch
}

export function withLlmProxyOptions<T extends object | undefined>(options?: T): T {
  const base = (options ?? {}) as Record<string, unknown>
  const env = { ...buildPiProviderEnv(), ...(base.env as Record<string, string> | undefined) }
  const fetchImpl = (base.fetch as typeof fetch | undefined) ?? createProxyFetch(env)
  return { ...base, env, ...(fetchImpl ? { fetch: fetchImpl } : {}) } as T
}

export function llmProxyConfigured(): boolean {
  return !!resolveProxyUrl(buildPiProviderEnv())
}
