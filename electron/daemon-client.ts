import * as fs from "node:fs"
import * as path from "node:path"
import { app } from "electron"
import { LOCK_FILE_NAME } from "../src/shared/constants"
import { getChannel, getEnabledChannels, effectiveWorkspaceDir } from "./config-store"
import { makeChatKey, parseChatKey, normalizeSessionKey } from "../src/shared/channel-types"

export interface LockInfo { pid: number; port: number; version: string }

export function getLockFilePath(): string {
  return path.join(app.getPath("userData"), LOCK_FILE_NAME)
}

export function readLockFile(): LockInfo | null {
  try {
    const lockPath = getLockFilePath()
    if (!fs.existsSync(lockPath)) return null
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"))
  } catch {
    return null
  }
}

/** fetch failed（TypeError）多为本地回环 keep-alive 死连接复用（daemon 端已按空闲超时关闭），
 * 换新连接重试一次即可恢复；超时（DOMException）不重试。 */
async function fetchRetryOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e: unknown) {
    if (!(e instanceof TypeError)) throw e
    await new Promise((r) => setTimeout(r, 200))
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }
}

export async function httpGet(url: string, timeoutMs = 3000): Promise<unknown> {
  const res = await fetchRetryOnce(url, {}, timeoutMs)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function httpPost(url: string, body: object, timeoutMs = 3000): Promise<unknown> {
  const res = await fetchRetryOnce(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json().catch(() => null)
}

export async function notifySessionLaunched(
  sessionKey: string,
  opts: { resumed?: boolean; runtime?: "llm" | "sdk" },
): Promise<void> {
  const lock = readLockFile()
  if (!lock?.port) return
  try {
    await httpPost(
      `http://127.0.0.1:${lock.port}/api/session-launched`,
      { session_key: sessionKey, resumed: opts.resumed ?? false, runtime: opts.runtime },
      5_000,
    )
  } catch { /* best-effort */ }
}

/**
 * 会话进程被杀前通知 daemon 收口（best-effort）：掐掉该会话残留 poll 连接 + .claimed 回退 pending。
 * 不通知则旧 run 里 AI 挂的 curl 成孤儿继续领消息，投到无人读的 stdout 即静默丢失。
 */
export async function syncActiveSession(port: number, chatId: string, sessionKey: string): Promise<boolean> {
  try {
    const res = (await httpPost(`http://127.0.0.1:${port}/api/active-session`, { chatId, sessionKey })) as { ok?: boolean }
    return res?.ok !== false
  } catch {
    return false
  }
}

export async function getCurrentActiveSession(port: number, chatId: string): Promise<string | undefined> {
  try {
    const res = (await httpGet(`http://127.0.0.1:${port}/api/active-sessions`)) as { sessions?: Record<string, string> }
    return res?.sessions?.[chatId]
  } catch { return undefined }
}

export async function drainSessionMessages(port: number, sessionKey: string): Promise<number> {
  try {
    const res = (await httpPost(`http://127.0.0.1:${port}/dequeue-all`, { sessionKey })) as { messages?: unknown[] }
    return res?.messages?.length ?? 0
  } catch { return 0 }
}

export async function resolveMainChatId(port: number, preferredChatId?: string, channelId?: string): Promise<string | undefined> {
  const preferred = preferredChatId?.trim()
  if (preferred) {
    return preferred
  }
  const candidates = getEnabledChannels().filter((c) => !channelId || c.id === channelId)
  for (const c of candidates) {
    if (c.mainUserEnabled && c.mainUserChatId?.trim()) {
      return makeChatKey(c.id, c.mainUserChatId.trim())
    }
  }
  try {
    const res = (await httpGet(`http://127.0.0.1:${port}/api/active-sessions`)) as { sessions?: Record<string, string> }
    const keys = Object.keys(res?.sessions ?? {})
    return keys[0] || undefined
  } catch {
    return undefined
  }
}

/** 直投指定会话队列：任务与聊天消息同一套崩溃重投保障（独立定时任务 / 项目节点任务用） */
export async function enqueueToSession(
  port: number,
  sessionKey: string,
  content: string,
  chatType = "project",
  opts?: { channelId?: string; model?: string; modelParams?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await httpPost(`http://127.0.0.1:${port}/enqueue`, {
      content, sessionKey, chatType,
      channelId: opts?.channelId,
      model: opts?.model,
      modelParams: opts?.modelParams,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 主工作区 sessionKey（与 enqueueToMainSession 路由一致） */
export async function resolveMainSessionKey(
  port: number, preferredChatId?: string, channelId?: string,
): Promise<string | undefined> {
  const chatId = await resolveMainChatId(port, preferredChatId, channelId)
  if (!chatId) return undefined
  const parsed = parseChatKey(chatId)
  const channel = (channelId ? getChannel(channelId) : undefined)
    ?? (parsed.channelId ? getChannel(parsed.channelId) : undefined)
  const wsDir = effectiveWorkspaceDir(channel)
  return normalizeSessionKey(`${chatId}::${wsDir}`) || `${chatId}::${wsDir}`
}

/** 非独立定时任务 / 主会话通知：直投主工作区 sessionKey，不跟随当前 active 项目会话 */
export async function enqueueToMainSession(
  port: number, content: string, preferredChatId?: string, channelId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const mainSessionKey = await resolveMainSessionKey(port, preferredChatId, channelId)
  if (!mainSessionKey) {
    return { ok: false, error: "未绑定主用户且无活跃会话，无法入队" }
  }
  return enqueueToSession(port, mainSessionKey, content, "p2p")
}
