import { Tray, Menu, nativeImage, app, BrowserWindow } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"

let tray: Tray | null = null

/**
 * 安装包把 icon.png 放在 process.resourcesPath；开发时 app.getAppPath() 多为项目根，
 * 若不存在则回退到相对于主进程 out/main 的 ../../resources（与 BrowserWindow icon 一致）。
 */
function resolveResourcesDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath
  }
  const fromApp = path.join(app.getAppPath(), "resources")
  if (fs.existsSync(path.join(fromApp, "icon.png"))) {
    return fromApp
  }
  const fromMain = path.join(__dirname, "..", "..", "resources")
  if (fs.existsSync(path.join(fromMain, "icon.png"))) {
    return fromMain
  }
  return fromApp
}

function getIconPath(): string {
  const dir = resolveResourcesDir()
  if (process.platform === "win32") {
    const ico = path.join(dir, "icon.ico")
    if (fs.existsSync(ico)) {
      return ico
    }
  }
  return path.join(dir, "icon.png")
}

function getIcon(): Electron.NativeImage {
  try {
    const iconPath = getIconPath()
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      console.error(`[tray] 无法加载托盘图标: ${iconPath}`)
      return nativeImage.createFromBuffer(Buffer.alloc(0))
    }
    return icon.resize({ width: 16, height: 16 })
  } catch (e) {
    console.error("[tray] 托盘图标异常:", e)
    return nativeImage.createFromBuffer(Buffer.alloc(0))
  }
}

function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    const win = windows[0]
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

export function initTray(): void {
  tray = new Tray(getIcon())
  tray.setToolTip("LK Harness")

  const contextMenu = Menu.buildFromTemplate([
    { label: "显示窗口", click: showMainWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on("double-click", showMainWindow)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

export function updateTrayTooltip(text: string): void {
  if (tray) {
    tray.setToolTip(text)
  }
}
