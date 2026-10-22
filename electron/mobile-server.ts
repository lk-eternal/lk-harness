// ── 手机端远程对话网关（HTTP + SSE + Bearer Token 鉴权）────────────────────
// 职责：把桌面端「应用内对话」能力安全地暴露给手机 APP（局域网直连或公网地址），
// 同时托管编译好的移动端静态前端，支持手机 APP 扫码配对与浏览器扫码即用。

import { app, ipcMain } from "electron"
import * as http from "node:http"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import QRCode from "qrcode"
import { getAgentResource, getConfig, saveConfig } from "./config-store"
import { getAgentEngine } from "./agent-engine/factory"
import { applySessionModelChange, clearSessionQueue } from "./daemon-manager"
import { listDashboardTree, stopSessionAgent } from "./session-dispatcher"
import {
  callAppChatDaemon,
  clearAppChatRecords,
  createAppChatTempSession,
  deleteAppChatSession,
  readAppChatImage,
  renameAppChatSession,
  saveAppChatImage,
  sendAppChatMessage,
  subscribeAppChatEvent,
} from "./app-chat"
import { getAppChatTitles, subscribeAppChatTitles } from "./app-chat-title"
import { broadcastLog, subscribeSessionStatus } from "./ui-logger"
import { initSessionModelStore, listQuickModels } from "../src/shared/session-model-store.js"
import type { AppChatSendPayload } from "../src/shared/app-chat-types"
import { computeChallengeProof, createFileTicketStore, isPathInside } from "../src/shared/mobile-access.js"
import { MOBILE_NONCE_PATTERN } from "../src/shared/mobile-challenge.js"
import { buildPairPayload, encodePairPayload } from "../src/shared/mobile-pair.js"
import type { MobilePairPayload } from "../src/shared/mobile-pair.js"

const DEFAULT_MOBILE_PORT = 19529
const MAX_BODY_BYTES = 25 * 1024 * 1024
const IMAGE_CACHE_DIR = path.resolve(os.tmpdir(), "lk-harness-images")

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
}

export interface MobileServerStatus {
  enabled: boolean
  running: boolean
  port: number
  token: string
  publicUrl: string
  lanUrls: string[]
  pairUrl: string
  pairPayload: MobilePairPayload
  qrDataUrl: string
  error?: string
}

let server: http.Server | null = null
let activePort = DEFAULT_MOBILE_PORT
let lastError = ""
const sseClients = new Set<http.ServerResponse>()
const fileTickets = createFileTicketStore()
let unsubEvents: (() => void)[] = []

function ensureToken(): string {
  const current = getConfig().mobileToken?.trim()
  if (current && current.length >= 24) return current
  const next = randomBytes(24).toString("hex")
  saveConfig({ mobileToken: next })
  return next
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function listLanUrls(port: number): string[] {
  const nets = os.networkInterfaces()
  const urls: { url: string; priority: number }[] = []
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue
    const lower = name.toLowerCase()
    if (
      lower.includes("loopback") ||
      lower.includes("vethernet") ||
      lower.includes("wsl") ||
      lower.includes("docker") ||
      lower.includes("tun") ||
      lower.includes("tap") ||
      lower.includes("singbox") ||
      lower.includes("clash") ||
      lower.includes("meta")
    ) {
      continue
    }
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue
      const ip = addr.address
      if (ip.startsWith("169.254.")) continue
      const priority = ip.startsWith("192.168.") ? 1 : ip.startsWith("10.") ? 2 : ip.startsWith("172.") ? 3 : 4
      urls.push({ url: `http://${ip}:${port}`, priority })
    }
  }
  urls.sort((a, b) => a.priority - b.priority)
  return [...new Set(urls.map((u) => u.url))]
}

function checkToken(provided: string | null | undefined): boolean {
  if (!provided) return false
  const expected = ensureToken()
  const a = Buffer.from(provided.trim())
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 令牌只认 Authorization 头：放进 URL 会写进反向代理的访问日志、浏览器历史和 Referer */
function extractToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim()
  }
  return null
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  setCors(res)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error("请求体超过 25MB 限制"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (chunks.length === 0) { resolve({}); return }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {})
      } catch {
        reject(new Error("无效的 JSON 请求体"))
      }
    })
    req.on("error", reject)
  })
}

