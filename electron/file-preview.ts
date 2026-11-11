// ── 应用内预览：本地文件（主进程接线）────────────────────────────────────────
// 校验与读取的逻辑在 src/shared/preview-open.ts；这里只把它接到应用的会话、配置和预览协议上。

import { app, ipcMain, protocol } from "electron"
import { Readable } from "node:stream"
import { callAppChatDaemon } from "./app-chat"
import { getChannel } from "./config-store"
import { channelIdFromSessionKey, workspaceDirFromSessionKey } from "../src/shared/channel-types"
import { initSessionOverridesStore, getSessionRecord } from "../src/shared/session-overrides-store"
import { getProject, initProjectStore } from "../src/shared/project-store"
import { projectIdFromSessionKey } from "../src/shared/project-types"
import { MOBILE_PREVIEW_TOKEN_TTL_MS, mobilePreviewPath } from "../src/shared/mobile-preview"
import { PREVIEW_SCHEME, createPreviewFileStore } from "../src/shared/preview-file-store"
import type { PreviewOpenResult } from "../src/shared/preview-types"
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

/**
 * 会话的工作目录：用户给会话选的目录优先；项目会话是项目的工作目录（项目成果都写在里面，
 * 项目信息里点成果要能预览，不能只认「聊天里发过的文件」）；否则是会话键里的目录（临时会话就是它自己的临时文件夹）
 */
function sessionWorkDir(sessionKey: string): string | undefined {
  initSessionOverridesStore(app.getPath("userData"))
  const bound = getSessionRecord(sessionKey)?.boundDir
  if (bound) return bound
  const projectId = projectIdFromSessionKey(sessionKey)
  if (projectId) {
    initProjectStore(app.getPath("userData"))
    const dir = getProject(projectId)?.worktreePath?.trim()
    if (dir) return dir
  }
  return workspaceDirFromSessionKey(sessionKey) || undefined
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

// 手机端：另起一个令牌仓库。令牌要写进 HTTP 链接（经局域网/公网网关访问），所以有有效期，
// 也不能和电脑端界面里用的 lkfile 令牌混在一起——后者没有有效期，也不该能被网关读到
const mobileStore = createPreviewFileStore(300, { ttlMs: MOBILE_PREVIEW_TOKEN_TTL_MS })
const openMobilePreviewFile = createPreviewOpener(mobileStore, openDeps)

/** 手机网关用：权限校验、路径确认、读取都和电脑端同一套逻辑，只是令牌仓库和链接格式不同 */
export const mobilePreview = {
  /** 返回的 url 是网关上的路径（不含地址），手机端自己拼上当前连接的地址 */
  async open(sessionKey: string, file: string): Promise<PreviewOpenResult> {
    const r = await openMobilePreviewFile(sessionKey, file)
    return r.ok ? { ...r, url: mobilePreviewPath(r.token, r.name) } : r
  },
  check: checkPreviewPaths,
  /** 预览令牌对应的真实文件；令牌失效返回 undefined（预览页里的「下载」凭它换下载票据） */
  fileOf: (token: string) => mobileStore.lookup(token)?.file,
  text: (token: string) => readPreviewTextByToken(mobileStore, token),
  zip: (token: string) => listZipByToken(mobileStore, token),
  serve: (token: string, relPath: string, opts: { range?: string | null; method?: string }) => mobileStore.serve(token, relPath, opts),
}

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
