/**
 * Windows 静默更新在 electron/updater.ts 里的接线测试。
 *
 * updater.ts 依赖 electron 和 electron-updater，这里用假的把整条链路演一遍：
 * 启动 / 定时检查 → 查版本 → 下载 → 下载完成 → 立即安装 / 退出时安装。
 * 关注的是三件事：开着时不弹任何窗口、失败不卡死下个周期、关着时行为和以前一样。
 * 假的 electron-updater 不会真的装东西，「退出时静默安装」是否生效只看 autoInstallOnAppQuit 开关
 * （electron-updater 在下载完成时按这个开关登记退出处理，见 BaseUpdater），真正的安装器没有在这里跑。
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events")

  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getVersion: () => "1.4.1",
    getName: () => "lk-test",
    getPath: (_name: string): string => "",
    getAppPath: () => "",
    quit: () => {},
  })

  const ipc = new Map<string, (...args: unknown[]) => unknown>()

  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    getOrCreateDownloadHelper: async () => ({ cacheDirForPendingUpdate: "pending-dir" }),
  })

  const win = {
    isDestroyed: () => false,
    isVisible: () => s.winVisible,
    isMinimized: () => s.winMinimized,
    webContents: { send: vi.fn() },
  }

  const s = {
    config: {} as Record<string, unknown>,
    /** 远端最新版本；null = 版本源全部不通 */
    remoteVersion: null as string | null,
    /** checkForUpdates 的行为 */
    checkMode: "available" as "available" | "none" | "throw" | "noop",
    /** 调用 downloadUpdate 那一刻的 autoInstallOnAppQuit（electron-updater 在下载完成时按它登记退出处理） */
    flagAtDownload: null as boolean | null,
    /**
     * 下载完成后 electron-updater 是否登记了「退出时安装」。
     * 它的顺序是先 emit update-downloaded，再看 autoInstallOnAppQuit 决定登记（BaseUpdater.executeDownload），这里照样模拟
     */
    quitHandlerRegistered: null as boolean | null,
    /** 主窗口此刻的状态：收在托盘里（不可见）、最小化 */
    winVisible: true,
    winMinimized: false,
  }

  return {
    app,
    ipc,
    updater,
    win,
    s,
    prefetchInstaller: vi.fn(),
    broadcastLog: vi.fn(),
    netFetch: vi.fn(),
    showMessageBox: vi.fn(),
    openExternal: vi.fn(),
  }
})

vi.mock("electron", () => ({
  app: h.app,
  BrowserWindow: class {},
  dialog: { showMessageBox: h.showMessageBox },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.ipc.set(channel, fn) },
  shell: { openExternal: h.openExternal },
  net: { fetch: h.netFetch },
  session: {
    defaultSession: { setProxy: async () => {} },
    fromPartition: () => ({ setProxy: async () => {} }),
  },
}))
vi.mock("electron-updater", () => ({ default: { autoUpdater: h.updater } }))
vi.mock("../electron/config-store", () => ({ getConfig: () => h.s.config }))
vi.mock("../electron/agent-env", () => ({ syncMainProcessProxyEnv: () => {} }))
vi.mock("../electron/ui-logger", () => ({ broadcastLog: h.broadcastLog }))
vi.mock("../electron/update-prefetch", () => ({
  pickWindowsInstaller: () => ({ url: "https://example.invalid/setup.exe", fileName: "setup.exe" }),
  prefetchInstaller: h.prefetchInstaller,
  createRotatingFetch: () => ({ fetch: vi.fn(), rotate: vi.fn() }),
  formatRetryNotice: () => "",
}))

const SIX_HOURS = 6 * 60 * 60 * 1000
const realPlatform = process.platform
let tmpRoot = ""

/** 真正等所有 Promise 链跑完（假定时器不影响 setImmediate） */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

function jsonResponse(status: number, body: unknown): { status: number; text: () => Promise<string> } {
  return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }
}

function sent(channel: string): unknown[][] {
  return h.win.webContents.send.mock.calls.filter((c) => c[0] === channel).map((c) => c.slice(1))
}

function modalTitles(): string[] {
  return sent("app:modal-request").map((args) => (args[0] as { title: string }).title)
}

function logs(): string[] {
  return h.broadcastLog.mock.calls.map((c) => String(c[0]))
}

