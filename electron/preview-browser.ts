// ── 应用内预览：内置浏览器 ───────────────────────────────────────────────────
// 每个网页标签页是一个独立的 WebContentsView，盖在界面预览面板的网页区域上方（原生视图在 DOM 之上）。
// 网页是不可信内容，所以：独立存储分区、沙箱、没有 preload（拿不到 electronAPI）、拒绝所有权限请求、
// 只允许 http(s)（file:、自定义协议的跳转一律拦掉）、新窗口不弹，交给界面开成新标签页。

import { BrowserWindow, Menu, WebContentsView, clipboard, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron"
import { isHttpUrl } from "../src/shared/preview-url"
import type { PreviewRect, PreviewWebNav, PreviewWebOpenTab, PreviewWebState } from "../src/shared/preview-types"

const PARTITION = "persist:lk-preview-browser"

interface WebTab {
  id: string
  win: BrowserWindow
  view: WebContentsView
  /** 最近一次请求打开的网址：页面还没加载出来（失败）时「重试」要用它 */
  requestedUrl: string
  error?: string
  favicon?: string
}

const tabs = new Map<string, WebTab>()
const hookedWindows = new WeakSet<BrowserWindow>()
let sessionConfigured = false

function browserSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION)
  if (!sessionConfigured) {
    sessionConfigured = true
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    // 默认 UA 带着 Electron 和应用名，部分网站会因此给降级页面
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|lk-harness)\/\S+/gi, ""))
  }
  return ses
}

function snapshotOf(tab: WebTab): PreviewWebState {
  const wc = tab.view.webContents
  return {
    tabId: tab.id,
    url: wc.getURL() || tab.requestedUrl,
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    ...(tab.error ? { error: tab.error } : {}),
    ...(tab.favicon ? { favicon: tab.favicon } : {}),
  }
}

function pushState(tab: WebTab): void {
  if (tab.win.isDestroyed() || tab.win.webContents.isDestroyed()) return
  tab.win.webContents.send("preview-web:state", snapshotOf(tab))
}

function sendOpenTab(win: BrowserWindow, payload: PreviewWebOpenTab): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("preview-web:open-tab", payload)
}

function destroyTab(tab: WebTab): void {
  tabs.delete(tab.id)
  try {
    if (!tab.win.isDestroyed()) tab.win.contentView.removeChildView(tab.view)
  } catch { /* 窗口已在销毁中 */ }
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
}

function destroyWindowTabs(win: BrowserWindow): void {
  for (const tab of [...tabs.values()]) if (tab.win === win) destroyTab(tab)
}

function showContextMenu(tab: WebTab, params: Electron.ContextMenuParams): void {
  const wc = tab.view.webContents
  const items: Electron.MenuItemConstructorOptions[] = []
  if (isHttpUrl(params.linkURL)) {
    const link = params.linkURL
    items.push(
      { label: "在新标签页打开链接", click: () => sendOpenTab(tab.win, { fromTabId: tab.id, url: link }) },
      { label: "在系统浏览器中打开链接", click: () => void shell.openExternal(link) },
      { label: "复制链接地址", click: () => clipboard.writeText(link) },
      { type: "separator" },
    )
  }
  if (params.isEditable) {
    items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" })
  } else if (params.selectionText) {
    items.push({ role: "copy" })
  } else {
    items.push(
      { label: "后退", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: "前进", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: "刷新", click: () => wc.reload() },
    )
  }
  Menu.buildFromTemplate(items).popup({ window: tab.win })
}

function createTab(win: BrowserWindow, id: string): WebTab {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  browserSession()
  view.setVisible(false)
  win.contentView.addChildView(view)
  const tab: WebTab = { id, win, view, requestedUrl: "" }
  tabs.set(id, tab)

  if (!hookedWindows.has(win)) {
    hookedWindows.add(win)
    // 界面整页重载（开发时热更新）后，旧界面里的标签页状态没了，原生视图不能留着。
    // 只认主框架的整页跳转：不能用 did-start-loading，界面里任何 iframe（HTML / PDF 预览）开始加载它也会触发，
    // 用户一打开 HTML 预览，所有网页标签页就被销毁了
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) destroyWindowTabs(win)
    })
    win.on("closed", () => destroyWindowTabs(win))
  }

  const wc = view.webContents
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) sendOpenTab(win, { fromTabId: id, url })
    return { action: "deny" }
  })
  const blockNonHttp = (event: Electron.Event, url: string) => {
    if (!isHttpUrl(url)) event.preventDefault()
  }
  wc.on("will-navigate", blockNonHttp)
  wc.on("will-redirect", blockNonHttp)

  wc.on("did-start-loading", () => { tab.error = undefined; pushState(tab) })
  wc.on("did-stop-loading", () => pushState(tab))
  wc.on("page-title-updated", () => pushState(tab))
  wc.on("did-navigate", () => pushState(tab))
  wc.on("did-navigate-in-page", () => pushState(tab))
  wc.on("page-favicon-updated", (_e, favicons) => {
    tab.favicon = favicons.find(isHttpUrl)
    pushState(tab)
  })
  wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
    // -3 是被新的跳转打断（ERR_ABORTED），不算失败
    if (!isMainFrame || code === -3) return
    tab.error = `${description || "加载失败"}（${code}）`
    pushState(tab)
  })
  wc.on("render-process-gone", () => {
    tab.error = "网页进程已崩溃，请刷新重试"
    pushState(tab)
  })
  wc.on("context-menu", (_e, params) => showContextMenu(tab, params))
  return tab
}

