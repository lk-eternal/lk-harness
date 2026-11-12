import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import type { AppChatEvent, AppChatItem } from "../shared/app-chat-types"
import type { HistoryQuery } from "../shared/app-chat-history-page"
import type { MobileUpdateInfo } from "../shared/app-update"
import type { AgentResource } from "../shared/channel-types"
import { OLD_DESKTOP_BRANCH, type BranchListResult, type BranchSwitchResult, type BranchTarget } from "../shared/git-branch"
import type {
  ProjectActionResult, ProjectCreateInput, ProjectCreateResult, ProjectRepoOption, ProjectTemplateInfo, ProjectView,
} from "../shared/project-app-types"
import { challengeMessage } from "../shared/mobile-challenge"
import { mobilePreviewPath } from "../shared/mobile-preview"
import {
  PREVIEW_MAX_DOCUMENT_BYTES, documentTooLargeMessage,
  type PreviewBytesResult, type PreviewOpenResult, type PreviewTextResult, type PreviewZipResult,
} from "../shared/preview-types"
import type { PreviewHost } from "../renderer/components/preview/preview-host"
import { drainSseFrames } from "./sse-parse"

const PAIR_STORAGE_KEY = "lk-harness:mobile-pair:v1"
const THEME_STORAGE_KEY = "lk-harness:mobile-theme:v1"

export interface MobilePairConfig {
  /** 公网地址 */
  pubUrl: string
  /** 局域网地址 */
  lanUrl: string
  /** 访问令牌 */
  token: string
  /** 电脑名称 */
  hostName?: string
  /** 线路偏好：auto=局域网优先自动切换；pub=强制公网；lan=强制局域网 */
  preferRoute?: "auto" | "pub" | "lan"
}

