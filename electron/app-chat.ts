// ── 应用内对话：主进程桥接 ─────────────────────────────────────────────
// 界面 ↔ Daemon：历史/发送/清空走 Daemon 的 /api/app-chat/*，聊天条目事件由
// daemon-manager 的 SSE 转给 forwardAppChatEvent，再推到所有窗口。

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { readLockFile } from "./daemon-client"
import { getChannel } from "./config-store"
import { deleteUserSession } from "./session-dispatcher"
import { ensureAppChatTitle, getAppChatTitles, removeAppChatChannelTitles, removeAppChatTitle, renameAppChatTitle } from "./app-chat-title"
import { APP_CHANNEL_CHAT_ID, chatIdFromSessionKey, channelIdFromSessionKey, makeChatKey, workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { createTempChatSession } from "../src/shared/temp-chat-session"
import { isTempChatWorkspace } from "../src/shared/temp-workspace"
import type { AppChatEvent, AppChatResult, AppChatSendPayload } from "../src/shared/app-chat-types"

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
/** 「打开」只放行文档/媒体类扩展名；Agent 发来的可执行文件只能「所在位置」，防一键运行 */
const OPENABLE_EXTS = new Set([
  ".txt", ".md", ".log", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".sql",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip",
  ...Object.keys(IMAGE_MIME),
])

async function callDaemon(action: string, body: object): Promise<AppChatResult> {
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
async function clearRecords(target: { sessionKey?: string; channelId?: string }): Promise<AppChatResult> {
  const r = await callDaemon("clear", target)
  if (!r.ok) return r
  if (target.sessionKey) removeAppChatTitle(target.sessionKey)
  else if (target.channelId) removeAppChatChannelTitles(target.channelId)
  return r
}

function renameSession(sessionKey: string, name: string): AppChatResult {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  try {
    renameAppChatTitle(sessionKey, name)
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 会话里第一条非指令的文字消息，作为生成标题的素材 */
async function firstUserText(sessionKey: string): Promise<string | undefined> {
  const r = await callDaemon("history", { sessionKey })
  const first = r.items?.find((it) => it.kind === "user" && it.text.trim() !== "" && !it.text.trim().startsWith("/"))
  return first?.kind === "user" ? first.text : undefined
}

/** 新建应用内临时会话：只建好临时目录并返回会话键，会话在第一条消息发出时才真正建立 */
function createTempSession(channelId: string): AppChatResult {
  if (getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的通道" }
  try {
    const { sessionKey } = createTempChatSession(app.getPath("userData"), makeChatKey(channelId, APP_CHANNEL_CHAT_ID))
    return { ok: true, sessionKey }
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
async function deleteSession(sessionKey: string): Promise<AppChatResult> {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  const r = await deleteUserSession(sessionKey, chatIdFromSessionKey(sessionKey))
  if (!r.ok) return { ok: false, error: r.error }
  removeTempWorkspace(sessionKey)
  return clearRecords({ sessionKey })
}

export function forwardAppChatEvent(event: AppChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("app-chat:event", event)
}

function saveImage(bytes: ArrayBuffer, ext: string): { ok: true; path: string } | { ok: false; error: string } {
  const normalized = `.${ext.replace(/^\./, "").toLowerCase()}`
  if (!IMAGE_MIME[normalized]) return { ok: false, error: `不支持的图片格式: ${ext}` }
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: "图片超过 20MB" }
  fs.mkdirSync(IMAGE_DIR, { recursive: true })
  const file = path.join(IMAGE_DIR, `img_app_${randomUUID()}${normalized}`)
  fs.writeFileSync(file, Buffer.from(bytes))
  return { ok: true, path: file }
}

function readImage(file: string): { ok: true; dataUrl: string } | { ok: false; error: string } {
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
  if (!OPENABLE_EXTS.has(path.extname(file).toLowerCase())) return { ok: false, error: "该类型文件不允许直接打开，请用「所在位置」" }
  if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
  const failure = await shell.openPath(file)
  return failure ? { ok: false, error: failure } : { ok: true }
}

export function initAppChat(): void {
  ipcMain.handle("app-chat:history", (_e, sessionKey: string) => callDaemon("history", { sessionKey }))
  ipcMain.handle("app-chat:send", async (_e, payload: AppChatSendPayload) => {
    const r = await callDaemon("send", payload)
    if (r.ok && !payload.questionId) void ensureAppChatTitle(payload.sessionKey, () => firstUserText(payload.sessionKey))
    return r
  })
  ipcMain.handle("app-chat:clear", (_e, target: { sessionKey?: string; channelId?: string }) => clearRecords(target))
  ipcMain.handle("app-chat:get-titles", () => getAppChatTitles())
  ipcMain.handle("app-chat:delete-session", (_e, sessionKey: string) => deleteSession(sessionKey))
  ipcMain.handle("app-chat:rename-session", (_e, sessionKey: string, name: string) => renameSession(sessionKey, name))
  ipcMain.handle("app-chat:new-temp-session", (_e, channelId: string) => createTempSession(channelId))
  ipcMain.handle("app-chat:usage", (_e, channelId: string) => callDaemon("usage", { channelId }))
  ipcMain.handle("app-chat:last-active", (_e, sessionKeys: string[]) => callDaemon("last-active", { sessionKeys }))
  ipcMain.handle("app-chat:save-image", (_e, bytes: ArrayBuffer, ext: string) => saveImage(bytes, ext))
  ipcMain.handle("app-chat:read-image", (_e, file: string) => readImage(file))
  ipcMain.handle("app-chat:copy-image", (_e, file: string) => copyImage(file))
  ipcMain.handle("app-chat:save-image-as", (_e, file: string) => saveImageAs(file))
  ipcMain.handle("app-chat:open-file", (_e, file: string) => openFile(file))
  ipcMain.handle("app-chat:show-in-folder", (_e, file: string) => {
    if (!fs.existsSync(file)) return { ok: false, error: "文件不存在" }
    shell.showItemInFolder(file)
    return { ok: true }
  })
}
