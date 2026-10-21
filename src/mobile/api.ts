import type { AppChatEvent, AppChatItem } from "../shared/app-chat-types"
import type { AgentResource } from "../shared/channel-types"

const PAIR_STORAGE_KEY = "lk-harness:mobile-pair:v1"
const THEME_STORAGE_KEY = "lk-harness:mobile-theme:v1"

export interface MobilePairConfig {
  /** 云服务器公网穿透地址 */
  pubUrl: string
  /** 公司局域网地址 */
  lanUrl: string
  /** 访问令牌 */
  token: string
  /** 电脑名称 */
  hostName?: string
  /** 线路偏好：auto=局域网优先自动切换；pub=强制云服务器；lan=强制局域网 */
  preferRoute?: "auto" | "pub" | "lan"
}

export interface MobileChatTab {
  sessionKey: string
  label: string
  kind: "dir" | "project" | "temp"
  running: boolean
  current: boolean
  removable?: boolean
  model?: string
  modelParams?: string
  resourceId?: string
  branch?: string
}

export interface MobileChannelView {
  channelId: string
  name: string
  agentResourceId?: string
  tabs: MobileChatTab[]
  activeKey?: string
}

export interface MobileQuickModel {
  model: string
  modelParams?: string
  label?: string
  resourceId?: string
}

export interface MobileBootstrapData {
  ok: boolean
  error?: string
  hostname: string
  theme?: "system" | "light" | "dark"
  channels: MobileChannelView[]
  titles: Record<string, string>
  lastActive: Record<string, number>
  quickModels: MobileQuickModel[]
  resources: AgentResource[]
  usageBytes: number
  runningSessions: string[]
}

export interface RouteStatus {
  connected: boolean
  activeUrl: string
  routeType: "lan" | "pub" | "none"
  latencyMs?: number
  hostname?: string
  error?: string
}

export type MobileStreamMessage =
  | { type: "ready"; ts: number }
  | { type: "chat"; event: AppChatEvent }
  | { type: "titles"; titles: Record<string, string> }
  | { type: "session-status"; status: Record<string, string> }

function trimUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "")
}

function decodeBase64UrlUtf8(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = b64 + "===".slice((b64.length + 3) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * 解析扫码或粘贴的配对内容：
 * 1. 完整 URL（含 ?pair=base64url）
 * 2. 纯 base64url 字符串
 * 3. JSON 字符串 {"pub":"...","lan":"...","token":"..."}
 */
export function parsePairInput(raw: string): MobilePairConfig | null {
  const text = raw.trim()
  if (!text) return null

  // 1. 尝试从 URL 的 ?pair= 参数提取
  try {
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text)
      const pairParam = u.searchParams.get("pair")
      if (pairParam) {
        const decoded = JSON.parse(decodeBase64UrlUtf8(pairParam)) as Record<string, unknown>
        const token = String(decoded.token ?? "").trim()
        if (token) {
          return {
            pubUrl: trimUrl(String(decoded.pub || u.origin)),
            lanUrl: trimUrl(String(decoded.lan ?? "")),
            token,
            hostName: typeof decoded.name === "string" ? decoded.name : undefined,
            preferRoute: "auto",
          }
        }
      }
    }
  } catch {
    // 继续尝试其他格式
  }

  // 2. 尝试直接 JSON 解析
  try {
    if (text.startsWith("{")) {
      const obj = JSON.parse(text) as Record<string, unknown>
      const token = String(obj.token ?? "").trim()
      if (token) {
        return {
          pubUrl: trimUrl(String(obj.pub ?? obj.pubUrl ?? "")),
          lanUrl: trimUrl(String(obj.lan ?? obj.lanUrl ?? "")),
          token,
          hostName: typeof obj.name === "string" ? obj.name : undefined,
          preferRoute: "auto",
        }
      }
    }
  } catch {
    // 继续尝试 base64url
  }

  // 3. 尝试当作 base64url 解码
  try {
    const decoded = JSON.parse(decodeBase64UrlUtf8(text)) as Record<string, unknown>
    const token = String(decoded.token ?? "").trim()
    if (token) {
      return {
        pubUrl: trimUrl(String(decoded.pub ?? "")),
        lanUrl: trimUrl(String(decoded.lan ?? "")),
        token,
        hostName: typeof decoded.name === "string" ? decoded.name : undefined,
        preferRoute: "auto",
      }
    }
  } catch {
    // ignore
  }

  return null
}

