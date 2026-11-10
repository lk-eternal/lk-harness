// ── 应用内预览：本地文件（主进程接线）────────────────────────────────────────
// 校验与读取的逻辑在 src/shared/preview-open.ts；这里只把它接到应用的会话、配置和预览协议上。

import { app, ipcMain, protocol } from "electron"
import { Readable } from "node:stream"
import { callAppChatDaemon } from "./app-chat"
import { getChannel } from "./config-store"
import { channelIdFromSessionKey, workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { initSessionOverridesStore, getSessionRecord } from "../src/shared/session-overrides-store"
import { PREVIEW_SCHEME, createPreviewFileStore } from "../src/shared/preview-file-store"
import {
  createPreviewChecker, createPreviewOpener, listZipByToken, readPreviewBytesByToken, readPreviewTextByToken,
  type PreviewOpenDeps,
} from "../src/shared/preview-open"

const store = createPreviewFileStore()

/** 必须在 app ready 之前调用：自定义协议要先声明成「标准 + 可流式」，音视频才能按范围读取、拖动进度 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

/** 会话的工作目录：用户给会话选的目录优先，否则是会话键里的目录（临时会话就是它自己的临时文件夹） */
function sessionWorkDir(sessionKey: string): string | undefined {
  initSessionOverridesStore(app.getPath("userData"))
  return getSessionRecord(sessionKey)?.boundDir || workspaceDirFromSessionKey(sessionKey) || undefined
}

const openDeps: PreviewOpenDeps = {
  isAppSession: (sessionKey) => {
    const channelId = channelIdFromSessionKey(sessionKey)
    return !!channelId && getChannel(channelId)?.type === "app"
  },
  isReferenced: async (sessionKey, file) => {
    const r = await callAppChatDaemon("references-path", { sessionKey, path: file })
    return r.ok && r.owned === true
  },
  workDir: sessionWorkDir,
}
const openPreviewFile = createPreviewOpener(store, openDeps)
const checkPreviewPaths = createPreviewChecker(openDeps)

export function initFilePreview(): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const url = new URL(request.url)
    const result = store.serve(url.hostname, url.pathname, { range: request.headers.get("range"), method: request.method })
    const body = result.body ? (Readable.toWeb(result.body) as unknown as ReadableStream) : null
    return new Response(body, { status: result.status, headers: result.headers })
  })
  ipcMain.handle("preview:file-open", (_e, sessionKey: string, file: string) => openPreviewFile(sessionKey, file))
  ipcMain.handle("preview:file-check", (_e, sessionKey: string, paths: string[]) => checkPreviewPaths(sessionKey, paths))
  ipcMain.handle("preview:file-text", (_e, token: string) => readPreviewTextByToken(store, token))
  ipcMain.handle("preview:file-bytes", (_e, token: string) => readPreviewBytesByToken(store, token))
  ipcMain.handle("preview:file-zip", (_e, token: string) => listZipByToken(store, token))
}