export interface MobileChatTab {
  sessionKey: string
  label: string
  /** 与桌面端会话树下发的取值一致 */
  kind: "main" | "dir" | "project" | "temp" | "task" | "other"
  running: boolean
  current: boolean
  removable?: boolean
  model?: string
  modelParams?: string
  resourceId?: string
  branch?: string
  /** 用户给这个会话选的工作目录（应用内临时会话）；没选过缺省，此时目录要看会话键 */
  boundDir?: string
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
  /** 置顶的会话（appChatSessionId，先置顶的在前）；旧版电脑端没有这个字段 */
  pins?: string[]
  lastActive: Record<string, number>
  quickModels: MobileQuickModel[]
  resources: AgentResource[]
  usageBytes: number
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
  | { type: "pins"; pins: string[] }
  | { type: "sessions" }

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
 * 1. 完整 URL（#pair=base64url；兼容旧版二维码的 ?pair=base64url）
 * 2. 纯 base64url 字符串
 * 3. JSON 字符串 {"pub":"...","lan":"...","token":"..."}
 */
export function parsePairInput(raw: string): MobilePairConfig | null {
  const text = raw.trim()
  if (!text) return null
  try {
    if (/^https?:\/\//i.test(text)) {
      const u = new URL(text)
      const pairParam = readPairParam(u)
      return pairParam ? toPairConfig(JSON.parse(decodeBase64UrlUtf8(pairParam)), u.origin) : null
    }
    if (text.startsWith("{")) return toPairConfig(JSON.parse(text))
    return toPairConfig(JSON.parse(decodeBase64UrlUtf8(text)))
  } catch {
    return null
  }
}

function readPairParam(u: URL): string | null {
  return new URLSearchParams(u.hash.replace(/^#/, "")).get("pair") ?? u.searchParams.get("pair")
}

/** 载荷字段见 src/shared/mobile-pair.ts；pubUrl/lanUrl 是手填 JSON 的别名。两个地址都缺省时，才用打开页面的 origin 当公网地址 */
function toPairConfig(obj: Record<string, unknown>, originFallback = ""): MobilePairConfig | null {
  const token = String(obj.token ?? "").trim()
  if (!token) return null
  const pub = trimUrl(String(obj.pub ?? obj.pubUrl ?? ""))
  const lan = trimUrl(String(obj.lan ?? obj.lanUrl ?? ""))
  return {
    pubUrl: pub || (lan ? "" : trimUrl(originFallback)),
    lanUrl: lan,
    token,
    hostName: typeof obj.name === "string" ? obj.name : undefined,
    preferRoute: "auto",
  }
}

export function loadPairConfig(): MobilePairConfig {
  // 地址栏带有 #pair=...（手机扫码直接打开）时自动完成配对，并立刻把令牌从地址栏清掉
  try {
    const u = new URL(window.location.href)
    if (readPairParam(u)) {
      const parsed = parsePairInput(window.location.href)
      if (parsed) {
        savePairConfig(parsed)
        const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""))
        hashParams.delete("pair")
        u.hash = hashParams.toString()
        u.searchParams.delete("pair")
        window.history.replaceState({}, "", u.pathname + u.search + u.hash)
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

const OLD_SERVER_HINT = "电脑端版本过旧，缺少地址身份校验，请把电脑端升级到 1.1.1 或更高版本"

/**
 * 明文 http 地址：在把令牌发出去之前，先确认对面真是持有同一令牌的电脑端（挑战应答，见 shared/mobile-challenge.ts）。
 * 换了个 Wi-Fi 后保存的局域网地址可能落在陌生设备上，直接带令牌去探测就等于把令牌送给对方。
 * https 由证书保证，不做。返回 null 表示通过，否则是拒绝原因；网络层错误直接抛出，由调用方按原有方式处理。
 */
async function verifyHost(baseUrl: string, token: string, signal: AbortSignal): Promise<string | null> {
  if (!/^http:/i.test(baseUrl)) return null
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const res = await fetch(`${baseUrl}/api/mobile/challenge?nonce=${nonce}`, { signal, cache: "no-store" })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; proof?: unknown } | null
  if (!data?.ok || typeof data.proof !== "string") {
    // 旧版电脑端没有这个接口，请求会先走令牌校验而返回 401
    return res.status === 401 ? OLD_SERVER_HINT : "对方不是 LK Harness 电脑端"
  }
  const expected = bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(challengeMessage(nonce))))
  return data.proof === expected ? null : "对方没有通过身份校验（地址可能落在了别的设备上），已拒绝发送令牌"
}

async function pingEndpoint(baseUrl: string, token: string, timeoutMs = 2200): Promise<{ ok: boolean; latencyMs: number; hostname?: string; error?: string }> {
  const url = trimUrl(baseUrl)
  if (!url || !token) return { ok: false, latencyMs: 0, error: "未配置地址或 Token" }
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const rejected = await verifyHost(url, token, ctrl.signal)
    if (rejected) {
      window.clearTimeout(timer)
      return { ok: false, latencyMs: 0, error: rejected }
    }
    const t0 = performance.now()
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
 * - auto：先用 1.6s 探测局域网地址（若配置了），通则走局域网；不通则走公网地址
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
    return { connected: false, activeUrl: "", routeType: "none", error: "请配置公网或局域网连接地址" }
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

interface ApiResult { ok: boolean; error?: string }

/** 断网、网关返回非 JSON 等传输层失败也按 `{ ok: false, error }` 返回，调用方只需处理 ok */
/** timeoutMs：给的话，这么久没收完响应就放弃（默认不设限，流式、大响应的接口不能设） */
async function callApi<T extends ApiResult>(baseUrl: string, token: string, path: string, body?: Record<string, unknown>, method: "GET" | "POST" = "POST", timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  let res: Response
  try {
    res = await fetch(`${trimUrl(baseUrl)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch {
    if (timer) clearTimeout(timer)
    return { ok: false, error: controller?.signal.aborted ? "电脑端没有及时响应" : "无法连接到电脑端，请检查网络" } as T
  }
  try {
    return await res.json() as T
  } catch {
    return { ok: false, error: controller?.signal.aborted ? "电脑端没有及时响应" : `电脑端返回异常（HTTP ${res.status}）` } as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function fetchBootstrap(baseUrl: string, token: string): Promise<MobileBootstrapData> {
  return await callApi<MobileBootstrapData>(baseUrl, token, "/api/mobile/bootstrap", undefined, "GET")
}

/** 电脑端回答版本的最长等待时间：内置 APK 时是本地读出来的，没内置时电脑端查 GitHub 可能要几十秒，不能让手机陪着干等 */
export const UPDATE_INFO_TIMEOUT_MS = 8000

/** 向电脑端问手机该更新到哪个版本、从哪下载 */
export async function fetchUpdateInfo(baseUrl: string, token: string): Promise<MobileUpdateInfo> {
  return await callApi<MobileUpdateInfo>(baseUrl, token, "/api/mobile/update-info", undefined, "GET", UPDATE_INFO_TIMEOUT_MS)
}

/** 带 query.limit 只给最近一页（返回 hasMore），query.before* 往前翻页；不带 query 是整段历史（老版本电脑端只认这种） */
export async function fetchHistory(
  baseUrl: string,
  token: string,
  sessionKey: string,
  query?: HistoryQuery,
): Promise<{ ok: boolean; items?: AppChatItem[]; hasMore?: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/history", { sessionKey, ...query })
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

/** 暂存区：改一条还在排队的消息的正文；已被 Agent 领走时 ok=false */
export async function editMobileQueued(baseUrl: string, token: string, sessionKey: string, messageId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/queue-edit", { sessionKey, messageId, text })
}

/** 暂存区：撤回一条还在排队的消息 */
export async function removeMobileQueued(baseUrl: string, token: string, sessionKey: string, messageId: string): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/queue-remove", { sessionKey, messageId })
}

/** 暂存区「立即发送」：打断当前回合，让排队的消息马上交给 Agent。via 说明走的哪条路（见 queued-strip-text.ts） */
export async function sendMobileQueuedNow(baseUrl: string, token: string, sessionKey: string): Promise<{ ok: boolean; error?: string; via?: "soft" | "launching" | "relaunch" | "hard" }> {
  return await callApi(baseUrl, token, "/api/mobile/queue-send-now", { sessionKey })
}

/** 带 dir 时新会话直接选好这个工作目录（目录得是电脑上真实存在的，电脑端会校验） */
export async function createMobileTempSession(baseUrl: string, token: string, channelId: string, dir?: string): Promise<{ ok: boolean; sessionKey?: string; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/new-session", { channelId, ...(dir !== undefined ? { dir } : {}) })
}

/** 给还没开始的临时会话选（或改选）工作目录；会话开始后电脑端会拒绝 */
export async function setMobileSessionDir(baseUrl: string, token: string, sessionKey: string, dir: string): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/set-session-dir", { sessionKey, dir })
}

export async function renameMobileSession(baseUrl: string, token: string, sessionKey: string, name: string): Promise<{ ok: boolean; titles?: Record<string, string>; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/rename-session", { sessionKey, name })
}

/** 置顶 / 取消置顶；成功时带回最新的置顶列表。旧版电脑端没有这个接口，网关回「未知接口」 */
export async function setMobileSessionPinned(baseUrl: string, token: string, sessionKey: string, pinned: boolean): Promise<{ ok: boolean; pins?: string[]; error?: string }> {
  const r = await callApi<{ ok: boolean; pins?: string[]; error?: string }>(baseUrl, token, "/api/mobile/pin-session", { sessionKey, pinned })
  return !r.ok && r.error === "未知接口" ? { ...r, error: "电脑端版本过旧，不支持置顶，请把电脑端升级到最新版本" } : r
}

/** 会话工作目录的分支列表（电脑端现读 git）。旧版电脑端没有这个接口，网关回「未知接口」 */
export async function listMobileBranches(baseUrl: string, token: string, sessionKey: string): Promise<BranchListResult> {
  const r = await callApi<BranchListResult>(baseUrl, token, "/api/mobile/list-branches", { sessionKey })
  return !r.ok && r.error === "未知接口" ? { ok: false, error: OLD_DESKTOP_BRANCH } : r
}

/** 切换会话工作目录的分支：由电脑端执行，有会话在回复、有冲突时会拒绝并说明原因 */
export async function switchMobileBranch(baseUrl: string, token: string, sessionKey: string, target: BranchTarget): Promise<BranchSwitchResult> {
  const r = await callApi<BranchSwitchResult>(baseUrl, token, "/api/mobile/switch-branch", { sessionKey, ...target })
  return !r.ok && r.error === "未知接口" ? { ok: false, error: OLD_DESKTOP_BRANCH } : r
}

export async function clearMobileSession(baseUrl: string, token: string, opts: { sessionKey?: string; channelId?: string }): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/clear-session", opts)
}

export async function deleteMobileSession(baseUrl: string, token: string, sessionKey: string): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/delete-session", { sessionKey })
}

// ── 项目（电脑端同一组函数；旧版电脑端没有这些接口，网关回「未知接口」） ──

const OLD_DESKTOP_PROJECT = "电脑端版本过旧，不支持项目功能，请把电脑端升级到最新版本"

function projectError<T extends ApiResult>(r: T): T {
  return !r.ok && r.error === "未知接口" ? { ...r, error: OLD_DESKTOP_PROJECT } : r
}

export async function fetchMobileProjectTemplates(baseUrl: string, token: string): Promise<{ ok: boolean; templates?: ProjectTemplateInfo[]; error?: string }> {
  return projectError(await callApi(baseUrl, token, "/api/mobile/project-templates", {}))
}

/** 常用代码仓库（建研发类项目时勾选）：手机上选不了电脑里的文件夹，只能从记过的仓库里选或填远程地址 */
export async function fetchMobileProjectRepos(baseUrl: string, token: string): Promise<{ ok: boolean; repos?: ProjectRepoOption[]; error?: string }> {
  return projectError(await callApi(baseUrl, token, "/api/mobile/project-repos", {}))
}

/** 手机端建项目：不带文件夹（手机上选不了电脑里的文件夹），项目目录由电脑端自己管 */
export async function createMobileProject(baseUrl: string, token: string, channelId: string, input: Omit<ProjectCreateInput, "folder">): Promise<ProjectCreateResult> {
  return projectError(await callApi<ProjectCreateResult>(baseUrl, token, "/api/mobile/project-create", { channelId, input }))
}

export async function fetchMobileProjectView(baseUrl: string, token: string, channelId: string, projectId: string): Promise<{ ok: boolean; view?: ProjectView; error?: string }> {
  return projectError(await callApi(baseUrl, token, "/api/mobile/project-view", { channelId, projectId }))
}

export async function runMobileProjectStep(baseUrl: string, token: string, channelId: string, projectId: string, nodeId: string): Promise<ProjectActionResult> {
  return projectError(await callApi<ProjectActionResult>(baseUrl, token, "/api/mobile/project-run-step", { channelId, projectId, nodeId }))
}

export async function syncMobileProjectSteps(baseUrl: string, token: string, projectId: string): Promise<ProjectActionResult> {
  return projectError(await callApi<ProjectActionResult>(baseUrl, token, "/api/mobile/project-sync-steps", { projectId }))
}

export async function deleteMobileProject(baseUrl: string, token: string, channelId: string, projectId: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  return projectError(await callApi(baseUrl, token, "/api/mobile/project-delete", { channelId, projectId }))
}

export async function setMobileSessionModel(
  baseUrl: string,
  token: string,
  payload: { sessionKey: string; model: string; modelParams?: string; resourceId?: string },
): Promise<{ ok: boolean; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/set-model", payload)
}

/** 草稿会话（还没发过消息）不在会话树里，按会话键单独读它的有效模型 */
export async function fetchSessionModels(
  baseUrl: string,
  token: string,
  sessionKeys: string[],
): Promise<{ ok: boolean; models?: Record<string, { model?: string; modelParams?: string; resourceId?: string }>; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/session-models", { sessionKeys })
}

/**
 * 供应商的一行模型。同一个 id 可能有好几行（模型的不同推理档位），靠 params（JSON 字符串）区分；
 * 没有 params 字段的供应商（LLM 类）等同于没有参数。
 */
export interface MobileProviderModel {
  id: string
  label?: string
  params?: string
  current?: boolean
}

export async function listMobileProviderModels(
  baseUrl: string,
  token: string,
  payload: { resourceId: string; currentModel?: string; currentParams?: string },
): Promise<{ ok: boolean; models: MobileProviderModel[]; error?: string }> {
  return await callApi(baseUrl, token, "/api/mobile/list-models", payload)
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
}

/**
 * 上传用的扩展名：安卓相册/相机给的文件名经常没有后缀，或后缀与内容不符，所以以 MIME 类型为准；
 * 没有类型时才看文件名后缀。返回 null 表示电脑端不支持的格式（HEIC、AVIF 等）
 */
export function imageExtOf(file: { type: string; name: string }): string | null {
  const byMime = IMAGE_EXT_BY_MIME[file.type.toLowerCase()]
  if (byMime) return byMime
  if (file.type) return null
  return /\.(png|jpe?g|gif|webp|bmp)$/i.exec(file.name)?.[1].toLowerCase() ?? null
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

async function requestDownloadTicketUrl(baseUrl: string, token: string, body: Record<string, unknown>): Promise<string> {
  const res = await callApi<{ ok: boolean; ticket?: string; error?: string }>(baseUrl, token, "/api/mobile/file-ticket", body)
  if (!res.ok || !res.ticket) throw new Error(res.error ?? "无法获取下载链接")
  return `${trimUrl(baseUrl)}/api/mobile/file?ticket=${encodeURIComponent(res.ticket)}`
}

/** 先带令牌换一张短时下载票据，再返回凭票据下载的链接（令牌不进 URL） */
export async function requestMobileFileDownloadUrl(
  baseUrl: string,
  token: string,
  filePath: string,
  sessionKey?: string,
): Promise<string> {
  return await requestDownloadTicketUrl(baseUrl, token, { path: filePath, ...(sessionKey ? { sessionKey } : {}) })
}

/** 预览页里的下载：凭预览令牌换票据（打开预览时电脑端已校验过这个文件能不能给这个会话看） */
export async function requestMobilePreviewDownloadUrl(baseUrl: string, token: string, previewToken: string): Promise<string> {
  return await requestDownloadTicketUrl(baseUrl, token, { previewToken })
}

// ── 文件预览：接口由电脑端网关提供，查看器和电脑端共用（见 renderer/components/preview）──────────

const OLD_DESKTOP_PREVIEW = "电脑端版本过旧，不支持文件预览，请把电脑端升级到最新版本"

/** 旧版电脑端没有预览接口，网关对没见过的接口回「未知接口」，换成用户看得懂的说法 */
function previewError<T extends ApiResult>(r: T): T {
  return !r.ok && r.error === "未知接口" ? { ...r, error: OLD_DESKTOP_PREVIEW } : r
}

/** 打开一个文件的预览（电脑端校验权限并发令牌）；返回的 url 已补全成可以直接当 src 用的完整地址 */
export async function openMobilePreview(baseUrl: string, token: string, sessionKey: string, filePath: string): Promise<PreviewOpenResult> {
  const r = previewError(await callApi<PreviewOpenResult>(baseUrl, token, "/api/mobile/preview-open", { sessionKey, path: filePath }))
  return r.ok ? { ...r, url: `${trimUrl(baseUrl)}${r.url}` } : r
}

/**
 * 批量确认对话文字里的路径能不能预览：返回和输入一一对应的数组，能预览的是电脑上的绝对路径，不能的是 null。
 * 失败（断网、旧版电脑端）一律当作都不能预览：路径只是显示成普通文字，不打扰对话。
 */
export async function checkMobilePreviewPaths(baseUrl: string, token: string, sessionKey: string, paths: string[]): Promise<(string | null)[]> {
  const r = await callApi<{ ok: boolean; paths?: (string | null)[] }>(baseUrl, token, "/api/mobile/preview-check", { sessionKey, paths })
  return r.ok && Array.isArray(r.paths) ? r.paths : paths.map(() => null)
}

/** 查看器读文件内容的方式（手机端）：文本、压缩包清单走接口；docx / xlsx 要整个文件，直接按预览链接下载 */
export function createMobilePreviewHost(baseUrl: string, token: string): PreviewHost {
  return {
    fileText: async (fileToken) => previewError(await callApi<PreviewTextResult>(baseUrl, token, "/api/mobile/preview-text", { token: fileToken })),
    fileZip: async (fileToken) => previewError(await callApi<PreviewZipResult>(baseUrl, token, "/api/mobile/preview-zip", { token: fileToken })),
    fileBytes: async (fileToken): Promise<PreviewBytesResult> => {
      let res: Response
      try {
        res = await fetch(`${trimUrl(baseUrl)}${mobilePreviewPath(fileToken, "file")}`, { cache: "no-store" })
      } catch {
        return { ok: false, error: "无法连接到电脑端，请检查网络" }
      }
      if (res.status === 403) return { ok: false, error: "预览已失效，请重新打开" }
      if (!res.ok) return { ok: false, error: `读取文件失败（HTTP ${res.status}）` }
      // 超过上限不读：解析在手机上跑，再大会卡死；也省得白白下载
      const size = Number(res.headers.get("content-length"))
      if (size > PREVIEW_MAX_DOCUMENT_BYTES) {
        void res.body?.cancel().catch(() => undefined)
        return { ok: false, error: documentTooLargeMessage(size) }
      }
      try {
        return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) }
      } catch {
        return { ok: false, error: "读取文件失败，连接中断" }
      }
    },
  }
}

/** 服务端每 20s 发一次心跳；超过这个时长没收到任何数据，说明链路已静默断开（切网络、休眠） */
const EVENT_STREAM_STALE_MS = 50_000

/**
 * 建立 SSE 实时事件流，断线后自动重连。
 * 不用 EventSource：它带不了 Authorization 头，只能把令牌放进 URL；这里用 fetch 读流。
 */
export function connectMobileEvents(
  baseUrl: string,
  token: string,
  onMessage: (msg: MobileStreamMessage) => void,
  onStateChange?: (connected: boolean) => void,
): () => void {
  if (!baseUrl || !token) return () => {}
  let closed = false
  let ctrl: AbortController | null = null
  let retryTimer = 0

  const run = async () => {
    if (closed) return
    const abort = new AbortController()
    ctrl = abort
    let watchdog = 0
    const arm = () => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(() => abort.abort(), EVENT_STREAM_STALE_MS)
    }
    try {
      arm()
      // 重连往往发生在网络切换之后，每次连接前都重新确认对面是谁，通不过就不发令牌
      const rejected = await verifyHost(trimUrl(baseUrl), token, abort.signal)
      if (rejected) throw new Error(rejected)
      const res = await fetch(`${trimUrl(baseUrl)}/api/mobile/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        cache: "no-store",
        signal: abort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      onStateChange?.(true)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        buffer += decoder.decode(value, { stream: true })
        const drained = drainSseFrames(buffer)
        buffer = drained.rest
        for (const data of drained.payloads) {
          try {
            onMessage(JSON.parse(data) as MobileStreamMessage)
          } catch {
            // ignore malformed event
          }
        }
      }
    } catch {
      // 落到下面的重连
    }
    window.clearTimeout(watchdog)
    if (closed) return
    onStateChange?.(false)
    retryTimer = window.setTimeout(() => void run(), 2500)
  }

  void run()

  return () => {
    closed = true
    window.clearTimeout(retryTimer)
    ctrl?.abort()
  }
}