export function loadPairConfig(): MobilePairConfig {
  // 检查地址栏是否带有 ?pair=...（手机扫码直接打开时自动完成配对）
  try {
    const u = new URL(window.location.href)
    const pairParam = u.searchParams.get("pair")
    if (pairParam) {
      const parsed = parsePairInput(window.location.href)
      if (parsed && parsed.token) {
        // 如果当前是从某个网关域名打开的，确保该 origin 保存在配置中
        const origin = trimUrl(u.origin)
        if (!parsed.pubUrl && !parsed.lanUrl && /^https?:\/\//i.test(origin)) {
          parsed.pubUrl = origin
        }
        savePairConfig(parsed)
        u.searchParams.delete("pair")
        window.history.replaceState({}, "", u.pathname + (u.search ? u.search : "") + u.hash)
        return parsed
      }
    }
  } catch {
    // ignore
  }

  try {
    const raw = localStorage.getItem(PAIR_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MobilePairConfig>
      return {
        pubUrl: trimUrl(parsed.pubUrl ?? ""),
        lanUrl: trimUrl(parsed.lanUrl ?? ""),
        token: (parsed.token ?? "").trim(),
        hostName: parsed.hostName,
        preferRoute: parsed.preferRoute ?? "auto",
      }
    }
  } catch {
    // ignore
  }

  // 若通过浏览器直接访问网关地址，默认将当前 origin 作为候选地址
  const defaultOrigin = /^https?:\/\/(?!localhost)/i.test(window.location.origin) ? trimUrl(window.location.origin) : ""
  return {
    pubUrl: defaultOrigin,
    lanUrl: "",
    token: "",
    preferRoute: "auto",
  }
}

export function savePairConfig(cfg: MobilePairConfig): void {
  const normalized: MobilePairConfig = {
    pubUrl: trimUrl(cfg.pubUrl),
    lanUrl: trimUrl(cfg.lanUrl),
    token: cfg.token.trim(),
    hostName: cfg.hostName,
    preferRoute: cfg.preferRoute ?? "auto",
  }
  localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(normalized))
}

export type MobileTheme = "system" | "light" | "dark"

export function loadMobileTheme(): MobileTheme {
  const v = localStorage.getItem(THEME_STORAGE_KEY)
  if (v === "light" || v === "dark" || v === "system") return v
  return "system"
}

export function applyMobileTheme(theme: MobileTheme): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme)
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme")
  } else {
    document.documentElement.setAttribute("data-theme", theme)
  }
}

async function pingEndpoint(baseUrl: string, token: string, timeoutMs = 2200): Promise<{ ok: boolean; latencyMs: number; hostname?: string; error?: string }> {
  const url = trimUrl(baseUrl)
  if (!url || !token) return { ok: false, latencyMs: 0, error: "未配置地址或 Token" }
  const t0 = performance.now()
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/api/mobile/ping`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
    window.clearTimeout(timer)
    const latencyMs = Math.max(1, Math.round(performance.now() - t0))
    const data = await res.json().catch(() => ({})) as { ok?: boolean; hostname?: string; error?: string }
    if (!res.ok || !data.ok) {
      return { ok: false, latencyMs, error: data.error ?? `HTTP ${res.status}` }
    }
    return { ok: true, latencyMs, hostname: data.hostname }
  } catch (err) {
    window.clearTimeout(timer)
    return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : "连接超时" }
  }
}

/**
 * 双线路自动择优：
 * - auto：先用 1.6s 探测公司局域网地址（若配置了），通则走局域网；不通则走云服务器公网地址
 * - lan / pub：按指定线路连接，失败时自动回退另一条可用线路
 */
export async function resolveBestRoute(cfg: MobilePairConfig): Promise<RouteStatus> {
  const token = cfg.token.trim()
  if (!token) {
    return { connected: false, activeUrl: "", routeType: "none", error: "请先扫码或填入配对 Token" }
  }
  const lan = trimUrl(cfg.lanUrl)
  const pub = trimUrl(cfg.pubUrl)
  if (!lan && !pub) {
    return { connected: false, activeUrl: "", routeType: "none", error: "请配置云服务器或局域网连接地址" }
  }

  const order: { url: string; type: "lan" | "pub"; timeout: number }[] = []
  if (cfg.preferRoute === "pub") {
    if (pub) order.push({ url: pub, type: "pub", timeout: 4500 })
    if (lan && lan !== pub) order.push({ url: lan, type: "lan", timeout: 1800 })
  } else {
    if (lan) order.push({ url: lan, type: "lan", timeout: 1600 })
    if (pub && pub !== lan) order.push({ url: pub, type: "pub", timeout: 4500 })
  }

  let lastErr = "无法连接到电脑端"
  for (const cand of order) {
    const r = await pingEndpoint(cand.url, token, cand.timeout)
    if (r.ok) {
      return {
        connected: true,
        activeUrl: cand.url,
        routeType: cand.type,
        latencyMs: r.latencyMs,
        hostname: r.hostname,
      }
    }
    lastErr = r.error ?? lastErr
  }

  return {
    connected: false,
    activeUrl: pub || lan,
    routeType: "none",
    error: lastErr,
  }
}

async function callApi<T>(baseUrl: string, token: string, path: string, body?: Record<string, unknown>, method: "GET" | "POST" = "POST"): Promise<T> {
  const res = await fetch(`${trimUrl(baseUrl)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return await res.json() as T
}

export async function fetchBootstrap(baseUrl: string, token: string): Promise<MobileBootstrapData> {
  return await callApi<MobileBootstrapData>(baseUrl, token, "/api/mobile/bootstrap", undefined, "GET")
}

export async function fetchHistory(baseUrl: string, token: string, sessionKey: string): Promise<{ ok: boolean; items?: AppChatItem[]; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/history", { sessionKey })
}

export async function sendMobileMessage(
  baseUrl: string,
  token: string,
  payload: { sessionKey: string; text?: string; images?: string[]; questionId?: string; option?: string },
): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/send", payload)
}

