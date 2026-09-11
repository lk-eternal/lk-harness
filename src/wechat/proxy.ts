import { ProxyAgent, fetch as undiciFetch } from "undici"

/**
 * 微信/飞书域名默认直连（与设置页 NO_PROXY 同策略）。
 * 背景：本地代理（127.0.0.1:1080 类）回源 ilinkai.weixin.qq.com 常失败，
 * 而直连可用；飞书同理，早年已进直连名单。
 */
export const DIRECT_SUFFIX_DEFAULTS = ["feishu.cn", "weixin.qq.com"]
const LOCAL_BYPASS = ["localhost", "127.0.0.1", "::1"]

export function parseNoProxyEntries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
}

/** 精确或后缀命中（weixin.qq.com 覆盖 ilinkai.weixin.qq.com 与 CDN 子域） */
export function hostnameBypassed(hostname: string, entries: string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "")
  if (!host) return false
  return entries.some((e) => {
    const entry = e.trim().toLowerCase().replace(/^\./, "")
    if (!entry) return false
    return host === entry || host.endsWith(`.${entry}`)
  })
}

export function proxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy || ""
  ).trim()
}

function noProxyRaw(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.NO_PROXY ?? env.no_proxy
  return v === undefined ? undefined : v
}

/**
 * 该 URL 是否应直连：
 * - 显式配了 NO_PROXY → 严格按名单；
 * - 没配 → 内建默认（本地 + 飞书 + 微信）直连，其余走代理。
 */
export function shouldBypassProxy(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  const raw = noProxyRaw(env)
  if (raw !== undefined) return hostnameBypassed(host, parseNoProxyEntries(raw))
  return hostnameBypassed(host, [...LOCAL_BYPASS, ...DIRECT_SUFFIX_DEFAULTS])
}

/** 默认家族名单（注意事项：含 feishu.cn 但缺 weixin.qq.com）补上微信后缀；完全自定义的不碰 */
export function ensureWechatBypass(noProxy: string | undefined): string {
  const entries = parseNoProxyEntries(noProxy)
  if (!entries.includes("feishu.cn") || hostnameBypassed("ilinkai.weixin.qq.com", entries)) {
    return (noProxy ?? "").trim()
  }
  return [...entries, "weixin.qq.com"].join(",")
}

let cachedAgent: { proxyUrl: string; agent: ProxyAgent } | null = null

function dispatcherFor(proxyUrl: string): ProxyAgent {
  if (!cachedAgent || cachedAgent.proxyUrl !== proxyUrl) {
    cachedAgent = { proxyUrl, agent: new ProxyAgent(proxyUrl) }
  }
  return cachedAgent.agent
}

/** 代理感知 fetch：命中代理且未直连时走 ProxyAgent，否则全局 fetch（行为不变） */
export async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const url = String(input)
  const proxyUrl = proxyUrlFromEnv(env)
  if (!proxyUrl || shouldBypassProxy(url, env)) {
    return fetch(input, init)
  }
  return (await undiciFetch(url, {
    ...(init as object),
    dispatcher: dispatcherFor(proxyUrl),
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response
}