/** 界面上的网页区域位置（CSS 像素）换算成窗口的 DIP：页面缩放了两者就不等 */
function toBounds(win: BrowserWindow, rect: PreviewRect): Electron.Rectangle {
  const zoom = win.webContents.getZoomFactor()
  return {
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.max(0, Math.round(rect.width * zoom)),
    height: Math.max(0, Math.round(rect.height * zoom)),
  }
}

function validRect(rect: unknown): rect is PreviewRect {
  if (!rect || typeof rect !== "object") return false
  const r = rect as Record<string, unknown>
  return ["x", "y", "width", "height"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k] as number))
    && (r.width as number) > 0 && (r.height as number) > 0
}

/** 只认发请求的那个窗口自己的标签页 */
function tabOf(event: IpcMainEvent | IpcMainInvokeEvent, tabId: unknown): WebTab | undefined {
  const tab = typeof tabId === "string" ? tabs.get(tabId) : undefined
  return tab && BrowserWindow.fromWebContents(event.sender) === tab.win ? tab : undefined
}

export function initPreviewBrowser(): void {
  ipcMain.handle("preview-web:open", (event, tabId: string, url: string) => {
    if (typeof tabId !== "string" || !tabId) return { ok: false, error: "标签页无效" }
    if (!isHttpUrl(url)) return { ok: false, error: "只支持打开 http / https 网址" }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, error: "窗口不可用" }
    const tab = tabOf(event, tabId) ?? createTab(win, tabId)
    tab.requestedUrl = url
    tab.error = undefined
    // 加载结果由 did-fail-load 等事件推给界面，这里不等
    void tab.view.webContents.loadURL(url).catch(() => undefined)
    pushState(tab)
    return { ok: true }
  })

  ipcMain.handle("preview-web:nav", (event, tabId: string, action: PreviewWebNav) => {
    const tab = tabOf(event, tabId)
    if (!tab) return { ok: false }
    const wc = tab.view.webContents
    if (action === "back") wc.navigationHistory.goBack()
    else if (action === "forward") wc.navigationHistory.goForward()
    else if (action === "stop") wc.stop()
    else if (action === "reload") {
      // 第一次加载就失败的页面没有可刷新的历史，按最近请求的网址重新加载
      if (!wc.getURL() && tab.requestedUrl) void wc.loadURL(tab.requestedUrl).catch(() => undefined)
      else wc.reload()
    }
    return { ok: true }
  })

  // 界面只让一个标签页可见：给了 tabId 和位置就把它摆到那里，其余全部隐藏；tabId/位置为空就全部隐藏
  ipcMain.on("preview-web:bounds", (event, tabId: string | null, rect: PreviewRect | null) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const show = tabId !== null && validRect(rect)
    for (const tab of tabs.values()) {
      if (tab.win !== win) continue
      if (show && tab.id === tabId) {
        tab.view.setBounds(toBounds(win, rect))
        tab.view.setVisible(true)
      } else {
        tab.view.setVisible(false)
      }
    }
  })

  ipcMain.handle("preview-web:close", (event, tabId: string) => {
    const tab = tabOf(event, tabId)
    if (tab) destroyTab(tab)
    return { ok: true }
  })

  // 界面弹层要盖在网页区域上时，先拿一张截图顶在原处，再把原生视图藏起来
  ipcMain.handle("preview-web:snapshot", async (event, tabId: string) => {
    const tab = tabOf(event, tabId)
    if (!tab) return { ok: false as const }
    try {
      const image = await tab.view.webContents.capturePage()
      return { ok: true as const, dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}` }
    } catch {
      return { ok: false as const }
    }
  })

  ipcMain.handle("preview-web:clear-data", async () => {
    const ses = browserSession()
    await ses.clearStorageData()
    await ses.clearCache()
    return { ok: true }
  })

  ipcMain.handle("preview:open-external-url", async (_event, url: string) => {
    if (!isHttpUrl(url)) return { ok: false, error: "只支持用系统浏览器打开 http / https 网址" }
    await shell.openExternal(url)
    return { ok: true }
  })
}