function broadcastSse(payload: unknown): void {
  if (sseClients.size === 0) return
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of [...sseClients]) {
    try {
      client.write(frame)
    } catch {
      sseClients.delete(client)
    }
  }
}

async function buildBootstrap() {
  const [cfg, tree] = await Promise.all([
    Promise.resolve(getConfig()),
    listDashboardTree(),
  ])
  const appCfgs = new Map((cfg.channels ?? []).filter((c) => c.type === "app" && c.enabled !== false).map((c) => [c.id, c]))
  const appChannels = tree.channels.filter((c) => appCfgs.has(c.channelId))
  const allKeys = appChannels.flatMap((c) => c.mainTabs.map((t) => t.sessionKey))
  const [activeRes, usageList] = await Promise.all([
    callAppChatDaemon("last-active", { sessionKeys: allKeys }),
    Promise.all(appChannels.map((c) => callAppChatDaemon("usage", { channelId: c.channelId }))),
  ])
  initSessionModelStore(app.getPath("userData"))
  const quickModels = listQuickModels(cfg.favoriteModels ?? [], 8)
  const usageBytes = usageList.reduce((acc, r) => acc + (r.ok ? (r.bytes ?? 0) : 0), 0)

  // 敏感凭据（apiKey）绝不下发到手机端，手机拉取模型列表走 /api/mobile/list-models
  const safeResources = (cfg.agentResources ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    providerId: r.providerId,
    baseUrl: r.baseUrl,
    modelIds: r.modelIds,
  }))

  return {
    ok: tree.ok,
    error: tree.error,
    hostname: os.hostname(),
    theme: cfg.theme,
    channels: appChannels.map((c) => ({
      channelId: c.channelId,
      name: appCfgs.get(c.channelId)?.name ?? c.name,
      agentResourceId: appCfgs.get(c.channelId)?.agentResourceId,
      tabs: c.mainTabs,
      activeKey: c.activeKey,
    })),
    titles: getAppChatTitles(),
    lastActive: activeRes.ok ? (activeRes.times ?? {}) : {},
    quickModels,
    resources: safeResources,
    usageBytes,
  }
}

/** 校验请求的文件/图片路径是否属于应用内对话历史或专用图片缓存目录，防止任意路径读取 */
async function isAuthorizedMediaPath(targetPath: string, sessionKey?: string): Promise<boolean> {
  if (!targetPath) return false
  const resolved = path.resolve(targetPath)
  if (resolved.toLowerCase().startsWith(IMAGE_CACHE_DIR.toLowerCase() + path.sep)) {
    return true
  }
  if (!sessionKey) return false
  const history = await callAppChatDaemon("history", { sessionKey })
  if (!history.ok || !history.items) return false
  for (const item of history.items) {
    if ((item.kind === "file" || item.kind === "image") && path.resolve(item.path).toLowerCase() === resolved.toLowerCase()) {
      return true
    }
    if (item.kind === "user" && item.images?.some((p) => path.resolve(p).toLowerCase() === resolved.toLowerCase())) {
      return true
    }
  }
  return false
}

function resolveMobileWebDir(): string | null {
  const candidates = [
    path.join(__dirname, "../mobile"),
    path.join(app.getAppPath(), "out/mobile"),
    ...(app.isPackaged ? [path.join(process.resourcesPath, "mobile")] : []),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir
  }
  return null
}

