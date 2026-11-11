// ── 应用内对话：主进程桥接 ─────────────────────────────────────────────
// 界面 ↔ Daemon：历史/发送/清空走 Daemon 的 /api/app-chat/*，聊天条目事件由
// daemon-manager 的 SSE 转给 forwardAppChatEvent，再推到所有窗口。

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { readLockFile } from "./daemon-client"
import { getAgentResource, getChannel } from "./config-store"
import { deleteUserSession } from "./session-dispatcher"
import { ensureAppChatTitle, getAppChatTitles, removeAppChatChannelTitles, removeAppChatTitle, renameAppChatTitle } from "./app-chat-title"
import { getAppChatPins, removeAppChatPin, setAppChatPinned } from "./app-chat-pins"
import { APP_CHANNEL_CHAT_ID, chatIdFromSessionKey, channelIdFromSessionKey, makeChatKey, resolveChannelResourceId, workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { initSessionModelStore, seedNewSessionModel } from "../src/shared/session-model-store"
import { initSessionOverridesStore, patchSessionRecord } from "../src/shared/session-overrides-store"
import { createTempChatSession } from "../src/shared/temp-chat-session"
import { isTempChatWorkspace } from "../src/shared/temp-workspace"
import type { AppChatEvent, AppChatResult, AppChatSendPayload } from "../src/shared/app-chat-types"
import { parseHistoryQuery, type HistoryQuery } from "../src/shared/app-chat-history-page"
import { canOpenWithDefaultApp } from "../src/shared/preview-kinds"

/** 与飞书下载图片同目录，沿用 `[图片已保存: …]` 约定，Daemon 的媒体缓存清理一并覆盖 */
const IMAGE_DIR = path.join(os.tmpdir(), "lk-harness-images")
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export async function callAppChatDaemon(action: string, body: object): Promise<AppChatResult> {
  const lock = readLockFile()
  if (!lock?.port) return { ok: false, error: "Daemon 未运行" }
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/app-chat/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return (await res.json()) as AppChatResult
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 清聊天记录，会话摘要标题随记录一起清掉（下一条消息重新生成） */
export async function clearAppChatRecords(target: { sessionKey?: string; channelId?: string }): Promise<AppChatResult> {
  const r = await callAppChatDaemon("clear", target)
  if (!r.ok) return r
  if (target.sessionKey) removeAppChatTitle(target.sessionKey)
  else if (target.channelId) removeAppChatChannelTitles(target.channelId)
  return r
}

export function renameAppChatSession(sessionKey: string, name: string): AppChatResult {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  try {
    renameAppChatTitle(sessionKey, name)
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 置顶 / 取消置顶；返回最新的置顶列表，调用方（手机端）可以直接用来刷新 */
export function setAppChatSessionPinned(sessionKey: string, pinned: boolean): AppChatResult {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  try {
    setAppChatPinned(sessionKey, pinned)
    return { ok: true, pins: getAppChatPins() }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 会话里第一条非指令的文字消息，作为生成标题的素材 */
async function firstUserText(sessionKey: string): Promise<string | undefined> {
  const r = await callAppChatDaemon("history", { sessionKey })
  const first = r.items?.find((it) => it.kind === "user" && it.text.trim() !== "" && !it.text.trim().startsWith("/"))
  return first?.kind === "user" ? first.text : undefined
}

export async function sendAppChatMessage(payload: AppChatSendPayload): Promise<AppChatResult> {
  const r = await callAppChatDaemon("send", payload)
  if (r.ok && !payload.questionId) void ensureAppChatTitle(payload.sessionKey, () => firstUserText(payload.sessionKey))
  return r
}

/**
 * 新会话的默认模型用「这个通道里我上一次用的模型」，不是通道设置里的默认模型。
 * 供应商取会话启动时实际生效的那个（通道没绑供应商时启动会回落到默认供应商），
 * 写进去的 override 要与它一致才会在启动时生效，界面显示和实际用的才不会对不上。
 */
function seedNewSessionDefaultModel(channelId: string, sessionKey: string): void {
  try {
    const channel = getChannel(channelId)
    const resource = getAgentResource(resolveChannelResourceId(channel, "main"))
    if (resource.id === "unset") return
    initSessionModelStore(app.getPath("userData"))
    seedNewSessionModel(sessionKey, channelId, resource.id)
  } catch { /* 记录读写失败就退回通道默认模型，不影响新建会话 */ }
}

/** 用户选的工作目录必须真实存在且是目录；返回规范化后的绝对路径（去掉末尾分隔符） */
function checkPickedDir(dir: string | undefined): { ok: true; dir: string } | { ok: false; error: string } {
  const d = dir?.trim()
  if (!d || !path.isAbsolute(d)) return { ok: false, error: "请选择一个有效的目录" }
  try {
    if (!fs.statSync(d).isDirectory()) return { ok: false, error: `不是目录：${d}` }
  } catch {
    return { ok: false, error: `目录不存在：${d}` }
  }
  return { ok: true, dir: path.resolve(d) }
}

/** 把工作目录记到会话上：此后 Agent 以它为 cwd 启动（见 SessionOverrideRecord.boundDir） */
function bindSessionDir(sessionKey: string, dir: string): void {
  initSessionOverridesStore(app.getPath("userData"))
  patchSessionRecord(sessionKey, { boundDir: dir })
}

/**
 * 新建应用内临时会话：只建好临时目录并返回会话键，会话在第一条消息发出时才真正建立。
 * 带 dir 时会话直接选好这个工作目录（目录与会话不是一一对应，已有会话在用同一个目录也照样新建）。
 */
export function createAppChatTempSession(channelId: string, dir?: string): AppChatResult {
  if (getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的通道" }
  const picked = dir === undefined ? undefined : checkPickedDir(dir)
  if (picked && !picked.ok) return { ok: false, error: picked.error }
  try {
    const { sessionKey } = createTempChatSession(app.getPath("userData"), makeChatKey(channelId, APP_CHANNEL_CHAT_ID))
    try {
      seedNewSessionDefaultModel(channelId, sessionKey)
      if (picked) bindSessionDir(sessionKey, picked.dir)
    } catch (e: unknown) {
      removeTempWorkspace(sessionKey)
      throw e
    }
    return { ok: true, sessionKey }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 给还没开始的临时会话选工作目录（或改选）。会话一开始就不能再换：
 * SDK 的续聊要求 cwd 不变，换了目录 Agent 的上下文就接不上，所以开始后换目录要新建会话。
 * 键里带真实目录的会话（常用目录、主目录）目录就是它的身份，也不能改。
 */
export async function setAppChatSessionDir(sessionKey: string, dir: string): Promise<AppChatResult> {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  if (!isTempChatWorkspace(workspaceDirFromSessionKey(sessionKey))) return { ok: false, error: "这个会话的目录是固定的，要换目录请新建会话" }
  const picked = checkPickedDir(dir)
  if (!picked.ok) return { ok: false, error: picked.error }
  const active = await callAppChatDaemon("last-active", { sessionKeys: [sessionKey] })
  if (!active.ok) return { ok: false, error: active.error ?? "无法确认会话状态，请稍后再试" }
  if (Object.keys(active.times ?? {}).length > 0) return { ok: false, error: "会话已经开始，不能再换目录；要换目录请新建会话" }
  try {
    bindSessionDir(sessionKey, picked.dir)
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 删掉临时会话的目录；只动 <userData>/workspaces 下 temp_<时间戳> 形态的目录，其它目录一律不碰 */
function removeTempWorkspace(sessionKey: string): void {
  const dir = workspaceDirFromSessionKey(sessionKey)
  if (!dir || !isTempChatWorkspace(dir)) return
  const root = path.resolve(app.getPath("userData"), "workspaces")
  const target = path.resolve(dir)
  if (path.dirname(target).toLowerCase() !== root.toLowerCase()) return
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch { /* 目录被占用时留在磁盘上，不影响会话删除 */ }
}

/** 删除应用内会话：先清 Agent 侧（进程、上下文、常用目录），成功后再清聊天记录；临时会话的目录一并删掉 */
export async function deleteAppChatSession(sessionKey: string): Promise<AppChatResult> {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  const r = await deleteUserSession(sessionKey, chatIdFromSessionKey(sessionKey))
  if (!r.ok) return { ok: false, error: r.error }
  removeTempWorkspace(sessionKey)
  removeAppChatPin(sessionKey)
  return clearAppChatRecords({ sessionKey })
}

/** 暂存区：编辑一条还在排队的消息的正文 */
export function editQueuedAppChatMessage(sessionKey: string, messageId: string, text: string): Promise<AppChatResult> {
  return callAppChatDaemon("queue-edit", { sessionKey, messageId, text })
}

/** 暂存区：撤回一条还在排队的消息 */
export function removeQueuedAppChatMessage(sessionKey: string, messageId: string): Promise<AppChatResult> {
  return callAppChatDaemon("queue-remove", { sessionKey, messageId })
}

const appChatEventListeners = new Set<(event: AppChatEvent) => void>()

export function subscribeAppChatEvent(listener: (event: AppChatEvent) => void): () => void {
  appChatEventListeners.add(listener)
  return () => { appChatEventListeners.delete(listener) }
}

export function forwardAppChatEvent(event: AppChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("app-chat:event", event)
  for (const fn of appChatEventListeners) {
    try { fn(event) } catch { /* ignore */ }
  }
}

export function saveAppChatImage(bytes: ArrayBuffer, ext: string): { ok: true; path: string } | { ok: false; error: string } {
  const normalized = `.${ext.replace(/^\./, "").toLowerCase()}`
  if (!IMAGE_MIME[normalized]) return { ok: false, error: `不支持的图片格式: ${ext}` }
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: "图片超过 20MB" }
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const file = path.join(IMAGE_DIR, `img_app_${randomUUID()}${normalized}`)
  fs.writeFileSync(file, Buffer.from(bytes))
  return { ok: true, path: file }
}

export function readAppChatImage(file: string): { ok: true; dataUrl: string } | { ok: false; error: string } {
  const mime = IMAGE_MIME[path.extname(file).toLowerCase()]
  if (!mime) return { ok: false, error: "不是图片文件" }
  if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
  if (fs.statSync(file).size > MAX_IMAGE_BYTES) return { ok: false, error: "图片超过 20MB" }
  return { ok: true, dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString("base64")}` }
}

function copyImage(file: string): { ok: boolean; error?: string } {
  if (!IMAGE_MIME[path.extname(file).toLowerCase()]) return { ok: false, error: "不是图片文件" }
  if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) return { ok: false, error: "图片无法解码" }
  clipboard.writeImage(image)
  return { ok: true }
}

async function saveImageAs(file: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const ext = path.extname(file).toLowerCase()
  if (!IMAGE_MIME[ext]) return { ok: false, error: "不是图片文件" }
  if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return { ok: false, error: "窗口不可用" }
  const result = await dialog.showSaveDialog(win, {
    title: "保存图片",
    defaultPath: path.join(app.getPath("downloads"), path.basename(file)),
    filters: [{ name: "图片", extensions: [ext.slice(1)] }],
  })
  if (result.canceled || !result.filePath) return { ok: true, canceled: true }
  try {
    fs.copyFileSync(file, result.filePath)
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true }
}

async function openFile(file: string): Promise<{ ok: boolean; error?: string }> {
  if (!canOpenWithDefaultApp(file)) return { ok: false, error: "该类型文件不允许直接打开，请用「所在位置」" }
  if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
  const failure = await shell.openPath(file)
  return failure ? { ok: false, error: failure } : { ok: true }
}

export function initAppChat(): void {
  ipcMain.handle("app-chat:history", (_e, sessionKey: string, query?: HistoryQuery) => callAppChatDaemon("history", { sessionKey, ...parseHistoryQuery(query) }))
  ipcMain.handle("app-chat:send", (_e, payload: AppChatSendPayload) => sendAppChatMessage(payload))
  ipcMain.handle("app-chat:clear", (_e, target: { sessionKey?: string; channelId?: string }) => clearAppChatRecords(target))
  ipcMain.handle("app-chat:get-titles", () => getAppChatTitles())
  ipcMain.handle("app-chat:get-pins", () => getAppChatPins())
  ipcMain.handle("app-chat:set-pinned", (_e, sessionKey: string, pinned: boolean) => setAppChatSessionPinned(sessionKey, pinned === true))
  ipcMain.handle("app-chat:delete-session", (_e, sessionKey: string) => deleteAppChatSession(sessionKey))
  ipcMain.handle("app-chat:rename-session", (_e, sessionKey: string, name: string) => renameAppChatSession(sessionKey, name))
  ipcMain.handle("app-chat:queue-edit", (_e, sessionKey: string, messageId: string, text: string) => editQueuedAppChatMessage(sessionKey, messageId, text))
  ipcMain.handle("app-chat:queue-remove", (_e, sessionKey: string, messageId: string) => removeQueuedAppChatMessage(sessionKey, messageId))
  ipcMain.handle("app-chat:new-temp-session", (_e, channelId: string, dir?: string) => createAppChatTempSession(channelId, dir))
  ipcMain.handle("app-chat:set-session-dir", (_e, sessionKey: string, dir: string) => setAppChatSessionDir(sessionKey, dir))
  ipcMain.handle("app-chat:usage", (_e, channelId: string) => callAppChatDaemon("usage", { channelId }))
  ipcMain.handle("app-chat:last-active", (_e, sessionKeys: string[]) => callAppChatDaemon("last-active", { sessionKeys }))
  ipcMain.handle("app-chat:save-image", (_e, bytes: ArrayBuffer, ext: string) => saveAppChatImage(bytes, ext))
  ipcMain.handle("app-chat:read-image", (_e, file: string) => readAppChatImage(file))
  ipcMain.handle("app-chat:copy-image", (_e, file: string) => copyImage(file))
  ipcMain.handle("app-chat:save-image-as", (_e, file: string) => saveImageAs(file))
  ipcMain.handle("app-chat:open-file", (_e, file: string) => openFile(file))
  ipcMain.handle("app-chat:show-in-folder", (_e, file: string) => {
    if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
    shell.showItemInFolder(file)
    return { ok: true }
  })
}
