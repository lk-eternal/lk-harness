import { app, BrowserWindow, ipcMain, dialog, shell } from "electron"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { getConfig, saveConfig, migrateSecretsToSafeStorage, primaryWorkspaceForCli } from "./config-store"
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  getQueueMessages,
  deleteQueueMessage,
  checkCliInstalled,
  checkAgentLoggedIn,
  installCli,
  loginCli,
  clearMessageQueue,
  execAgentAsync,
  applyProxyEnv,
  bootstrapProxyEnv,
  initDaemonManager,
  shutdownDaemonManager,
  saveAppConfigFromRenderer,
  checkSdkApiKey,
  listSdkModels,
  noteGlobalSdkError,
} from "./daemon-manager"
import { parseListModelsStdout } from "./command-handler"
import {
  getMcpServerList,
  saveMcpServer,
  deleteMcpServer,
  loginMcpServer,
  toggleMcpServer,
  getMcpEnabledMap,
  getMcpServerTools,
  getMcpStatusMap,
  warmupMcpCache,
} from "./mcp-manager"
import { injectWorkspace } from "./workspace-injector"
import {
  listSkillRoots,
  listSkills,
  listSkillTree,
  resolveSkillDir,
  resolveSkillFile,
  resolveRootAbs,
} from "./skill-store"
import {
  listHarnessRules,
  saveHarnessRule,
  deleteHarnessRule,
  migrateLegacyRulesOnce,
} from "./harness-rule-store"
import { initTray, destroyTray } from "./tray"
import { initAppUpdater } from "./updater"
import { initToolbox } from "./toolbox"
import { broadcastLog } from "./ui-logger"

const profileArg = process.argv.find((a) => a.startsWith("--profile="))
const profileName = profileArg?.split("=")[1] || ""
if (profileName) {
  const baseDir = path.dirname(app.getPath("userData"))
  app.setPath("userData", path.join(baseDir, `lk-harness-${profileName}`))
}

// NODE_USE_ENV_PROXY 必须在 Node 发出首个请求前就在环境里（initDaemonManager 里再赋已晚）。
// 这里只管提前注入；后续代理变更仍走 syncMainProcessProxyEnv。
bootstrapProxyEnv()

let mainWindow: BrowserWindow | null = null
let closeConfirmDialogOpen = false

function installWindowCloseHandler(win: BrowserWindow): void {
  win.on("close", (e) => {
    if (isQuitting) {
      return
    }

    const pref = getConfig().closeWindowAction

    if (pref === "minimize") {
      e.preventDefault()
      win.hide()
      return
    }

    if (pref === "quit") {
      isQuitting = true
      return
    }

    e.preventDefault()
    if (closeConfirmDialogOpen) {
      return
    }
    closeConfirmDialogOpen = true
    win.webContents.send("window:close-confirm")
  })
}

function resolveIcon(): string {
  const dir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources")
  if (process.platform === "win32") {
    const ico = path.join(dir, "icon.ico")
    if (fs.existsSync(ico)) return ico
  }
  return path.join(dir, "icon.png")
}

/** 同步开机自启系统设置到配置值（开发模式跳过，避免把 electron.exe 注册为自启） */
function applyLoginItemSetting(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: profileName ? [`--profile=${profileName}`] : [],
    })
  } catch (e) {
    console.error("[main] 设置开机自启失败:", e)
  }
}