function serveStatic(reqPath: string, res: http.ServerResponse): void {
  const root = resolveMobileWebDir()
  if (!root) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end("<!doctype html><html><meta charset='utf-8'><body style='background:#0b0e17;color:#e5e7eb;font-family:sans-serif;padding:24px'><h3>LK Harness 手机网关已运行</h3><p>请在 LK Harness Mobile APP 中扫码连接。</p></body></html>")
    return
  }
  const clean = reqPath === "/" ? "/index.html" : reqPath
  const target = path.resolve(root, "." + clean)
  if (!isPathInside(root, target)) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }
  const file = fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(root, "index.html")
  if (!fs.existsSync(file)) {
    res.writeHead(404)
    res.end("Not Found")
    return
  }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
  })
  fs.createReadStream(file).pipe(res)
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    setCors(res)
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const pathname = url.pathname

  if (!pathname.startsWith("/api/mobile/")) {
    serveStatic(pathname, res)
    return
  }

  // 文件下载由浏览器 / 系统下载器直接打开，带不了 Authorization 头：
  // 凭 POST /api/mobile/file-ticket 换来的短时票据鉴权，令牌本身不出现在 URL 里
  if (req.method === "GET" && pathname === "/api/mobile/file") {
    const filePath = fileTickets.resolve(url.searchParams.get("ticket") ?? "")
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(res, 404, { ok: false, error: "下载链接已失效，请回到对话重新点击下载" })
      return
    }
    const stat = fs.statSync(filePath)
    const fileName = encodeURIComponent(path.basename(filePath))
    setCors(res)
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${fileName}`,
      "Cache-Control": "no-store",
    })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  // 挑战应答：手机在把令牌发给明文 http 地址之前，先确认对面是持有同一令牌的电脑端，所以这条不需要令牌。
  // 应答是令牌的 HMAC，推不出令牌本身
  if (req.method === "GET" && pathname === "/api/mobile/challenge") {
    const nonce = url.searchParams.get("nonce") ?? ""
    if (!MOBILE_NONCE_PATTERN.test(nonce)) {
      sendJson(res, 400, { ok: false, error: "nonce 格式不对" })
      return
    }
    sendJson(res, 200, { ok: true, proof: computeChallengeProof(ensureToken(), nonce) })
    return
  }

  if (!checkToken(extractToken(req))) {
    sendJson(res, 401, { ok: false, error: "Token 无效或已过期，请重新扫码配对" })
    return
  }

  if (req.method === "GET" && pathname === "/api/mobile/ping") {
    sendJson(res, 200, { ok: true, hostname: os.hostname(), ts: Date.now() })
    return
  }

  if (req.method === "GET" && pathname === "/api/mobile/bootstrap") {
    sendJson(res, 200, await buildBootstrap())
    return
  }

  if (req.method === "GET" && pathname === "/api/mobile/events") {
    setCors(res)
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write(`data: ${JSON.stringify({ type: "ready", ts: Date.now() })}\n\n`)
    sseClients.add(res)
    req.on("close", () => { sseClients.delete(res) })
    return
  }

  if (req.method === "GET" && pathname === "/api/mobile/image") {
    const filePath = url.searchParams.get("path") ?? ""
    const sessionKey = url.searchParams.get("sessionKey") ?? undefined
    if (!await isAuthorizedMediaPath(filePath, sessionKey)) {
      sendJson(res, 403, { ok: false, error: "无权访问该图片" })
      return
    }
    sendJson(res, 200, readAppChatImage(filePath))
    return
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method Not Allowed" })
    return
  }

  const body = await readJsonBody(req)

  switch (pathname) {
    case "/api/mobile/history": {
      const sessionKey = String(body.sessionKey ?? "")
      sendJson(res, 200, await callAppChatDaemon("history", { sessionKey }))
      return
    }
    case "/api/mobile/send": {
      const payload: AppChatSendPayload = {
        sessionKey: String(body.sessionKey ?? ""),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(Array.isArray(body.images) ? { images: body.images.map(String) } : {}),
        ...(typeof body.questionId === "string" ? { questionId: body.questionId } : {}),
        ...(typeof body.option === "string" ? { option: body.option } : {}),
      }
      sendJson(res, 200, await sendAppChatMessage(payload))
      return
    }
    case "/api/mobile/stop": {
      const sessionKey = String(body.sessionKey ?? "")
      await clearSessionQueue(sessionKey)
      await stopSessionAgent(sessionKey)
      sendJson(res, 200, { ok: true })
      return
    }
    case "/api/mobile/new-session": {
      const channelId = String(body.channelId ?? "")
      sendJson(res, 200, createAppChatTempSession(channelId))
      return
    }
    case "/api/mobile/rename-session": {
      const sessionKey = String(body.sessionKey ?? "")
      const name = String(body.name ?? "")
      sendJson(res, 200, renameAppChatSession(sessionKey, name))
      return
    }
    case "/api/mobile/clear-session": {
      const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined
      const channelId = typeof body.channelId === "string" ? body.channelId : undefined
      sendJson(res, 200, await clearAppChatRecords({ sessionKey, channelId }))
      return
    }
    case "/api/mobile/delete-session": {
      const sessionKey = String(body.sessionKey ?? "")
      sendJson(res, 200, await deleteAppChatSession(sessionKey))
      return
    }
    case "/api/mobile/set-model": {
      const sessionKey = String(body.sessionKey ?? "")
      const model = String(body.model ?? "")
      const modelParams = typeof body.modelParams === "string" ? body.modelParams : undefined
      const resourceId = typeof body.resourceId === "string" ? body.resourceId : undefined
      sendJson(res, 200, await applySessionModelChange(sessionKey, model, modelParams, resourceId))
      return
    }
    case "/api/mobile/list-models": {
      const resourceId = String(body.resourceId ?? "")
      const currentModel = typeof body.currentModel === "string" ? body.currentModel : undefined
      const currentParams = typeof body.currentParams === "string" ? body.currentParams : undefined
      const resource = getAgentResource(resourceId)
      if (!resource.id?.trim()) {
        sendJson(res, 200, { ok: false, models: [], error: "未找到该供应商资源" })
        return
      }
      const engine = getAgentEngine(resource)
      if (!engine.listModels) {
        sendJson(res, 200, { ok: false, models: [], error: "该供应商不支持模型列表" })
        return
      }
      const r = await engine.listModels(resource, undefined, currentModel, currentParams)
      sendJson(res, 200, r.ok ? { ok: true, models: r.models ?? [] } : { ok: false, models: [], error: r.error })
      return
    }
    case "/api/mobile/file-ticket": {
      const filePath = String(body.path ?? "")
      const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined
      if (!await isAuthorizedMediaPath(filePath, sessionKey) || !fs.existsSync(filePath)) {
        sendJson(res, 404, { ok: false, error: "文件不存在或无权访问" })
        return
      }
      sendJson(res, 200, { ok: true, ticket: fileTickets.issue(path.resolve(filePath)) })
      return
    }
    case "/api/mobile/upload-image": {
      const base64 = String(body.base64 ?? "").replace(/^data:[^;]+;base64,/, "")
      const ext = String(body.ext ?? "png")
      const buf = Buffer.from(base64, "base64")
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      sendJson(res, 200, saveAppChatImage(bytes, ext))
      return
    }
    default:
      sendJson(res, 404, { ok: false, error: "未知接口" })
  }
}

let keepAliveTimer: NodeJS.Timeout | null = null

export async function startMobileServer(portInput?: number): Promise<{ ok: boolean; error?: string }> {
  await stopMobileServer()
  const cfg = getConfig()
  const port = portInput && portInput > 0 && portInput < 65536 ? portInput : (cfg.mobilePort || DEFAULT_MOBILE_PORT)
  ensureToken()

  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      void handleRequest(req, res).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: msg })
      })
    })

    srv.once("error", (err: NodeJS.ErrnoException) => {
      lastError = err.code === "EADDRINUSE" ? `端口 ${port} 已被占用` : err.message
      broadcastLog(`[Mobile] 启动手机网关失败: ${lastError}`, "ERROR")
      resolve({ ok: false, error: lastError })
    })

    srv.listen(port, "0.0.0.0", () => {
      server = srv
      activePort = port
      lastError = ""
      unsubEvents = [
        subscribeAppChatEvent((event) => broadcastSse({ type: "chat", event })),
        subscribeAppChatTitles((titles) => broadcastSse({ type: "titles", titles })),
        subscribeSessionStatus(() => broadcastSse({ type: "sessions" })),
      ]
      keepAliveTimer = setInterval(() => {
        for (const client of [...sseClients]) {
          try { client.write(": ping\n\n") } catch { sseClients.delete(client) }
        }
      }, 20_000)
      broadcastLog(`[Mobile] 手机网关已监听 0.0.0.0:${port}`, "INFO")
      resolve({ ok: true })
    })
  })
}

/** 令牌只在建立实时流时校验一次：令牌作废后必须主动断开已建立的流，否则旧令牌的持有者还能继续收事件 */
function closeSseClients(): void {
  for (const client of sseClients) {
    try { client.end() } catch { /* ignore */ }
  }
  sseClients.clear()
}

export async function stopMobileServer(): Promise<void> {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
  for (const fn of unsubEvents) fn()
  unsubEvents = []
  closeSseClients()
  if (!server) return
  const closing = server
  server = null
  await new Promise<void>((resolve) => closing.close(() => resolve()))
}

export async function getMobileServerStatus(): Promise<MobileServerStatus> {
  const cfg = getConfig()
  const port = cfg.mobilePort || DEFAULT_MOBILE_PORT
  const token = ensureToken()
  const publicUrl = normalizeUrl(cfg.mobilePublicUrl ?? "")
  const lanUrls = listLanUrls(port)
  const pairPayload = buildPairPayload({ name: os.hostname(), token, publicUrl, lanUrls })
  const primary = publicUrl || lanUrls[0] || `http://127.0.0.1:${port}`
  // 配对信息放在 #fragment：浏览器不会把它发给服务器，反向代理日志和 Referer 里都不会出现令牌
  const pairUrl = `${primary}/#pair=${encodePairPayload(pairPayload)}`
  let qrDataUrl = ""
  try {
    // 双地址 + 令牌的链接有 ~300 字符，二维码很密：用低纠错、大尺寸，手机才扫得出来
    qrDataUrl = await QRCode.toDataURL(pairUrl, { width: 640, margin: 2, errorCorrectionLevel: "L" })
  } catch { /* ignore */ }

  return {
    enabled: !!cfg.mobileEnabled,
    running: server !== null,
    port: server ? activePort : port,
    token,
    publicUrl,
    lanUrls,
    pairUrl,
    pairPayload,
    qrDataUrl,
    ...(lastError ? { error: lastError } : {}),
  }
}

