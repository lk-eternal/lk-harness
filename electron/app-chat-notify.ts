// ── 应用内对话：回复完成的系统通知（主进程接线）──────────────────────────
// 什么时候弹、弹什么的规则在 src/shared/app-chat-notify.ts；这里把它接到聊天事件、系统通知和窗口上。
// 「你是不是正看着这个会话」由对话页告诉主进程（app-chat:viewing），窗口是否在前台由主进程自己判断。
// 点通知：把窗口唤到前台，并让对话页切到这个会话（app-chat:open-session）。

import { app, BrowserWindow, ipcMain, Notification } from "electron"
import { subscribeAppChatEvent } from "./app-chat"
import { getAppChatTitles } from "./app-chat-title"
import { appChatSessionName } from "../src/shared/app-chat-types"
import { createReplyNotifier, isViewingSession, type ReplyNotice } from "../src/shared/app-chat-notify"
import { getSessionRecord, initSessionOverridesStore } from "../src/shared/session-overrides-store"
import { getProject, initProjectStore } from "../src/shared/project-store"
import { projectIdFromSessionKey } from "../src/shared/project-types"

/** Windows 通知归属：要和安装包快捷方式的 AppUserModelID 一致（electron-builder.yml 的 appId），通知才算这个应用发的 */
const APP_USER_MODEL_ID = "com.lk-harness.desktop"

/** 对话页上报的：此刻停在对话页、选中的会话；不在对话页为 null */
let viewing: string | null = null

/** 通知对象要留着，被回收了点击事件就收不到 */
const live = new Set<Notification>()

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
}

/** 窗口真的在用户眼前：可见、没最小化、有焦点（隐藏到托盘、被别的程序盖在后面都不算） */
function windowActive(win: BrowserWindow | undefined): boolean {
  return !!win && win.isVisible() && !win.isMinimized() && win.isFocused()
}

/** 会话在界面上叫什么：和对话页同一条规则（摘要标题 > 目录名 > 项目名） */
function sessionName(sessionKey: string): string {
  let boundDir: string | undefined
  let fallback: string | undefined
  try {
    const userData = app.getPath("userData")
    initSessionOverridesStore(userData)
    boundDir = getSessionRecord(sessionKey)?.boundDir
    const projectId = projectIdFromSessionKey(sessionKey)
    if (projectId) {
      initProjectStore(userData)
      fallback = getProject(projectId)?.name
    }
  } catch { /* 读不到就用标题 / 键里的目录名，通知照发 */ }
  return appChatSessionName(sessionKey, getAppChatTitles(), fallback, boundDir) ?? "应用内会话"
}

function openSession(sessionKey: string): void {
  const win = mainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send("app-chat:open-session", sessionKey)
}

function showNotice(notice: ReplyNotice): void {
  // 没有窗口（macOS 关了窗口但应用还在）时点通知没处可跳，不弹
  if (!Notification.isSupported() || !mainWindow()) return
  const n = new Notification({ title: notice.title, body: notice.body })
  live.add(n)
  const release = () => { live.delete(n) }
  n.on("click", () => {
    release()
    openSession(notice.sessionKey)
  })
  n.on("close", release)
  n.on("failed", release)
  n.show()
}

export function initAppChatNotify(): void {
  if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_USER_MODEL_ID)
  ipcMain.on("app-chat:viewing", (_e, sessionKey: unknown) => {
    viewing = typeof sessionKey === "string" && sessionKey !== "" ? sessionKey : null
  })
  subscribeAppChatEvent(createReplyNotifier({
    isViewing: (sessionKey) => isViewingSession(viewing, sessionKey, windowActive(mainWindow())),
    sessionName,
    show: showNotice,
  }))
}