function logsAt(level: string): string[] {
  return h.broadcastLog.mock.calls.filter((c) => c[1] === level).map((c) => String(c[0]))
}

type UpdaterModule = typeof import("../electron/updater")
type IdleRestartProbes = import("../electron/updater").IdleRestartProbes

/** 每个用例拿一份全新的 updater.ts（它有模块级状态），再按给定配置启动 */
async function boot(
  config: Record<string, unknown>,
  remoteVersion: string | null = "1.4.2",
  probes?: IdleRestartProbes,
): Promise<UpdaterModule> {
  h.s.config = config
  h.s.remoteVersion = remoteVersion
  vi.resetModules()
  const mod = await import("../electron/updater")
  mod.initAppUpdater(() => h.win as never, probes)
  return mod
}

async function runStartup(): Promise<void> {
  await vi.advanceTimersByTimeAsync(4_000)
  await settle()
}

async function runPeriodic(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SIX_HOURS)
  await settle()
}

/** 像界面那样回应第 index 个弹窗（response 是按钮下标） */
async function answerModal(index: number, response: number): Promise<void> {
  const req = sent("app:modal-request")[index][0] as { requestId: string }
  const handler = h.ipc.get("app:modal-result")
  if (!handler) throw new Error("没有注册 app:modal-result")
  await handler({}, { requestId: req.requestId, response })
  await settle()
}

function invoke<T>(channel: string): Promise<T> {
  const fn = h.ipc.get(channel)
  if (!fn) throw new Error(`没有注册 ${channel}`)
  return Promise.resolve(fn({}) as T)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] })
  setPlatform("win32")
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lk-updater-silent-"))
  h.app.isPackaged = true
  h.app.getPath = () => path.join(tmpRoot, "userData")
  ;(process as unknown as { resourcesPath: string }).resourcesPath = tmpRoot

  h.app.removeAllListeners()
  h.updater.removeAllListeners()
  h.ipc.clear()
  h.updater.autoDownload = true
  h.updater.autoInstallOnAppQuit = true
  for (const fn of [
    h.updater.checkForUpdates,
    h.updater.downloadUpdate,
    h.updater.quitAndInstall,
    h.win.webContents.send,
    h.prefetchInstaller,
    h.broadcastLog,
    h.netFetch,
    h.showMessageBox,
    h.openExternal,
  ]) {
    fn.mockReset()
  }

  h.s.checkMode = "available"
  h.s.flagAtDownload = null
  h.s.quitHandlerRegistered = null
  h.s.winVisible = true
  h.s.winMinimized = false
  h.updater.checkForUpdates.mockImplementation(async () => {
    if (h.s.checkMode === "noop") {
      return null
    }
    if (h.s.checkMode === "none") {
      h.updater.emit("update-not-available", {})
      return null
    }
    if (h.s.checkMode === "throw") {
      throw new Error("check boom")
    }
    h.updater.emit("update-available", { version: h.s.remoteVersion, files: [] })
    return {}
  })
  h.updater.downloadUpdate.mockImplementation(async () => {
    h.s.flagAtDownload = h.updater.autoInstallOnAppQuit
    h.updater.emit("update-downloaded", { version: h.s.remoteVersion })
    h.s.quitHandlerRegistered = h.updater.autoInstallOnAppQuit
    return []
  })
  h.prefetchInstaller.mockResolvedValue({ reusedExisting: false, attempts: 1 })
  h.showMessageBox.mockResolvedValue({ response: 0 })
  h.netFetch.mockImplementation(async (url: string) => {
    if (h.s.remoteVersion && url.endsWith("/releases/latest")) {
      return jsonResponse(200, {
        tag_name: `v${h.s.remoteVersion}`,
        html_url: `https://github.com/x/y/releases/tag/v${h.s.remoteVersion}`,
        body: "修复若干问题",
        assets: [{ name: "setup.exe" }],
      })
    }
    return jsonResponse(404, "")
  })
})

