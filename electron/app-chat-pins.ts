// ── 应用内对话：置顶的会话 ───────────────────────────────────────────
// 置顶状态存在本机 JSON（userData/app-chat-pins.json），桌面端和手机端都以它为准：
// 谁改了都会推给所有桌面窗口和手机网关的实时流，两端的会话列表一起更新。
// 规则（怎么认、怎么改）在 src/shared/app-chat-pins.ts，两端共用。

import * as fs from "node:fs"
import * as path from "node:path"
import { app, BrowserWindow } from "electron"
import { broadcastLog } from "./ui-logger"
import { parsePinnedIds, setSessionPinned } from "../src/shared/app-chat-pins"

let cache: readonly string[] | null = null
const pinListeners = new Set<(pins: string[]) => void>()

export function subscribeAppChatPins(listener: (pins: string[]) => void): () => void {
  pinListeners.add(listener)
  return () => { pinListeners.delete(listener) }
}

function pinsFile(): string {
  return path.join(app.getPath("userData"), "app-chat-pins.json")
}

function pins(): readonly string[] {
  if (cache) return cache
  const file = pinsFile()
  if (!fs.existsSync(file)) {
    cache = []
    return cache
  }
  try {
    cache = parsePinnedIds(JSON.parse(fs.readFileSync(file, "utf-8")))
  } catch (e: unknown) {
    broadcastLog(`[AppChat] 置顶会话文件损坏，已忽略: ${e instanceof Error ? e.message : String(e)}`, "WARN")
    cache = []
  }
  return cache
}

/** 当前置顶的会话（appChatSessionId 列表，先置顶的在前） */
export function getAppChatPins(): string[] {
  return [...pins()]
}

/**
 * 置顶 / 取消置顶。已经是目标状态时什么都不做（不写盘、不通知）；
 * 先写盘再更新内存：写不进去会抛错，内存和磁盘不会各是各的。
 */
export function setAppChatPinned(sessionKey: string, pinned: boolean): void {
  const next = setSessionPinned(pins(), sessionKey, pinned)
  if (next === pins()) return
  fs.writeFileSync(pinsFile(), JSON.stringify(next, null, 2), "utf-8")
  cache = next
  const snapshot = getAppChatPins()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("app-chat:pins", snapshot)
  for (const fn of pinListeners) {
    try { fn(snapshot) } catch { /* ignore */ }
  }
}

/** 会话删掉后顺手取消置顶，免得之后同一个目录重新开会话时它莫名其妙就在最上面；这件事失败不该连累删除 */
export function removeAppChatPin(sessionKey: string): void {
  try {
    setAppChatPinned(sessionKey, false)
  } catch (e: unknown) {
    broadcastLog(`[AppChat] 取消会话置顶失败: ${e instanceof Error ? e.message : String(e)}`, "WARN")
  }
}