function createWindow(): void {
  const iconPath = resolveIcon()

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    title: profileName ? `LK Harness [${profileName}]` : "LK Harness",
    icon: iconPath,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show()
  })

  installWindowCloseHandler(mainWindow)

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized-change", true))
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximized-change", false))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[main] did-fail-load:", code, desc)
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle("window:minimize", () => mainWindow?.minimize())
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.handle("window:close", () => mainWindow?.close())
  ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle("config:get", () => getConfig())
  ipcMain.handle("config:save", (_, config) => saveAppConfigFromRenderer(config))
  ipcMain.handle("app:set-auto-start", (_, enabled: boolean) => {
    saveConfig({ autoStart: enabled })
    applyLoginItemSetting(enabled)
    return { ok: true }
  })

  ipcMain.handle(
    "window:close-confirm-result",
    (_, payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }) => {
      const win = mainWindow
      closeConfirmDialogOpen = false
      if (!win || win.isDestroyed()) {
        return
      }
      if (payload.action === "cancel") {
        return
      }
      if (payload.remember) {
        saveConfig({
          closeWindowAction: payload.action === "minimize" ? "minimize" : "quit",
        })
      }
      if (payload.action === "minimize") {
        win.hide()
        return
      }
      isQuitting = true
      win.close()
    },
  )

  ipcMain.handle("dialog:selectDirectory", async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "选择工作目录",
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle("workspace:inject", () => injectWorkspace())
  ipcMain.handle("daemon:start", () => startDaemon())
  ipcMain.handle("daemon:stop", () => stopDaemon())
  ipcMain.handle("daemon:status", () => getDaemonStatus())
  ipcMain.handle("daemon:queue", () => getQueueMessages())
  ipcMain.handle("daemon:queue-delete", (_e, fileId: string) => deleteQueueMessage(fileId))
  ipcMain.handle("daemon:queue-clear", () => clearMessageQueue())
  ipcMain.handle("cli:check", () => checkCliInstalled())
  ipcMain.handle("cli:login-status", (_, opts?: { forceRefresh?: boolean }) => checkAgentLoggedIn(opts))
  ipcMain.handle("cli:install", () => installCli())
  ipcMain.handle("cli:login", () => loginCli())
  ipcMain.handle("mcp:list-all", () => getMcpServerList())
  ipcMain.handle("mcp:save", (_, name: string, entry: Record<string, unknown>) => saveMcpServer(name, entry))
  ipcMain.handle("mcp:delete", (_, name: string) => {
    const server = getMcpServerList().find((s) => s.name === name)
    if (!server) return { ok: false, error: "MCP 服务器不存在" }
    return deleteMcpServer(name)
  })
  ipcMain.handle("mcp:login", (_, name: string) => loginMcpServer(name))
  ipcMain.handle("mcp:toggle", (_, name: string, enabled: boolean) => toggleMcpServer(name, enabled))
  ipcMain.handle("mcp:enabled-map", (_, force?: boolean) => getMcpEnabledMap(force ?? false))
  ipcMain.handle("mcp:status-map", (_, force?: boolean) => getMcpStatusMap(force ?? false))
  ipcMain.handle("mcp:tools", (_, name: string, force?: boolean) => getMcpServerTools(name, force ?? false))

  migrateLegacyRulesOnce()
  ipcMain.handle("claw-rules:list", () => listHarnessRules())
  ipcMain.handle("claw-rules:save", (_, id: string | null, name: string, content: string, enabled?: boolean) => {
    const rule = saveHarnessRule(id, name, content, enabled ?? true)
    return { ok: !!rule, rule }
  })
  ipcMain.handle("claw-rules:delete", (_, id: string) => ({
    ok: deleteHarnessRule(String(id)),
  }))
  ipcMain.handle("harness-rules:list", () => listHarnessRules())
  ipcMain.handle("harness-rules:save", (_, id: string | null, name: string, content: string, enabled?: boolean) => {
    const rule = saveHarnessRule(id, name, content, enabled ?? true)
    return { ok: !!rule, rule }
  })
  ipcMain.handle("harness-rules:delete", (_, id: string) => ({
    ok: deleteHarnessRule(String(id)),
  }))

  ipcMain.handle("skills:roots", () => listSkillRoots())

  ipcMain.handle("skills:list", (_, rootId = "cursor") => {
    return listSkills(String(rootId)).map((s) => ({
      rootId: s.rootId,
      skillPath: s.skillPath,
      name: s.skillPath,
      content: s.content,
    }))
  })

  ipcMain.handle("skills:tree", (_, rootId = "cursor") => listSkillTree(String(rootId)))

  ipcMain.handle("skills:read-file", (_, rootId: string, skillPath: string, relativePath: string) => {
    const filePath = resolveSkillFile(String(rootId), skillPath, relativePath)
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "文件不存在" }
    return { ok: true, content: fs.readFileSync(filePath, "utf-8") }
  })

  ipcMain.handle("skills:save-file", (_, rootId: string, skillPath: string, relativePath: string, content: string) => {
    const filePath = resolveSkillFile(String(rootId), skillPath, relativePath)
    if (!filePath) return { ok: false, error: "路径无效" }
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, content, "utf-8")
    return { ok: true }
  })

  ipcMain.handle("skills:create-dir", (_, rootId: string, skillPath: string, relativePath: string) => {
    const skillDir = resolveSkillDir(String(rootId), skillPath)
    if (!skillDir) return { ok: false, error: "路径无效" }
    const dirPath = path.resolve(skillDir, relativePath)
    if (!dirPath.startsWith(path.resolve(skillDir))) return { ok: false, error: "路径无效" }
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
    return { ok: true }
  })

  ipcMain.handle("skills:delete-file", (_, rootId: string, skillPath: string, relativePath: string) => {
    const skillDir = resolveSkillDir(String(rootId), skillPath)
    if (!skillDir) return { ok: false, error: "路径无效" }
    const filePath = path.resolve(skillDir, relativePath)
    if (!filePath.startsWith(path.resolve(skillDir))) return { ok: false, error: "路径无效" }
    if (!fs.existsSync(filePath)) return { ok: false, error: "文件不存在" }
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true })
    else fs.unlinkSync(filePath)
    return { ok: true }
  })

  ipcMain.handle("skills:save", (_, rootId: string, skillPath: string, content: string) => {
    const dir = resolveSkillDir(String(rootId), skillPath)
    if (!dir) return { ok: false, error: "路径无效" }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8")
    return { ok: true }
  })

  ipcMain.handle("skills:rename", (_, rootId: string, oldPath: string, newPath: string) => {
    const rootAbs = resolveRootAbs(String(rootId))
    const oldDir = resolveSkillDir(String(rootId), oldPath)
    if (!rootAbs || !oldDir || !fs.existsSync(oldDir)) return { ok: false, error: "原目录不存在" }
    const newDir = path.resolve(rootAbs, newPath.replace(/\//g, path.sep))
    if (!newDir.startsWith(path.resolve(rootAbs))) return { ok: false, error: "路径无效" }
    if (fs.existsSync(newDir)) return { ok: false, error: "目标目录已存在" }
    fs.renameSync(oldDir, newDir)
    return { ok: true }
  })

  ipcMain.handle("skills:delete", (_, rootId: string, skillPath: string) => {
    const dir = resolveSkillDir(String(rootId), skillPath)
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  })

  ipcMain.handle("models:list", async () => {
    const config = getConfig()
    const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_USE_ENV_PROXY: "1" }
    applyProxyEnv(env, config)
    const ws = primaryWorkspaceForCli()
    const run = await execAgentAsync(["--list-models"], env, { timeoutMs: 30_000, logLabel: "list-models", cwd: ws })
    if (!run.ok) {
      return { ok: false, models: [], error: run.error || run.stderr.trim() || "获取模型列表失败" }
    }
    return { ok: true, models: parseListModelsStdout(run.stdout) }
  })

  ipcMain.handle("sdk:check-api-key", (_, apiKey: string) => checkSdkApiKey(apiKey))
  ipcMain.handle("sdk:list-models", (_, apiKey: string, currentModel?: string, currentParams?: string) => listSdkModels(apiKey, currentModel, currentParams))
  ipcMain.handle("llm:verify-resource", (_, resource) => import("./agent-llm").then((m) => m.verifyLlmResource(resource)))
}