afterEach(() => {
  vi.useRealTimers()
  setPlatform(realPlatform)
  delete (process as unknown as { resourcesPath?: string }).resourcesPath
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("静默更新开着（Windows 安装版）", () => {
  it("启动后台下载：不弹任何窗口，下载完成时「退出时安装」开关是开的", async () => {
    await boot({ silentUpdate: true })
    await runStartup()

    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(h.updater.autoInstallOnAppQuit).toBe(true)
    // 开始下载那一刻开关就得是开的，不能等下载完再开
    expect(h.s.flagAtDownload).toBe(true)
    expect(h.s.quitHandlerRegistered).toBe(true)
    // 一个窗口都不能弹：不管是页面里的弹窗还是系统对话框
    expect(sent("app:modal-request")).toEqual([])
    expect(h.showMessageBox).not.toHaveBeenCalled()
    // 界面收到的是带 silent 标记的「已下载」
    expect(sent("updater:status")).toContainEqual([{ kind: "downloaded", version: "1.4.2", silent: true, idleRestart: true }])
    expect(logs().some((l) => l.includes("静默更新") && l.includes("已下载好"))).toBe(true)
  })

  it("查版本发现新版本时写日志（没有界面，只能靠日志排查）", async () => {
    await boot({ silentUpdate: true })
    await runStartup()
    expect(logs().some((l) => l.includes("发现新版本 v1.4.2") && l.includes("当前 v1.4.1"))).toBe(true)
  })

  it("远端和本机同版本：不检查、不下载、不弹窗", async () => {
    await boot({ silentUpdate: true }, "1.4.1")
    await runStartup()
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(h.prefetchInstaller).not.toHaveBeenCalled()
    expect(sent("app:modal-request")).toEqual([])
  })

  it("版本源全不通：只写警告日志，不弹窗；下个周期通了就接着更新", async () => {
    await boot({ silentUpdate: true }, null)
    await runStartup()
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(sent("app:modal-request")).toEqual([])
    expect(logsAt("WARN").some((l) => l.includes("查不到最新版本"))).toBe(true)

    h.s.remoteVersion = "1.4.2"
    await runPeriodic()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("下载失败：不弹「自动更新失败」，只写警告日志；下个周期自动重试并成功", async () => {
    h.prefetchInstaller.mockRejectedValueOnce(new Error("connection reset"))
    await boot({ silentUpdate: true })
    await runStartup()

    expect(h.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(sent("app:modal-request")).toEqual([])
    expect(h.showMessageBox).not.toHaveBeenCalled()
    expect(logsAt("WARN").some((l) => l.includes("下载失败") && l.includes("connection reset"))).toBe(true)

    // 失败后标记都清干净了，下个周期能重新来一轮
    await runPeriodic()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(2)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(sent("app:modal-request")).toEqual([])
  })

  it("checkForUpdates 抛错：只写日志不弹窗，标记清掉，下个周期还能再来", async () => {
    h.s.checkMode = "throw"
    await boot({ silentUpdate: true })
    await runStartup()
    expect(sent("app:modal-request")).toEqual([])
    expect(h.showMessageBox).not.toHaveBeenCalled()
    expect(logsAt("WARN").some((l) => l.includes("check boom"))).toBe(true)

    h.s.checkMode = "available"
    await runPeriodic()
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("updater 说「没有更新」（和 GitHub API 不一致）：不弹窗，标记清掉", async () => {
    h.s.checkMode = "none"
    await boot({ silentUpdate: true })
    await runStartup()
    expect(sent("app:modal-request")).toEqual([])
    expect(logsAt("WARN").some((l) => l.includes("未找到可用更新"))).toBe(true)

    h.s.checkMode = "available"
    await runPeriodic()
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("checkForUpdates 一个事件都没发：这一轮作废并写日志，不会挡住以后的周期", async () => {
    h.s.checkMode = "noop"
    await boot({ silentUpdate: true })
    await runStartup()
    expect(sent("app:modal-request")).toEqual([])
    expect(logsAt("WARN").some((l) => l.includes("没有返回结果"))).toBe(true)

    h.s.checkMode = "available"
    await runPeriodic()
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("定时检查：启动时没有更新，常驻几小时后发了新版本也能后台下好", async () => {
    await boot({ silentUpdate: true }, "1.4.1")
    await runStartup()
    expect(h.prefetchInstaller).not.toHaveBeenCalled()

    h.s.remoteVersion = "1.4.2"
    await runPeriodic()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("已经下好这个版本：后面的周期不再重复下载", async () => {
    await boot({ silentUpdate: true })
    await runStartup()
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)

    await runPeriodic()
    await runPeriodic()
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
  })

  it("远端又发了更新的版本：已下好的旧版本不挡着，会下新的", async () => {
    await boot({ silentUpdate: true })
    await runStartup()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)

    h.s.remoteVersion = "1.4.3"
    await runPeriodic()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(2)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it("下载还没完成时又到了下个周期：不会起第二路下载", async () => {
    let finishPrefetch: () => void = () => {}
    h.prefetchInstaller.mockImplementation(
      () => new Promise((resolve) => {
        finishPrefetch = () => resolve({ reusedExisting: false, attempts: 1 })
      }),
    )
    await boot({ silentUpdate: true })
    await runStartup()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)

    await runPeriodic()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1)

    finishPrefetch()
    await settle()
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("下载进行中把开关关了：下载完成时不登记「退出时安装」，并回到原来的更新就绪提示", async () => {
    let finishPrefetch: () => void = () => {}
    h.prefetchInstaller.mockImplementation(
      () => new Promise((resolve) => {
        finishPrefetch = () => resolve({ reusedExisting: false, attempts: 1 })
      }),
    )
    await boot({ silentUpdate: true })
    await runStartup()
    expect(h.updater.autoInstallOnAppQuit).toBe(true)

    h.s.config = { silentUpdate: false }
    finishPrefetch()
    await settle()

    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(h.s.quitHandlerRegistered).toBe(false)
    expect(modalTitles()).toEqual(["更新已就绪"])
  })

  it("用户手动下载的过程中才打开开关：下载完成时登记「退出时安装」，且不弹窗", async () => {
    let finishPrefetch: () => void = () => {}
    h.prefetchInstaller.mockImplementation(
      () => new Promise((resolve) => {
        finishPrefetch = () => resolve({ reusedExisting: false, attempts: 1 })
      }),
    )
    await boot({})
    await runStartup()
    await answerModal(0, 1) // 开关还关着时，用户点了「下载并安装」
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
    expect(h.updater.autoInstallOnAppQuit).toBe(false)

    h.s.config = { silentUpdate: true }
    finishPrefetch()
    await settle()

    expect(h.s.quitHandlerRegistered).toBe(true)
    expect(modalTitles()).toEqual(["发现新版本"])
  })

  it("退出前把开关在设置里关了：退出时不会自动安装", async () => {
    await boot({ silentUpdate: true })
    await runStartup()
    expect(h.updater.autoInstallOnAppQuit).toBe(true)

    h.s.config = { silentUpdate: false }
    h.app.emit("before-quit")
    expect(h.updater.autoInstallOnAppQuit).toBe(false)
  })

  it("退出时开关还开着：保持「退出时安装」", async () => {
    await boot({ silentUpdate: true })
    await runStartup()
    h.app.emit("before-quit")
    expect(h.updater.autoInstallOnAppQuit).toBe(true)
  })

  it("下好之后「立即安装」：静默装并重启，不再弹窗", async () => {
    await boot({ silentUpdate: true })
    await runStartup()

    const res = await invoke<{ ok: boolean; message?: string }>("updater:apply")
    expect(res.ok).toBe(true)
    expect(res.message).toContain("静默安装")
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    // isSilent=true, isForceRunAfter=true
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(sent("app:modal-request")).toEqual([])
  })

  it("设置页检查更新：已下好的版本显示 ready，不再触发新的下载", async () => {
    await boot({ silentUpdate: true })
    await runStartup()

    const res = await invoke<{ status: string; latestVersion?: string }>("updater:check")
    expect(res.status).toBe("ready")
    expect(res.latestVersion).toBe("1.4.2")
    await settle()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
  })

  it("设置页检查更新发现新版本：自动在后台开始下载，不弹窗", async () => {
    // 先不让启动那轮下载，模拟「开了开关之后马上点检查更新」
    await boot({ silentUpdate: false })
    await runStartup()
    h.updater.checkForUpdates.mockClear()
    h.showMessageBox.mockClear()
    h.win.webContents.send.mockClear()

    h.s.config = { silentUpdate: true }
    const res = await invoke<{ status: string }>("updater:check")
    expect(res.status).toBe("available")
    await settle()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(sent("app:modal-request")).toEqual([])
  })

  it("后台还在下载时点「更新」：提示正在后台下载，不另起一路", async () => {
    h.prefetchInstaller.mockImplementation(() => new Promise(() => {}))
    await boot({ silentUpdate: true })
    await runStartup()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(1)

    const res = await invoke<{ ok: boolean; message?: string }>("updater:apply")
    expect(res.ok).toBe(true)
    expect(res.message).toContain("后台下载")
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("静默更新开着时，「启动时自动提示升级」不再生效（不弹更新就绪窗口）", async () => {
    await boot({ silentUpdate: true, autoUpgradePrompt: true })
    await runStartup()
    expect(modalTitles()).not.toContain("发现新版本")
    expect(modalTitles()).not.toContain("更新已就绪")
  })
})

describe("静默更新关着（默认）：行为和以前一样", () => {
  it("启动：弹「发现新版本」问用户，不自己下载，也不登记退出时安装", async () => {
    await boot({})
    await runStartup()

    expect(modalTitles()).toEqual(["发现新版本"])
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(h.prefetchInstaller).not.toHaveBeenCalled()
    expect(h.updater.autoInstallOnAppQuit).toBe(false)
  })

  it("用户点「下载并安装」后下载；下好了弹「更新已就绪」，且 autoInstallOnAppQuit 保持关闭", async () => {
    await boot({})
    await runStartup()

    await answerModal(0, 1)

    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(h.updater.autoInstallOnAppQuit).toBe(false)
    expect(modalTitles()).toEqual(["发现新版本", "更新已就绪"])
    expect(sent("updater:status")).toContainEqual([{ kind: "downloaded", version: "1.4.2", silent: false, idleRestart: false }])
  })

  it("用户发起的下载失败：弹「自动更新失败」（静默更新才只写日志）", async () => {
    h.prefetchInstaller.mockRejectedValue(new Error("connection reset"))
    await boot({})
    await runStartup()
    // 弹窗是串行队列：先把启动时的「发现新版本」点「稍后」，后面的弹窗才轮得到
    await answerModal(0, 0)

    const res = await invoke<{ ok: boolean }>("updater:apply")
    expect(res.ok).toBe(true)
    await settle()

    expect(modalTitles()).toContain("自动更新失败")
    expect(logs().some((l) => l.includes("静默更新"))).toBe(false)
  })

  it("定时器什么都不做：没开静默更新时不会偷偷检查或下载", async () => {
    await boot({}, "1.4.1")
    await runStartup()
    h.netFetch.mockClear()
    await runPeriodic()
    await runPeriodic()
    expect(h.netFetch).not.toHaveBeenCalled()
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it("关掉「启动时自动提示升级」：启动只记录版本，不弹窗不下载", async () => {
    await boot({ autoUpgradePrompt: false })
    await runStartup()
    expect(sent("app:modal-request")).toEqual([])
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe("只对 Windows 安装版生效", () => {
  it("macOS 上配置里有 silentUpdate 也不生效：走原来的「发现新版本」弹窗", async () => {
    setPlatform("darwin")
    await boot({ silentUpdate: true })
    await runStartup()

    expect(modalTitles()).toEqual(["发现新版本"])
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(h.prefetchInstaller).not.toHaveBeenCalled()
    expect(h.updater.autoInstallOnAppQuit).toBe(false)
  })

  it("Linux 上同样不生效", async () => {
    setPlatform("linux")
    await boot({ silentUpdate: true })
    await runStartup()

    expect(modalTitles()).toEqual(["发现新版本"])
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it("未打包（开发版）不生效，也不会注册定时检查", async () => {
    h.app.isPackaged = false
    await boot({ silentUpdate: true })
    await runStartup()
    await runPeriodic()
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(h.netFetch).not.toHaveBeenCalled()
  })
})

// ── 空闲时自动重启安装 ───────────────────────────────────────────────

const MINUTE = 60 * 1000

/** 一个全部条件都满足的现场：电脑空闲 20 分钟、Agent 安静 30 分钟、没有排队的消息、确认是仅当前用户安装 */
function makeProbes(over: Partial<IdleRestartProbes> = {}) {
  const base = {
    userIdleSeconds: vi.fn((): number | null => 20 * 60),
    agentWorkInFlight: vi.fn(() => false),
    agentQuietMs: vi.fn(() => 30 * MINUTE),
    queuedMessages: vi.fn(async (): Promise<number | null> => 0),
    perUserInstall: vi.fn(async () => true),
    beforeRestart: vi.fn(),
    cancelRestart: vi.fn(),
  }
  return { ...base, ...over } as typeof base
}

/** 推进若干分钟（空闲检查每分钟一次） */
async function runIdleTicks(minutes = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(minutes * MINUTE)
  await settle()
}

/** 启动 → 后台下载好新版本 1.4.2，停在「等着安装」 */
async function bootWithReadyUpdate(config: Record<string, unknown>, probes: IdleRestartProbes | undefined): Promise<void> {
  await boot(config, "1.4.2", probes)
  await runStartup()
  expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
}

describe("空闲时自动重启安装（静默更新开着、新版本已下载好）", () => {
  it("电脑空闲、AI 没在工作：自动静默安装并重启，不弹任何窗口", async () => {
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    await runIdleTicks()

    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    // isSilent=true（不出安装向导）、isForceRunAfter=true（装完自己起来）
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(h.updater.autoInstallOnAppQuit).toBe(true)
    expect(logs().some((l) => l.includes("自动重启安装 v1.4.2"))).toBe(true)
    expect(sent("app:modal-request")).toEqual([])
    expect(h.showMessageBox).not.toHaveBeenCalled()
  })

  it("窗口开着时重启：记下「窗口原本不在托盘」，装完照常弹出来", async () => {
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks()
    expect(probes.beforeRestart).toHaveBeenCalledWith({ keepHidden: false })
    // 记号要在退出之前写好
    expect(probes.beforeRestart.mock.invocationCallOrder[0]).toBeLessThan(h.updater.quitAndInstall.mock.invocationCallOrder[0])
  })

  it("窗口收在托盘里（隐藏）时重启：记下 keepHidden，装完留在托盘", async () => {
    h.s.winVisible = false
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks()
    expect(probes.beforeRestart).toHaveBeenCalledWith({ keepHidden: true })
    expect(logs().some((l) => l.includes("装完仍留在托盘"))).toBe(true)
  })

  it("窗口最小化时重启：同样留在托盘", async () => {
    h.s.winMinimized = true
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks()
    expect(probes.beforeRestart).toHaveBeenCalledWith({ keepHidden: true })
  })

  it("电脑最近有人在操作：不重启，也不去问 daemon 和注册表；人走开满 15 分钟后下一分钟就重启", async () => {
    const probes = makeProbes({ userIdleSeconds: vi.fn((): number | null => 120) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    await runIdleTicks(5)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    // 便宜的条件都没过，不该花力气去问慢的
    expect(probes.queuedMessages).not.toHaveBeenCalled()
    expect(probes.perUserInstall).not.toHaveBeenCalled()

    probes.userIdleSeconds.mockReturnValue(15 * 60)
    await runIdleTicks()
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["有 Agent 在跑回合", { agentWorkInFlight: vi.fn(() => true) }],
    ["Agent 刚刚还在工作（回合之间的空档）", { agentQuietMs: vi.fn(() => 2 * MINUTE) }],
    ["队列里有排队或处理中的消息", { queuedMessages: vi.fn(async (): Promise<number | null> => 3) }],
    ["队列数取不到", { queuedMessages: vi.fn(async (): Promise<number | null> => null) }],
    ["电脑空闲时间取不到", { userIdleSeconds: vi.fn((): number | null => null) }],
  ] as const)("%s：不重启", async (_name, over) => {
    const probes = makeProbes(over as Partial<IdleRestartProbes>)
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks(5)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(probes.beforeRestart).not.toHaveBeenCalled()
  })

  it.each([
    ["电脑空闲时间", () => ({ userIdleSeconds: vi.fn((): number | null => { throw new Error("powerMonitor boom") }) })],
    ["Agent 是否在忙", () => ({ agentWorkInFlight: vi.fn((): boolean => { throw new Error("boom") }) })],
    ["Agent 安静时长", () => ({ agentQuietMs: vi.fn((): number => { throw new Error("boom") }) })],
    ["daemon 队列", () => ({ queuedMessages: vi.fn(async (): Promise<number | null> => { throw new Error("daemon boom") }) })],
    ["安装方式", () => ({ perUserInstall: vi.fn(async (): Promise<boolean> => { throw new Error("reg boom") }) })],
  ] as const)("取%s的探针抛异常：按「最不该重启」处理，不重启，也不把异常抛出来", async (_name, makeOver) => {
    await bootWithReadyUpdate({ silentUpdate: true }, makeProbes(makeOver() as Partial<IdleRestartProbes>))
    await runIdleTicks(3)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("问 daemon 卡住：最多等一会儿就当取不到，不把后面每一轮检查都挡住；之后恢复了照常重启", async () => {
    const probes = makeProbes({ queuedMessages: vi.fn(() => new Promise<number | null>(() => {})) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    await runIdleTicks(4)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    // 没有被第一次卡住的调用永远占着：每分钟都在重新问
    expect(probes.queuedMessages.mock.calls.length).toBeGreaterThanOrEqual(3)

    probes.queuedMessages.mockImplementation(async () => 0)
    await runIdleTicks()
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it("问 daemon 和查注册表的那一小段时间里情况变了（AI 又开始工作）：整套条件重新读一遍，不重启", async () => {
    const probes = makeProbes()
    probes.queuedMessages.mockImplementation(async () => {
      probes.agentWorkInFlight.mockReturnValue(true)
      return 0
    })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks(2)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("不是确认的「仅当前用户」安装：不自动重启，只写一次警告日志，之后不再每分钟去查", async () => {
    const probes = makeProbes({ perUserInstall: vi.fn(async () => false) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    await runIdleTicks(6)

    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    const notes = logsAt("WARN").filter((l) => l.includes("不会自动重启安装"))
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("退出应用时仍会安装")
    expect(probes.perUserInstall).toHaveBeenCalledTimes(1)
    // 退出时安装不受影响：开关仍是开的
    expect(h.updater.autoInstallOnAppQuit).toBe(true)
  })

  it("没有注入探针（比如测试或旧调用方）：不自动重启", async () => {
    await bootWithReadyUpdate({ silentUpdate: true }, undefined)
    await runIdleTicks(5)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("设置里单独关掉「空闲时自动重启安装」：不重启，也不碰任何探针；仍然只在退出时安装", async () => {
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true, silentUpdateIdleRestart: false }, probes)
    await runIdleTicks(5)

    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(probes.userIdleSeconds).not.toHaveBeenCalled()
    expect(probes.agentWorkInFlight).not.toHaveBeenCalled()
    expect(probes.queuedMessages).not.toHaveBeenCalled()
    expect(h.updater.autoInstallOnAppQuit).toBe(true)
    expect(sent("updater:status")).toContainEqual([{ kind: "downloaded", version: "1.4.2", silent: true, idleRestart: false }])
    expect(logs().some((l) => l.includes("已下载好") && !l.includes("自动重启并安装"))).toBe(true)
  })

  it("旧配置里没有这个字段：按开处理；下好的提示里说明空闲时会自动重启，并写明空闲多久", async () => {
    await bootWithReadyUpdate({ silentUpdate: true }, makeProbes())
    expect(logs().some((l) => l.includes("已下载好") && l.includes("15 分钟") && l.includes("自动重启并安装"))).toBe(true)
  })

  it("下载好之后用户把空闲重启关了：之后不再重启", async () => {
    const probes = makeProbes({ userIdleSeconds: vi.fn((): number | null => 60) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks(2)

    h.s.config = { silentUpdate: true, silentUpdateIdleRestart: false }
    probes.userIdleSeconds.mockReturnValue(3600)
    await runIdleTicks(3)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("下载好之后用户把静默更新整个关了：不重启，退出时安装也不再登记", async () => {
    const probes = makeProbes({ userIdleSeconds: vi.fn((): number | null => 60) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks(2)

    h.s.config = { silentUpdate: false }
    probes.userIdleSeconds.mockReturnValue(3600)
    await runIdleTicks(3)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it("静默更新关着（默认）：不自动重启，探针一个都不碰", async () => {
    const probes = makeProbes()
    await boot({}, "1.4.2", probes)
    await runStartup()
    await runIdleTicks(5)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(probes.userIdleSeconds).not.toHaveBeenCalled()
  })

  it("没有下好的新版本（远端和本机同版本）：每分钟的检查什么探针都不碰", async () => {
    const probes = makeProbes()
    await boot({ silentUpdate: true }, "1.4.1", probes)
    await runStartup()
    await runIdleTicks(10)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(probes.userIdleSeconds).not.toHaveBeenCalled()
    expect(probes.agentWorkInFlight).not.toHaveBeenCalled()
    expect(probes.queuedMessages).not.toHaveBeenCalled()
  })

  it("macOS / Linux：配置里有开关也不生效，探针不碰", async () => {
    for (const platform of ["darwin", "linux"]) {
      setPlatform(platform)
      const probes = makeProbes()
      await boot({ silentUpdate: true, silentUpdateIdleRestart: true }, "1.4.2", probes)
      await runStartup()
      await runIdleTicks(5)
      expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
      expect(probes.userIdleSeconds).not.toHaveBeenCalled()
    }
  })

  it("未打包（开发版）：不注册空闲检查", async () => {
    h.app.isPackaged = false
    const probes = makeProbes()
    await boot({ silentUpdate: true }, "1.4.2", probes)
    await runStartup()
    await runIdleTicks(5)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(probes.userIdleSeconds).not.toHaveBeenCalled()
  })

  it("又有一版在后台下载：等它下完再装，装的是最新的那一版", async () => {
    // 先让用户「在用」：下好 1.4.2 之后不重启，一直撑到 6 小时的定时检查去下 1.4.3
    const probes = makeProbes({ userIdleSeconds: vi.fn((): number | null => 60) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    let finishDownload: () => void = () => undefined
    h.prefetchInstaller.mockImplementationOnce(() => new Promise((resolve) => {
      finishDownload = () => resolve({ reusedExisting: false, attempts: 1 })
    }))
    h.s.remoteVersion = "1.4.3"
    await runPeriodic()
    expect(h.prefetchInstaller).toHaveBeenCalledTimes(2)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()

    // 人走开了，但 1.4.3 还没下完：不能把旧的 1.4.2 装上
    probes.userIdleSeconds.mockReturnValue(3600)
    await runIdleTicks(3)
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled()

    finishDownload()
    await settle()
    await runIdleTicks()
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(logs().some((l) => l.includes("自动重启安装 v1.4.3"))).toBe(true)
  })
})

describe("空闲自动重启：装不上时不会反复关应用", () => {
  it("应用没有退出（安装器没接手）：隔一阵再试一次，同一个版本最多两次，之后写一次日志就不再试", async () => {
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    // quitAndInstall 是空操作：应用「还活着」
    await runIdleTicks(1)
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    // 重试间隔内不会再来
    await runIdleTicks(5)
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)

    await runIdleTicks(8)
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(2)

    await runIdleTicks(40)
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(2)
    const notes = logsAt("WARN").filter((l) => l.includes("不会自动重启安装") && l.includes("几次都没装上"))
    expect(notes).toHaveLength(1)
  })

  it("发起重启后 electron-updater 报错（安装器没能启动）：撤销重启记号，写警告日志，之后还能再试", async () => {
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    await runIdleTicks()
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1)

    h.updater.emit("error", new Error("installer spawn failed"))
    await settle()

    expect(probes.cancelRestart).toHaveBeenCalledTimes(1)
    expect(logsAt("WARN").some((l) => l.includes("自动重启安装没有成功") && l.includes("installer spawn failed"))).toBe(true)

    await runIdleTicks()
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(2)
  })

  it("没有发起重启时的 electron-updater 报错：不去动重启记号", async () => {
    const probes = makeProbes({ userIdleSeconds: vi.fn((): number | null => 60) })
    await bootWithReadyUpdate({ silentUpdate: true }, probes)
    h.updater.emit("error", new Error("some other error"))
    await settle()
    expect(probes.cancelRestart).not.toHaveBeenCalled()
  })

  it("quitAndInstall 直接抛异常：撤销记号、写警告日志，不抛出来；有限次数地再试", async () => {
    h.updater.quitAndInstall.mockImplementation(() => {
      throw new Error("spawn EACCES")
    })
    const probes = makeProbes()
    await bootWithReadyUpdate({ silentUpdate: true }, probes)

    await runIdleTicks(10)
    expect(probes.cancelRestart).toHaveBeenCalled()
    expect(logsAt("WARN").some((l) => l.includes("自动重启安装没有成功") && l.includes("spawn EACCES"))).toBe(true)
    // 每次失败后立刻允许下一分钟再试，但次数有上限
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(2)
  })
})
