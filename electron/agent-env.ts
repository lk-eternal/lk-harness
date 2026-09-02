import { getConfig } from "./config-store"

export function quoteArg(a: string): string {
  if (process.platform !== "win32") return a
  if (/[\s"&|<>^()!%]/.test(a) || /[^\x20-\x7E]/.test(a)) return `"${a.replace(/"/g, '\\"')}"`
  return a
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY", "http_proxy",
  "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
] as const

export function applyProxyEnv(env: Record<string, string>, config: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): void {
  for (const key of PROXY_ENV_KEYS) delete env[key]
  if (config.httpProxy) {
    env.HTTP_PROXY = config.httpProxy
    env.http_proxy = config.httpProxy
  }
  if (config.httpsProxy) {
    env.HTTPS_PROXY = config.httpsProxy
    env.https_proxy = config.httpsProxy
    env.ALL_PROXY = config.httpsProxy
    env.all_proxy = config.httpsProxy
  }
  if (config.noProxy) {
    env.NO_PROXY = config.noProxy
    env.no_proxy = config.noProxy
  }
}

/** 把代理同步到 Electron 主进程 process.env（@cursor/sdk 内联 fetch 依赖） */
export function syncMainProcessProxyEnv(config: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): void {
  const env = process.env as Record<string, string>
  applyProxyEnv(env, config)
  const hasProxy = !!(config.httpProxy?.trim() || config.httpsProxy?.trim())
  if (hasProxy) env.NODE_USE_ENV_PROXY = "1"
  else delete env.NODE_USE_ENV_PROXY
}

/** 进程启动最早期注入代理；读配置失败时静默跳过 */
export function bootstrapProxyEnv(): void {
  try {
    syncMainProcessProxyEnv(getConfig())
  } catch { /* initDaemonManager 会再同步 */ }
}