let isQuitting = false

function requestGracefulQuit(): void {
  isQuitting = true
  const win = mainWindow
  if (win && !win.isDestroyed()) {
    win.close()
  } else {
    app.quit()
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.some((a) => a === "--graceful-quit")) {
      requestGracefulQuit()
      return
    }
    const win = mainWindow
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

// 第三方 SDK（如 @cursor/sdk）深处的异步 socket 错误无法在调用点捕获，
// 全局兜底记日志，避免 Electron 默认弹出 "JavaScript error in main process" 并中断运行
// 网络类抖动（代理/NAT 掐掉闲置长连接等）降为 WARN：会话层已有 Resume 自愈机制
const NETWORK_NOISE_RE = /WRONG_VERSION_NUMBER|SSL routines|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|fetch failed|GOAWAY|socket disconnected|secure TLS connection|stream closed with error code/i

function logGlobalError(kind: string, raw: unknown): void {
  const msg = raw instanceof Error ? raw.message : String(raw)
  try {
    // 网络噪声只入缓冲：真正 run 失败时合并到「运行失败」那一行，UI 不再单独刷
    noteGlobalSdkError(msg)
    if (NETWORK_NOISE_RE.test(msg)) return
    broadcastLog(`[Main] ${kind}: ${msg}`, "ERROR")
  } catch { console.error(`[Main] ${kind}:`, raw) }
}

process.on("uncaughtException", (err) => logGlobalError("未捕获异常", err))
process.on("unhandledRejection", (reason) => logGlobalError("未处理的 Promise 拒绝", reason))

let quitCleanupDone = false

app.on("before-quit", (e) => {
  isQuitting = true
  if (quitCleanupDone) return
  // 拦截首次退出：等 SDK run 取消落库再放行，否则会残留 active run 导致下次 Resume 卡死
  e.preventDefault()
  quitCleanupDone = true
  const forceExit = setTimeout(() => app.exit(0), 18_000)
  void shutdownDaemonManager().finally(() => {
    clearTimeout(forceExit)
    app.quit()
  })
})

app.whenReady().then(() => {
  migrateSecretsToSafeStorage()
  registerIpcHandlers()
  applyLoginItemSetting(getConfig().autoStart)
  createWindow()
  initAppUpdater(() => mainWindow)
  initTray()
  initDaemonManager()
  warmupMcpCache()
  initToolbox()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    mainWindow?.show()
  }
})

app.on("will-quit", () => {
  destroyTray()
})