export function initMobileServer(): void {
  ipcMain.handle("mobile:status", () => getMobileServerStatus())
  ipcMain.handle("mobile:update", async (_e, patch: { enabled?: boolean; port?: number; publicUrl?: string }) => {
    const current = getConfig()
    const nextEnabled = patch.enabled ?? current.mobileEnabled
    const nextPort = patch.port && patch.port >= 1024 && patch.port < 65536 ? Math.floor(patch.port) : (current.mobilePort || DEFAULT_MOBILE_PORT)
    const nextPublicUrl = patch.publicUrl !== undefined ? normalizeUrl(patch.publicUrl) : current.mobilePublicUrl
    saveConfig({
      mobileEnabled: nextEnabled,
      mobilePort: nextPort,
      mobilePublicUrl: nextPublicUrl,
    })
    if (!nextEnabled) {
      await stopMobileServer()
      lastError = ""
    } else if (server === null || activePort !== nextPort) {
      // 只有端口变化或还没跑起来才重启；公网地址变化不影响监听，输入框失焦也不该踢掉所有手机连接
      await startMobileServer(nextPort)
    }
    return getMobileServerStatus()
  })
  ipcMain.handle("mobile:reset-token", async () => {
    const next = randomBytes(24).toString("hex")
    saveConfig({ mobileToken: next })
    closeSseClients()
    return getMobileServerStatus()
  })

  if (getConfig().mobileEnabled) {
    void startMobileServer(getConfig().mobilePort || DEFAULT_MOBILE_PORT)
  }
}
