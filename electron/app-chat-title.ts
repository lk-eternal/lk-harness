// ── 应用内对话：会话摘要标题 ─────────────────────────────────────────
// 会话的第一条文字消息发出后，用该会话所属 Agent 的引擎生成一个短标题，存在本机 JSON 里，
// 对话页拿它当会话名。清空记录 / 删除会话时一并清掉，下一条消息会重新生成。
// 生成失败只记日志，会话名继续显示目录名，下一条消息再试。

import * as fs from "node:fs"
import * as path from "node:path"
import { app, BrowserWindow } from "electron"
import { getAgentResource, getChannel } from "./config-store"
import { getAgentEngine } from "./agent-engine"
import { broadcastLog } from "./ui-logger"
import { channelIdFromSessionKey } from "../src/shared/channel-types"
import { appChatSessionId } from "../src/shared/app-chat-types"
import { initSessionModelStore, getSessionOverride } from "../src/shared/session-model-store.js"
import { initSessionResourceStore, resolveResourceForSession } from "../src/shared/session-resource-store.js"

const MAX_TITLE_CHARS = 30
const MAX_SOURCE_CHARS = 500

let cache: Record<string, string> | null = null
/** 正在生成的会话；清空/删除会把它摘掉，迟到的生成结果据此作废 */
const inflight = new Map<string, symbol>()
const titleListeners = new Set<(titles: Record<string, string>) => void>()

export function subscribeAppChatTitles(listener: (titles: Record<string, string>) => void): () => void {
  titleListeners.add(listener)
  return () => { titleListeners.delete(listener) }
}

function titlesFile(): string {
  return path.join(app.getPath("userData"), "app-chat-titles.json")
}

function titles(): Record<string, string> {
  if (cache) return cache
  const file = titlesFile()
  if (!fs.existsSync(file)) {
    cache = {}
    return cache
  }
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>
  } catch (e: unknown) {
    broadcastLog(`[AppChat] 会话标题文件损坏，已忽略: ${e instanceof Error ? e.message : String(e)}`, "WARN")
    cache = {}
  }
  return cache
}

function persistAndNotify(): void {
  fs.writeFileSync(titlesFile(), JSON.stringify(titles(), null, 2), "utf-8")
  const snapshot = getAppChatTitles()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("app-chat:titles", snapshot)
  for (const fn of titleListeners) {
    try { fn(snapshot) } catch { /* ignore */ }
  }
}

export function getAppChatTitles(): Record<string, string> {
  return { ...titles() }
}

export function removeAppChatTitle(sessionKey: string): void {
  const id = appChatSessionId(sessionKey)
  inflight.delete(id)
  if (!(id in titles())) return
  delete titles()[id]
  persistAndNotify()
}

/** 手动改名：覆盖自动标题并作废正在生成的那次；留空等于删掉标题，恢复自动命名 */
export function renameAppChatTitle(sessionKey: string, name: string): void {
  const title = Array.from(name.trim()).slice(0, MAX_TITLE_CHARS).join("")
  if (!title) {
    removeAppChatTitle(sessionKey)
    return
  }
  const id = appChatSessionId(sessionKey)
  inflight.delete(id)
  titles()[id] = title
  persistAndNotify()
}

export function removeAppChatChannelTitles(channelId: string): void {
  const owner = channelId.toLowerCase()
  for (const id of [...inflight.keys()]) {
    if (channelIdFromSessionKey(id) === owner) inflight.delete(id)
  }
  const stale = Object.keys(titles()).filter((id) => channelIdFromSessionKey(id) === owner)
  if (stale.length === 0) return
  for (const id of stale) delete titles()[id]
  persistAndNotify()
}

function buildPrompt(firstMessage: string): string {
  return [
    "为下面这条用户消息起一个会话标题。",
    "要求：不超过 16 个字，与消息使用同一种语言，只输出标题本身，不加引号、标点或任何解释。",
    "",
    "用户消息：",
    firstMessage.slice(0, MAX_SOURCE_CHARS),
  ].join("\n")
}

function normalizeTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ""
  const cleaned = firstLine
    .replace(/^[#"'“”‘’「」『』《》\s]+/, "")
    .replace(/["'“”‘’「」『』《》。.!！?？,，、;；:：…\s]+$/, "")
  return Array.from(cleaned).slice(0, MAX_TITLE_CHARS).join("")
}

async function generate(sessionKey: string, firstMessage: string): Promise<string> {
  const channel = getChannel(channelIdFromSessionKey(sessionKey))
  if (!channel) throw new Error("会话所属通道不存在")
  const userData = app.getPath("userData")
  initSessionModelStore(userData)
  initSessionResourceStore(userData)
  const resource = getAgentResource(resolveResourceForSession(sessionKey, channel.agentResourceId) ?? channel.agentResourceId)
  const engine = getAgentEngine(resource)
  if (!engine.complete) throw new Error(`引擎「${engine.kind}」不支持文本补全`)
  const model = getSessionOverride(sessionKey, resource.id)?.model?.trim() || channel.model?.trim() || ""
  const r = await engine.complete({ resource, model, prompt: buildPrompt(firstMessage) })
  if (!r.ok) throw new Error(r.error || "模型调用失败")
  const title = normalizeTitle(r.text ?? "")
  if (!title) throw new Error("模型没有返回可用的标题")
  return title
}

/** 会话还没有标题、也没在生成时，取第一条文字消息生成并保存；loadFirstMessage 只在确实需要时才调用 */
export async function ensureAppChatTitle(sessionKey: string, loadFirstMessage: () => Promise<string | undefined>): Promise<void> {
  const id = appChatSessionId(sessionKey)
  if (titles()[id] || inflight.has(id)) return
  const token = Symbol(id)
  inflight.set(id, token)
  try {
    const firstMessage = await loadFirstMessage()
    if (!firstMessage) return
    const title = await generate(sessionKey, firstMessage)
    if (inflight.get(id) !== token) return
    titles()[id] = title
    persistAndNotify()
  } catch (e: unknown) {
    broadcastLog(`[AppChat] 生成会话标题失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  } finally {
    if (inflight.get(id) === token) inflight.delete(id)
  }
}
