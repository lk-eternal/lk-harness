// ── 应用内对话：会话列表各分类（项目 / 会话 / 已归档）的折叠和展开状态 ─────────────────
// 存在本机 JSON（userData/app-chat-session-groups.json），桌面端和手机端都以它为准：
// 谁改了都会推给所有桌面窗口和手机网关的实时流，两端的会话列表一起更新。
// 规则（分哪几类、怎么认、怎么改）在 src/shared/session-groups.ts，两端共用。

import * as fs from "node:fs"
import * as path from "node:path"
import { app, BrowserWindow } from "electron"
import { broadcastLog } from "./ui-logger"
import { applyGroupPatch, parseGroupStates, type GroupStatePatch, type SessionGroupStates, type SessionListGroupId } from "../src/shared/session-groups"

let cache: SessionGroupStates | null = null
const stateListeners = new Set<(states: SessionGroupStates) => void>()

export function subscribeSessionGroupStates(listener: (states: SessionGroupStates) => void): () => void {
  stateListeners.add(listener)
  return () => { stateListeners.delete(listener) }
}

function statesFile(): string {
  return path.join(app.getPath("userData"), "app-chat-session-groups.json")
}

function states(): SessionGroupStates {
  if (cache) return cache
  const file = statesFile()
  if (!fs.existsSync(file)) {
    cache = parseGroupStates(undefined)
    return cache
  }
  try {
    cache = parseGroupStates(JSON.parse(fs.readFileSync(file, "utf-8")))
  } catch (e: unknown) {
    broadcastLog(`[AppChat] 会话分类状态文件损坏，已忽略: ${e instanceof Error ? e.message : String(e)}`, "WARN")
    cache = parseGroupStates(undefined)
  }
  return cache
}

/** 各分类当前的折叠 / 展开状态（没存过的是默认值） */
export function getSessionGroupStates(): SessionGroupStates {
  return parseGroupStates(states())
}

/**
 * 改某一类的折叠 / 展开状态。已经是目标状态时什么都不做（不写盘、不通知）；
 * 先写盘再更新内存：写不进去会抛错，内存和磁盘不会各是各的。
 */
export function setSessionGroupState(group: SessionListGroupId, patch: GroupStatePatch): void {
  const next = applyGroupPatch(states(), group, patch)
  if (next === states()) return
  fs.writeFileSync(statesFile(), JSON.stringify(next, null, 2), "utf-8")
  cache = next
  const snapshot = getSessionGroupStates()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("app-chat:session-groups", snapshot)
  for (const fn of stateListeners) {
    try { fn(snapshot) } catch { /* ignore */ }
  }
}