export async function stopMobileSession(baseUrl: string, token: string, sessionKey: string): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/stop", { sessionKey })
}

export async function createMobileTempSession(baseUrl: string, token: string, channelId: string): Promise<{ ok: boolean; sessionKey?: string; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/new-session", { channelId })
}

export async function renameMobileSession(baseUrl: string, token: string, sessionKey: string, name: string): Promise<{ ok: boolean; titles?: Record<string, string>; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/rename-session", { sessionKey, name })
}

export async function clearMobileSession(baseUrl: string, token: string, opts: { sessionKey?: string; channelId?: string }): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/clear-session", opts)
}

export async function deleteMobileSession(baseUrl: string, token: string, sessionKey: string): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/delete-session", { sessionKey })
}

export async function setMobileSessionModel(
  baseUrl: string,
  token: string,
  payload: { sessionKey: string; model: string; modelParams?: string; resourceId?: string },
): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/set-model", payload)
}

export async function listMobileProviderModels(
  baseUrl: string,
  token: string,
  payload: { resourceId: string; currentModel?: string; currentParams?: string },
): Promise<{ ok: boolean; models: { id: string; label?: string; current?: boolean }[]; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/list-models", payload)
}

export async function uploadMobileImage(
  baseUrl: string,
  token: string,
  base64: string,
  ext: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/upload-image", { base64, ext })
}

const imageDataCache = new Map<string, string>()

export async function fetchMobileImageDataUrl(baseUrl: string, token: string, filePath: string, sessionKey?: string): Promise<string | null> {
  const cacheKey = `${baseUrl}|${filePath}`
  const cached = imageDataCache.get(cacheKey)
  if (cached) return cached
  try {
    const q = new URLSearchParams({ path: filePath, ...(sessionKey ? { sessionKey } : {}) })
    const res = await callApi<{ ok: boolean; dataUrl?: string }>(baseUrl, token, `/api/mobile/image?${q.toString()}`, undefined, "GET")
    if (res.ok && res.dataUrl) {
      if (imageDataCache.size >= 36) {
        const firstKey = imageDataCache.keys().next().value
        if (firstKey) imageDataCache.delete(firstKey)
      }
      imageDataCache.set(cacheKey, res.dataUrl)
      return res.dataUrl
    }
  } catch {
    // ignore
  }
  return null
}

export function buildMobileFileDownloadUrl(baseUrl: string, token: string, filePath: string, sessionKey?: string): string {
  const q = new URLSearchParams({
    path: filePath,
    token,
    ...(sessionKey ? { sessionKey } : {}),
  })
  return `${trimUrl(baseUrl)}/api/mobile/file?${q.toString()}`
}

/**
 * 建立 SSE 实时事件流，断线后自动重连
 */
export function connectMobileEvents(
  baseUrl: string,
  token: string,
  onMessage: (msg: MobileStreamMessage) => void,
  onStateChange?: (connected: boolean) => void,
): () => void {
  if (!baseUrl || !token) return () => {}
  let closed = false
  let es: EventSource | null = null
  let retryTimer = 0

  const connect = () => {
    if (closed) return
    const url = `${trimUrl(baseUrl)}/api/mobile/events?token=${encodeURIComponent(token)}`
    es = new EventSource(url)
    es.onopen = () => {
      onStateChange?.(true)
    }
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as MobileStreamMessage
        onMessage(parsed)
      } catch {
        // ignore malformed event
      }
    }
    es.onerror = () => {
      onStateChange?.(false)
      es?.close()
      es = null
      if (!closed) {
        retryTimer = window.setTimeout(connect, 2500)
      }
    }
  }

  connect()

  return () => {
    closed = true
    if (retryTimer) window.clearTimeout(retryTimer)
    es?.close()
  }
}
