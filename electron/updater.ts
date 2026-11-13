import { app, BrowserWindow, dialog, ipcMain, shell, net, session } from "electron"
import electronUpdater from "electron-updater"
import type { AppUpdater, UpdateInfo } from "electron-updater"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import * as path from "node:path"
import semver from "semver"
import { getConfig } from "./config-store"
import { syncMainProcessProxyEnv } from "./agent-env"
import { DownloadRetryExhausted, errorMessage as downloadErrorMessage } from "./resumable-download"
import { createRotatingFetch, formatRetryNotice, pickWindowsInstaller, prefetchInstaller } from "./update-prefetch"
import { macInstallerUrl, summarizeBrewFailure } from "./brew-update"
import { broadcastLog } from "./ui-logger"
import {
  IDLE_RESTART_CHECK_INTERVAL_MS,
  IDLE_RESTART_RETRY_AFTER_MS,
  IDLE_RESTART_USER_IDLE_SEC,
  SILENT_CHECK_INTERVAL_MS,
  decideIdleRestart,
  decideSilentUpdate,
  idleRestartWaitText,
  isPermanentIdleWait,
  type IdleRestartInput,
  type IdleRestartWaitReason,
} from "../src/shared/silent-update.js"

const execFileAsync = promisify(execFile)

const autoUpdater: AppUpdater = (electronUpdater as { autoUpdater: AppUpdater }).autoUpdater

const GITHUB_OWNER = "lk-eternal"
const GITHUB_REPO = "lk-harness"
const RELEASES_BASE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
const HOMEBREW_TAP = "lk-eternal/homebrew-tap"
const HOMEBREW_CASK = "lk-harness"

const STARTUP_CHECK_DELAY_MS = 4_000
/** 空闲自动重启里，问 daemon、查注册表这类慢探针最多等多久 */
const IDLE_PROBE_TIMEOUT_MS = 15_000

const DEV_FAKE_LATEST_VERSION = "99.99.99"

function isDevSimulateUpdate(): boolean {
  if (app.isPackaged) {
    return false
  }
  const v = (process.env.FEISHU_DEV_SIMULATE_UPDATE ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

function fakeLatestReleaseForDev(): LatestRelease {
  return {
    version: DEV_FAKE_LATEST_VERSION,
    htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
  }
}

function devSimulateDetailSuffix(): string {
  return "\n（开发测试：不会真的安装）"
}

export interface LatestRelease {
  version: string
  htmlUrl: string
  releaseBody?: string
}

interface ChangelogEntry {
  version: string
  date: string
  changes: string[]
}

export type UpdaterCheckResult =
  | { status: "dev"; currentVersion: string; message: string }
  | { status: "error"; currentVersion: string; message: string }
  | { status: "latest"; currentVersion: string; latestVersion: string }
  | {
      status: "available"
      currentVersion: string
      latestVersion: string
      htmlUrl: string
      applyHint: string
      releaseNotes: string
    }
  | {
      status: "ready"
      currentVersion: string
      latestVersion: string
      htmlUrl: string
      applyHint: string
      releaseNotes: string
    }

export interface UpdaterApplyResult {
  ok: boolean
  error?: string
  message?: string
  /** 自动更新失败时的手动下载直链（目前只有 macOS 的 brew 失败会给） */
  downloadUrl?: string
}

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let winDownloadRequested = false
let lastKnownRemote: LatestRelease | null = null
let autoUpdaterWired = false
let updaterIpcRegistered = false
let downloadedUpdateVersion: string | null = null

// ── 静默更新（仅 Windows，设置里的开关）：决策在 shared/silent-update.ts，这里只管接线 ──
/** 这一路下载是静默发起的：失败只写日志，不弹「自动更新失败」；下载开始或失败时清掉 */
let silentRunActive = false
/** 静默一轮的查询阶段互斥：启动、定时、设置页检查同时到来时只放一路进去 */
let silentCycleBusy = false
/** 本进程里已经下好、等着安装的版本。不跨重启，也不影响上面原有的 downloadedUpdateVersion（它每次检查都会被重置） */
let installReadyVersion: string | null = null

/**
 * 「空闲时自动重启安装」判断现场情况要用的探针。取值都在 electron/idle-probes.ts，由 main 在应用就绪后注入；
 * 没注入就不会自动重启。这里只有接线，决策在 shared/silent-update.ts 的 decideIdleRestart。
 */
export interface IdleRestartProbes {
  /** 距离用户最后一次操作电脑（键盘、鼠标，含睡眠唤醒、解锁）过了多少秒；取不到为 null */
  userIdleSeconds(): number | null
  /** 此刻有没有 Agent 在跑回合或正在拉起（监听中的长连接会话不算） */
  agentWorkInFlight(): boolean
  /** 距离 Agent 最后一次开始或结束回合过了多少毫秒 */
  agentQuietMs(): number
  /** daemon 队列里排队和处理中的消息数；daemon 没在跑为 0；拿不到为 null */
  queuedMessages(): Promise<number | null>
  /** 是不是确认的「仅当前用户」安装；没能确认一律 false，从不 reject */
  perUserInstall(): Promise<boolean>
  /** 退出重启之前：记下窗口是不是收在托盘里，装完启动时据此决定要不要弹出来 */
  beforeRestart(info: { keepHidden: boolean }): void
  /** 重启没有真正发生：撤销上面记下的东西 */
  cancelRestart(): void
}
let idleRestartProbes: IdleRestartProbes | null = null
/** 一轮空闲检查还在跑（要去问 daemon 和注册表，别叠起来） */
let idleCheckBusy = false
/** 已经发起了自动重启，正等着应用退出 */
let idleRestartTriggered = false
/** 每个版本已经自动重启过几次 */
const idleRestartAttempts = new Map<string, number>()
/** 已经确定不会自动重启、也写过日志的版本：不再每分钟评估 */
const idleRestartGaveUp = new Set<string>()

/**
 * 注意：这个路径**不是** electron-updater 的缓存目录。
 *
 * electron-updater 用 `<baseCachePath>/<updaterCacheDirName>`（Windows 是 `%LOCALAPPDATA%\lk-harness-updater`，
 * macOS 是 `~/Library/Caches`，Linux 是 `$XDG_CACHE_HOME`），而这里拼的是 `<userData>/../…`（Windows 的 `%APPDATA%`），
 * 目录并不存在。结果是下面三个函数实际上都不起作用：
 * - readCachedDownloadVersion 恒为 null（即便路径对了也一样：update-info.json 里只有 fileName/sha512/
 *   isAdminRightsRequired，没有 version 字段）
 * - clearUpdaterCache 是空操作
 *
 * 这恰好保护了两件事，**所以不要只把路径「改对」**：
 * 1. 下载前的 clearUpdaterCache 一旦真的生效，会把 pending 里的 `.part`（断点续传）和已下好的安装包一起删掉，
 *    重启后续传、重复点下载秒过校验都会失效；缓存根目录里的 installer.exe 是 NSIS 留给差分更新的底包，也会被删。
 * 2. 一旦「已下载」被识别，重启后会直接 quitAndInstall；但 electron-updater 的下载状态在内存里，
 *    新进程里没走过 downloadUpdate 就会报「No update filepath provided」。现在每次都走 checkForUpdates → 秒过校验的缓存，
 *    才触发 update-downloaded 再安装。
 *
 * 想让「已下载」跨重启生效，需要同时做：用 electron-updater 的真实 pending 目录（resolveUpdaterPendingDir）、
 * 从 fileName 解析版本、只清 pending 里过期的内容、并在新进程里先让 electron-updater 载入缓存再 quitAndInstall。
 * 这条链路只能在打包后的真实安装包里验证，所以先保持现状。
 */
function getUpdaterCacheDir(): string {
  return path.join(app.getPath("userData"), "..", `${app.getName()}-updater`)
}

function readCachedDownloadVersion(): string | null {
  try {
    const infoPath = path.join(getUpdaterCacheDir(), "pending", "update-info.json")
    if (!fs.existsSync(infoPath)) {
      return null
    }
    const json = JSON.parse(fs.readFileSync(infoPath, "utf-8")) as { version?: string }
    if (typeof json.version !== "string") {
      return null
    }
    const version = normalizeReleaseVersion(json.version)
    return semver.valid(version) ? version : null
  } catch {
    return null
  }
}

async function invalidateStaleDownload(latest: LatestRelease): Promise<void> {
  const cached = readCachedDownloadVersion()
  downloadedUpdateVersion = cached
  if (!cached) {
    return
  }
  if (semver.eq(cached, latest.version)) {
    return
  }
  clearUpdaterCache()
  downloadedUpdateVersion = null
}

async function buildAvailableOrReadyResult(
  currentVersion: string,
  rel: LatestRelease,
): Promise<Extract<UpdaterCheckResult, { status: "available" | "ready" }>> {
  await invalidateStaleDownload(rel)
  const notes = await resolveReleaseNotes(currentVersion, rel)
  const base = {
    currentVersion,
    latestVersion: rel.version,
    htmlUrl: rel.htmlUrl,
    applyHint: applyHintForPlatform(),
    releaseNotes: notes,
  }
  const cached = readCachedDownloadVersion()
  downloadedUpdateVersion = cached
  if (cached && semver.eq(cached, rel.version)) {
    return { status: "ready", ...base }
  }
  return { status: "available", ...base }
}

function isAutoUpgradePromptEnabled(): boolean {
  return getConfig().autoUpgradePrompt !== false
}

/** 静默更新是否生效：只在 Windows 的安装版里，且设置里开着；开着时优先于「启动时提示升级」 */
function isSilentUpdateEnabled(): boolean {
  return process.platform === "win32" && app.isPackaged && getConfig().silentUpdate === true
}

/** 空闲时自动重启安装是否生效：静默更新开着，且设置里没有把它单独关掉（默认开） */
function isIdleRestartEnabled(): boolean {
  return isSilentUpdateEnabled() && getConfig().silentUpdateIdleRestart !== false
}

/** 静默更新没有任何窗口，出了问题只能靠日志排查，所以写进应用日志（界面日志和日志文件） */
function silentLog(message: string, level: "INFO" | "WARN" = "INFO"): void {
  broadcastLog(`[Updater] 静默更新：${message}`, level)
}

/**
 * electron-updater 的「退出时静默安装」：下载完成那一刻开关是开的才会登记退出处理，退出时它还会再看一次开关。
 * 所以下载开始前、下载完成时、退出前各同步一次，用户中途把开关关了，退出时就不会装。
 */
function syncAutoInstallOnQuit(): void {
  autoUpdater.autoInstallOnAppQuit = isSilentUpdateEnabled()
}

function promptInstallDownloaded(version: string): void {
  if (!isAutoUpgradePromptEnabled() || isSilentUpdateEnabled()) {
    return
  }
  void showAppModal({
    variant: "info",
    title: "更新已就绪",
    message: `新版本 v${version} 已下载，是否立即安装并重启？`,
    buttons: ["稍后", "立即安装"],
    defaultId: 1,
    cancelId: 0,
  }).then((resp) => {
    if (resp === 1) {
      setImmediate(() => {
        autoUpdater.quitAndInstall(false, true)
      })
    }
  })
}

interface AppModalOptions {
  variant?: "info" | "error" | "warning"
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

interface ModalQueueItem {
  options: AppModalOptions
  resolve: (index: number) => void
}

const pendingModalResolvers = new Map<string, (index: number) => void>()
const modalWaitQueue: ModalQueueItem[] = []
let modalProcessor: Promise<void> | null = null

function getMainWindow(): BrowserWindow | null {
  return mainWindowGetter?.() ?? null
}

async function showAppModalOnce(options: AppModalOptions): Promise<number> {
  const w = getMainWindow()
  if (!w || w.isDestroyed()) {
    const type =
      options.variant === "error" ? "error" : options.variant === "warning" ? "warning" : "info"
    const detailPart = options.detail ? `\n\n${options.detail}` : ""
    const r = await dialog.showMessageBox({
      type,
      title: options.title,
      message: options.message + detailPart,
      buttons: options.buttons,
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? 0,
    })
    return r.response
  }
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pendingModalResolvers.set(requestId, resolve)
    w.webContents.send("app:modal-request", {
      requestId,
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons,
      defaultId: options.defaultId,
      cancelId: options.cancelId,
      variant: options.variant,
    })
  })
}

function ensureModalProcessor(): void {
  if (modalProcessor) {
    return
  }
  modalProcessor = (async () => {
    while (modalWaitQueue.length > 0) {
      const item = modalWaitQueue.shift()
      if (!item) {
        break
      }
      const idx = await showAppModalOnce(item.options)
      item.resolve(idx)
    }
  })().finally(() => {
    modalProcessor = null
    if (modalWaitQueue.length > 0) {
      ensureModalProcessor()
    }
  })
}

function showAppModal(options: AppModalOptions): Promise<number> {
  return new Promise((resolve) => {
    modalWaitQueue.push({ options, resolve })
    ensureModalProcessor()
  })
}

function normalizeReleaseVersion(tagName: string): string {
  return tagName.replace(/^v/i, "").trim()
}

/** 把设置里的代理同步到主进程 env + Chromium session（更新检查/下载走这条路径） */
export async function applyAppNetworkProxy(target: Electron.Session = session.defaultSession): Promise<void> {
  const config = getConfig()
  syncMainProcessProxyEnv(config)
  const proxy = (config.httpsProxy || config.httpProxy || "").trim()
  const bypass = (config.noProxy || "localhost,127.0.0.1,<local>").trim()
  try {
    if (proxy) {
      await target.setProxy({ proxyRules: proxy, proxyBypassRules: bypass })
    } else {
      await target.setProxy({ mode: "system" })
    }
  } catch {
    /* best-effort */
  }
}

async function httpGetText(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; text: string } | null> {
  await applyAppNetworkProxy()
  try {
    const res = await net.fetch(url, {
      headers: {
        "User-Agent": "lk-harness-desktop-updater",
        ...(headers || {}),
      },
      // 被墙的源（api.github.com 直连）会长时间挂起，必须限时让并发查询尽快收敛
      signal: AbortSignal.timeout(12_000),
    })
    return { status: res.status, text: await res.text() }
  } catch {
    return null
  }
}

async function httpHead(url: string): Promise<{ status: number } | null> {
  await applyAppNetworkProxy()
  try {
    const res = await net.fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "lk-harness-desktop-updater" },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    })
    return { status: res.status }
  } catch {
    return null
  }
}

function parseGithubReleaseJson(text: string): LatestRelease | null {
  try {
    const json = JSON.parse(text) as {
      tag_name?: string
      html_url?: string
      body?: string | null
      assets?: unknown[]
    }
    const tag = json.tag_name
    const htmlUrl = json.html_url
    if (typeof tag !== "string" || typeof htmlUrl !== "string") return null
    if (json.assets && json.assets.length === 0) return null
    const version = normalizeReleaseVersion(tag)
    if (!semver.valid(version)) return null
    const releaseBody = typeof json.body === "string" ? json.body.trim() : undefined
    return { version, htmlUrl, releaseBody: releaseBody || undefined }
  } catch {
    return null
  }
}

function parsePackageJsonVersion(text: string): LatestRelease | null {
  try {
    const json = JSON.parse(text) as { version?: string }
    const version = normalizeReleaseVersion(json.version || "")
    if (!semver.valid(version)) return null
    return {
      version,
      htmlUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${version}`,
    }
  } catch {
    return null
  }
}

async function fetchViaGithubApi(): Promise<LatestRelease | null> {
  const api = await httpGetText(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { Accept: "application/vnd.github+json" },
  )
  if (api?.status !== 200) return null
  return parseGithubReleaseJson(api.text)
}

/** 取已发布 Release 列表中最新一条（含 assets），排除 draft */
async function fetchViaGithubReleasesList(): Promise<LatestRelease | null> {
  const api = await httpGetText(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=15`,
    { Accept: "application/vnd.github+json" },
  )
  if (api?.status !== 200) return null
  try {
    const list = JSON.parse(api.text) as Array<{
      tag_name?: string
      html_url?: string
      body?: string | null
      draft?: boolean
      assets?: unknown[]
    }>
    for (const item of list) {
      if (item.draft || !item.assets?.length) continue
      const rel = parseGithubReleaseJson(JSON.stringify(item))
      if (rel) return rel
    }
    return null
  } catch {
    return null
  }
}

async function releaseHasDownloadAssets(version: string): Promise<boolean> {
  const probes = [
    manualUpdateUrl(version),
    `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/latest-mac.yml`,
    `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/latest-linux.yml`,
  ]
  const results = await Promise.all(probes.map((url) => httpHead(url)))
  return results.some((r) => r?.status === 200)
}

/** jsdelivr CDN 边缘缓存可滞后数小时；加时间戳参数强制回源 */
function jsdelivrCacheBust(): string {
  return `?t=${Date.now()}`
}

async function fetchPackageJsonRelease(
  fetcher: () => Promise<LatestRelease | null>,
): Promise<LatestRelease | null> {
  const rel = await fetcher()
  if (!rel || !(await releaseHasDownloadAssets(rel.version))) return null
  return rel
}

async function fetchViaRawGitHubPackageJson(): Promise<LatestRelease | null> {
  const urls = [
    `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/package.json`,
    `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/master/package.json`,
  ]
  for (const url of urls) {
    const r = await httpGetText(url)
    if (r?.status === 200) {
      const rel = parsePackageJsonVersion(r.text)
      if (rel) return rel
    }
  }
  return null
}

async function fetchViaJsdelivrPackageJson(): Promise<LatestRelease | null> {
  const bust = jsdelivrCacheBust()
  const mirrors = [
    `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@main/package.json${bust}`,
    `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@master/package.json${bust}`,
  ]
  for (const url of mirrors) {
    const r = await httpGetText(url)
    if (r?.status === 200) {
      const rel = parsePackageJsonVersion(r.text)
      if (rel) return rel
    }
  }
  return null
}

/**
 * 只认 GitHub Releases（已发布且含安装包），不用 git tag。
 * api.github.com 被墙时，package.json 兜底须通过安装包 HEAD 探测。
 */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const releaseResults = await Promise.all([fetchViaGithubApi(), fetchViaGithubReleasesList()])
  const fromReleases = releaseResults.filter((r): r is LatestRelease => r !== null)
  if (fromReleases.length > 0) {
    fromReleases.sort((a, b) => semver.rcompare(a.version, b.version))
    const best = fromReleases[0]
    const githubLatest = releaseResults[0]
    if (githubLatest && semver.eq(githubLatest.version, best.version)) return githubLatest
    return best
  }

  const fallbackResults = await Promise.all([
    fetchPackageJsonRelease(fetchViaJsdelivrPackageJson),
    fetchPackageJsonRelease(fetchViaRawGitHubPackageJson),
  ])
  const fallbacks = fallbackResults.filter((r): r is LatestRelease => r !== null)
  if (fallbacks.length === 0) return null
  fallbacks.sort((a, b) => semver.rcompare(a.version, b.version))
  return fallbacks[0]
}

function parseChangelogJson(text: string): ChangelogEntry[] {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed as ChangelogEntry[]
  } catch {
    return []
  }
}

function readBundledChangelog(): ChangelogEntry[] {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "changelog.json")]
    : [path.join(app.getAppPath(), "changelog.json")]
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) {
        continue
      }
      const entries = parseChangelogJson(fs.readFileSync(filePath, "utf-8"))
      if (entries.length > 0) {
        return entries
      }
    } catch {
      /* try next */
    }
  }
  return []
}

function fetchChangelogFromRawGitHub(): Promise<ChangelogEntry[]> {
  const urls = [
    `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/changelog.json`,
    `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@main/changelog.json${jsdelivrCacheBust()}`,
  ]
  return (async () => {
    for (const url of urls) {
      const r = await httpGetText(url)
      if (r?.status === 200) {
        const entries = parseChangelogJson(r.text)
        if (entries.length > 0) return entries
      }
    }
    return []
  })()
}

function fetchChangelogViaGitHubApi(): Promise<ChangelogEntry[]> {
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/changelog.json?ref=main`
  return (async () => {
    const r = await httpGetText(`https://api.github.com${apiPath}`, {
      Accept: "application/vnd.github+json",
    })
    if (!r || r.status !== 200) return []
    try {
      const json = JSON.parse(r.text) as { content?: string; encoding?: string }
      if (json.encoding !== "base64" || typeof json.content !== "string") return []
      const text = Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf-8")
      return parseChangelogJson(text)
    } catch {
      return []
    }
  })()
}

async function fetchChangelogEntries(): Promise<ChangelogEntry[]> {
  const fromRaw = await fetchChangelogFromRawGitHub()
  if (fromRaw.length > 0) {
    return fromRaw
  }
  const fromApi = await fetchChangelogViaGitHubApi()
  if (fromApi.length > 0) {
    return fromApi
  }
  return readBundledChangelog()
}

function buildReleaseNotes(entries: ChangelogEntry[], currentVersion: string): string {
  const newer = entries.filter((e) => semver.valid(e.version) && semver.gt(e.version, currentVersion))
  if (newer.length === 0) {
    return ""
  }
  newer.sort((a, b) => semver.rcompare(a.version, b.version))
  return newer
    .map((e) => {
      const header = newer.length > 1 ? `v${e.version}：\n` : ""
      return header + e.changes.map((c) => `- ${c}`).join("\n")
    })
    .join("\n\n")
}

async function resolveReleaseNotes(currentVersion: string, latest: LatestRelease | null): Promise<string> {
  const fromChangelog = buildReleaseNotes(await fetchChangelogEntries(), currentVersion)
  if (fromChangelog) {
    return fromChangelog
  }
  const body = latest?.releaseBody?.trim()
  if (body && latest && semver.gt(latest.version, currentVersion)) {
    return body
  }
  return ""
}

function getBrewExecutable(): string | null {
  const arm = "/opt/homebrew/bin/brew"
  const intel = "/usr/local/bin/brew"
  if (fs.existsSync(arm)) {
    return arm
  }
  if (fs.existsSync(intel)) {
    return intel
  }
  return null
}

/** 不用 brew 的更新办法放在最前面：brew 自己的环境问题（目录权限、不受支持的平台）我们修不了 */
function brewFailureGuide(version: string): string {
  return [
    "不用 brew 也能更新：",
    `  1. 下载安装包（已按本机芯片选好）：${macInstallerUrl(RELEASES_BASE, version, process.arch)}`,
    "  2. 打开 dmg，把 LK Harness 拖进「应用程序」覆盖旧版",
    "  3. 终端执行：xattr -cr /Applications/LK\\ Harness.app",
    "",
    "用 brew 更新（在终端中执行）：",
    `  brew untap ${HOMEBREW_TAP}`,
    `  brew tap ${HOMEBREW_TAP}`,
    `  brew install --cask ${HOMEBREW_CASK}（首次安装；已用 brew 装过改用下一条升级）`,
    `  brew upgrade --cask ${HOMEBREW_CASK}（已通过 brew 安装的用户）`,
    "  xattr -cr /Applications/LK\\ Harness.app",
    "",
    `FAQ: https://github.com/${HOMEBREW_TAP}`,
  ].join("\n")
}

function brewFailureResult(version: string, headline: string, detail: string): UpdaterApplyResult {
  return {
    ok: false,
    error: `${[headline, detail].filter(Boolean).join("\n")}\n\n${brewFailureGuide(version)}`,
    downloadUrl: macInstallerUrl(RELEASES_BASE, version, process.arch),
  }
}

async function runBrewUpgrade(version: string): Promise<UpdaterApplyResult> {
  const brew = getBrewExecutable()
  if (!brew) {
    return brewFailureResult(version, "未找到 Homebrew（/opt/homebrew 或 /usr/local）。", "")
  }
  const brewEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
  }
  let step = "brew"
  const run = (args: string[], timeout: number) => {
    step = `brew ${args.join(" ")}`
    return execFileAsync(brew, args, { timeout, env: brewEnv })
  }
  try {
    await run(["tap", HOMEBREW_TAP], 120_000)
    await run(["update"], 300_000)
    // dmg 直装用户 brew 未登记 cask：先查在册才 upgrade，否则 install
    let installed = false
    try {
      await run(["list", "--cask", HOMEBREW_CASK], 60_000)
      installed = true
    } catch { /* 未安装，走 install */ }
    if (installed) {
      await run(["upgrade", "--cask", HOMEBREW_CASK], 600_000)
    } else {
      await run(["install", "--cask", HOMEBREW_CASK], 600_000)
    }
    return {
      ok: true,
      message: "更新已完成，请重启应用。",
    }
  } catch (e) {
    // execFile 的错误带 stderr，brew 的原因在里面；message 是「Command failed: …」加同样的内容
    const stderr = (e as { stderr?: unknown }).stderr
    const output = typeof stderr === "string" && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e)
    return brewFailureResult(version, `${step} 没有成功：`, summarizeBrewFailure(output))
  }
}

function manualUpdateUrl(version: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/lk-harness-setup-${version}.exe`
}

async function showWinDownloadFallback(reason: unknown): Promise<void> {
  const ver = lastKnownRemote?.version ?? ""
  const errMsg =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason)
  const downloadUrl = ver ? manualUpdateUrl(ver) : (lastKnownRemote?.htmlUrl ?? "")
  // 自动重试用尽：说明试过多少次，并告诉用户已下载的部分还在、再点更新会接着下
  const retryLines =
    reason instanceof DownloadRetryExhausted
      ? [
          `已自动重试 ${reason.attempts} 次，连续 ${reason.maxConsecutiveFailures} 次没有拿到新数据。`,
          reason.receivedBytes > 0
            ? "已下载的部分会保留，网络恢复后再点「更新」会从断点继续。"
            : "",
          "",
        ]
      : []
  const detail = [
    `错误: ${reason instanceof DownloadRetryExhausted ? downloadErrorMessage(reason.lastError) : errMsg}`,
    ...retryLines,
    "",
    "可能原因: 安装包托管在 GitHub，直接访问可能被墙。",
    "",
    downloadUrl ? "点击「手动下载」可在浏览器中打开安装包下载链接。" : "",
  ].filter(Boolean).join("\n")

  const buttons = downloadUrl ? ["关闭", "手动下载"] : ["关闭"]
  const r = await showAppModal({
    variant: "warning",
    title: "自动更新失败",
    message: "无法自动下载更新，请尝试手动更新。",
    detail,
    buttons,
    defaultId: downloadUrl ? 1 : 0,
    cancelId: 0,
  })
  if (r === 1 && downloadUrl) {
    await shell.openExternal(downloadUrl)
  }
}

function clearUpdaterCache(): void {
  try {
    const cacheDir = getUpdaterCacheDir()
    if (!fs.existsSync(cacheDir)) return
    for (const entry of fs.readdirSync(cacheDir)) {
      fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true })
    }
    downloadedUpdateVersion = null
  } catch { /* best-effort */ }
}

/**
 * electron-updater 自己用的缓存目录（pending）。用的是它的内部方法 getOrCreateDownloadHelper，
 * 取不到（版本升级改了内部实现）就返回 null，调用方退回它自带的下载；tests/update-prefetch.test.ts 里有守卫测试。
 */
async function resolveUpdaterPendingDir(): Promise<string | null> {
  const getter = (
    autoUpdater as unknown as {
      getOrCreateDownloadHelper?: () => Promise<{ cacheDirForPendingUpdate?: unknown }>
    }
  ).getOrCreateDownloadHelper
  if (typeof getter !== "function") return null
  try {
    const helper = await getter.call(autoUpdater)
    return typeof helper?.cacheDirForPendingUpdate === "string" ? helper.cacheDirForPendingUpdate : null
  } catch {
    return null
  }
}

/**
 * 先用「可续传 + 自动重试」的方式把安装包下到 electron-updater 的缓存里。
 * 失败（重试用尽、404 等）会抛出；缺少条件（找不到安装包条目/缓存目录）时直接返回，由它自带的下载接手。
 */
async function prefetchWinInstaller(info: UpdateInfo): Promise<void> {
  const entry = pickWindowsInstaller(info, RELEASES_BASE)
  const pendingDir = await resolveUpdaterPendingDir()
  if (!entry || !pendingDir) {
    console.warn("[updater] 无法预取安装包（没找到安装包条目或缓存目录），退回 electron-updater 自带的下载")
    return
  }
  await applyAppNetworkProxy()
  let lastSentPct = -1
  let sessionSeq = 0
  // 第一次走默认 session；之后每次重连前换一个新的内存 session（网络服务进程崩过之后，默认 session 会一直失败）
  const downloadFetch = createRotatingFetch({
    initial: session.defaultSession,
    createSession: async () => {
      const fresh = session.fromPartition(`lk-update-download-${Date.now()}-${++sessionSeq}`)
      await applyAppNetworkProxy(fresh)
      return fresh
    },
  })
  const result = await prefetchInstaller({
    pendingDir,
    entry,
    fetchImpl: downloadFetch.fetch,
    headers: { "User-Agent": "lk-harness-desktop-updater" },
    onProgress: ({ received, total }) => {
      if (!total) return
      const pct = (received / total) * 100
      if (pct < 100 && pct - lastSentPct < 0.5) return
      lastSentPct = pct
      getMainWindow()?.webContents.send("updater:progress", pct)
    },
    onRetry: (r) => {
      downloadFetch.rotate()
      console.warn(
        `[updater] 下载中断（第 ${r.attempt} 次连接，连续无进展 ${r.failures}/${r.maxFailures}，已收 ${r.receivedBytes} 字节）：${downloadErrorMessage(r.error)}`,
      )
      getMainWindow()?.webContents.send("updater:status", { kind: "retrying" as const, message: formatRetryNotice(r) })
    },
  })
  console.info(
    result.reusedExisting
      ? "[updater] 缓存里已有校验通过的安装包"
      : `[updater] 安装包下载完成（共连接 ${result.attempts} 次）`,
  )
}

let activeWinDownload: Promise<void> | null = null

/** 下载失败的出口：用户点的更新弹「自动更新失败」；静默发起的只写日志，下个周期再试 */
function reportWinDownloadFailure(err: unknown, silent = silentRunActive): void {
  if (silent) {
    silentRunActive = false
    silentLog(`下载失败，下个周期再试：${downloadErrorMessage(err)}`, "WARN")
    return
  }
  void showWinDownloadFallback(err)
}

/** Windows 下载更新：续传下载安装包 → 交给 electron-updater 校验缓存并发出 update-downloaded */
function startWinDownload(info: UpdateInfo, silent = false): void {
  // 下载完成那一刻 electron-updater 才登记「退出时安装」，所以要赶在下载开始前把开关同步好
  syncAutoInstallOnQuit()
  getMainWindow()?.webContents.send("updater:status", { kind: "downloading" as const })
  // 已经在下了：别再起第二路，否则两路会写同一个 .part
  if (activeWinDownload) return
  activeWinDownload = (async () => {
    try {
      await prefetchWinInstaller(info)
    } catch (err) {
      // 重试用尽或不可重试的失败：通知界面结束「下载中」状态，再弹手动下载的提示
      getMainWindow()?.webContents.send("updater:error", downloadErrorMessage(err))
      reportWinDownloadFailure(err, silent)
      return
    }
    try {
      // 缓存已就位时它直接触发 update-downloaded；万一校验没通过，它会按自己的方式下载
      await autoUpdater.downloadUpdate()
    } catch (err) {
      // 它的 error 事件已经通知过界面
      reportWinDownloadFailure(err, silent)
    }
  })().finally(() => {
    activeWinDownload = null
  })
}

/**
 * 静默更新的一轮：查版本 → 有新版本就在后台下载（不弹任何窗口）→ 下好后等退出时自动安装。
 * 启动、定时、设置页检查更新都会走到这里；开关没开、已经有一路在跑、没有更新时什么都不做。
 * 失败只写日志，下个周期再试。known 是调用方刚查到的结果，给了就不再查一遍。
 */
async function runSilentUpdateCycle(reason: string, known?: LatestRelease | null): Promise<void> {
  if (!isSilentUpdateEnabled() || silentCycleBusy) {
    return
  }
  const busy = (): boolean => silentRunActive || winDownloadRequested || activeWinDownload !== null
  if (busy()) {
    return
  }
  silentCycleBusy = true
  try {
    const rel = known ?? (await fetchLatestRelease())
    if (rel) {
      lastKnownRemote = rel
    }
    // 查版本要几秒：期间用户可能手动点了更新、或把开关关了，下载前再判断一次
    const decision = decideSilentUpdate({
      enabled: isSilentUpdateEnabled(),
      busy: busy(),
      current: app.getVersion(),
      remote: rel?.version ?? null,
      readyVersion: installReadyVersion,
    })
    if (decision.action === "skip") {
      if (decision.reason === "no-remote") {
        silentLog(`${reason}：查不到最新版本（网络或版本源不通），下个周期再试`, "WARN")
      }
      return
    }
    silentLog(`${reason}：发现新版本 v${decision.version}（当前 v${app.getVersion()}），开始后台下载`)
    silentRunActive = true
    winDownloadRequested = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // 它的 error 事件通常已经处理过一次；没处理（silentRunActive 还在）才在这里补
      if (silentRunActive) {
        reportWinDownloadFailure(err, true)
      }
      winDownloadRequested = false
    }
    // 三个事件（有更新 / 没更新 / 出错）一个都没来，不该发生：别让标记一直挂着，把后面的周期都挡住
    if (winDownloadRequested || silentRunActive) {
      winDownloadRequested = false
      silentRunActive = false
      silentLog("检查更新没有返回结果，这一轮作废，下个周期再试", "WARN")
    }
  } finally {
    silentCycleBusy = false
  }
}

/** 探针抛了异常：按「最不该重启」的方向取值，宁可晚装 */
function probeOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** 慢探针（问 daemon、查注册表）：抛异常或超过时限都按 fallback 取值，免得一个卡住的探针把后面每一轮检查都挡住 */
async function probeOrAsync<T>(read: () => Promise<T>, fallback: T, timeoutMs = IDLE_PROBE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } catch {
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 只有「这个版本不会再自动重启」才值得写日志（每个版本一次）；暂时等一等的原因每分钟都在变，不写 */
function noteIdleRestartWait(version: string, reason: IdleRestartWaitReason): void {
  if (!isPermanentIdleWait(reason) || idleRestartGaveUp.has(version)) return
  idleRestartGaveUp.add(version)
  silentLog(`v${version} 不会自动重启安装：${idleRestartWaitText(reason)}`, "WARN")
}

/** 发起一次自动重启安装：记下窗口状态，再让 electron-updater 静默安装并重启 */
function startIdleRestart(probes: IdleRestartProbes, version: string): void {
  const win = getMainWindow()
  // 窗口原本收在托盘（隐藏）或最小化着：装完留在托盘，别在人不在电脑前时弹到最前面
  const keepHidden = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()
  idleRestartAttempts.set(version, (idleRestartAttempts.get(version) ?? 0) + 1)
  idleRestartTriggered = true
  // 正常情况下应用会在几秒内退出；万一安装器没接手、应用还活着，隔一阵允许再试（次数有上限）
  setTimeout(() => {
    idleRestartTriggered = false
  }, IDLE_RESTART_RETRY_AFTER_MS).unref()
  probeOr(() => probes.beforeRestart({ keepHidden }), undefined)
  silentLog(`电脑空闲且没有 AI 在工作，自动重启安装 v${version}${keepHidden ? "（窗口原本在托盘里，装完仍留在托盘）" : ""}`)
  try {
    autoUpdater.quitAndInstall(true, true)
  } catch (err) {
    idleRestartTriggered = false
    probeOr(() => probes.cancelRestart(), undefined)
    silentLog(`自动重启安装没有成功：${downloadErrorMessage(err)}`, "WARN")
  }
}

/**
 * 空闲时自动重启安装的一次检查（每分钟一次）：已经下好新版本、开关开着，并且人不在、AI 没在干活，就重启装上。
 * 没开、没有下好的版本时立刻返回，什么都不查。要去问 daemon 和注册表的条件放在便宜的条件都满足之后再查，
 * 查完整套条件再读一遍：那几十毫秒里情况可能变了。
 */
async function runIdleRestartCheck(): Promise<void> {
  const probes = idleRestartProbes
  const version = installReadyVersion
  if (!probes || !version || idleCheckBusy || idleRestartTriggered) return
  if (idleRestartGaveUp.has(version) || !isIdleRestartEnabled()) return
  idleCheckBusy = true
  try {
    const decide = (slow: Pick<IdleRestartInput, "perUserInstall" | "queued">) =>
      decideIdleRestart({
        enabled: isIdleRestartEnabled(),
        readyVersion: installReadyVersion,
        current: app.getVersion(),
        downloading: silentRunActive || winDownloadRequested || activeWinDownload !== null,
        attempts: idleRestartAttempts.get(version) ?? 0,
        userIdleSec: probeOr(() => probes.userIdleSeconds(), null),
        agentBusy: probeOr(() => probes.agentWorkInFlight(), true),
        agentQuietMs: probeOr(() => probes.agentQuietMs(), 0),
        ...slow,
      })
    const quick = decide({ perUserInstall: true, queued: 0 })
    if (quick.action === "wait") {
      noteIdleRestartWait(version, quick.reason)
      return
    }
    const [perUserInstall, queued] = await Promise.all([
      probeOrAsync(() => probes.perUserInstall(), false),
      probeOrAsync(() => probes.queuedMessages(), null),
    ])
    const final = decide({ perUserInstall, queued })
    if (final.action === "wait") {
      noteIdleRestartWait(version, final.reason)
      return
    }
    startIdleRestart(probes, final.version)
  } finally {
    idleCheckBusy = false
  }
}

function wireAutoUpdater(): void {
  if (autoUpdaterWired || !app.isPackaged) {
    return
  }
  autoUpdaterWired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 退出前再对一次开关：下载完成后用户把静默更新关了，退出时就不该自动装
  app.on("before-quit", syncAutoInstallOnQuit)

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    getMainWindow()?.webContents.send("updater:status", { kind: "available" as const })
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      // 静默标记交给这一路下载带着走，自己清掉
      const silent = silentRunActive
      silentRunActive = false
      startWinDownload(info, silent)
    }
  })

  autoUpdater.on("update-not-available", () => {
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      reportWinDownloadFailure(new Error("未找到可用更新"))
    }
  })

  autoUpdater.on("download-progress", (p) => {
    getMainWindow()?.webContents.send("updater:progress", p.percent)
  })

  autoUpdater.on("update-downloaded", (info) => {
    const version = normalizeReleaseVersion(info.version)
    downloadedUpdateVersion = semver.valid(version) ? version : null
    installReadyVersion = downloadedUpdateVersion
    syncAutoInstallOnQuit()
    const silent = isSilentUpdateEnabled()
    const idleRestart = isIdleRestartEnabled()
    getMainWindow()?.webContents.send("updater:status", {
      kind: "downloaded" as const,
      version: downloadedUpdateVersion ?? version,
      silent,
      idleRestart,
    })
    if (silent) {
      const idleNote = idleRestart
        ? `；电脑 ${IDLE_RESTART_USER_IDLE_SEC / 60} 分钟没人操作、也没有 AI 在工作时，会自动重启并安装`
        : ""
      silentLog(`v${downloadedUpdateVersion ?? version} 已下载好，退出应用时自动静默安装${idleNote}`)
      return
    }
    promptInstallDownloaded(downloadedUpdateVersion ?? version)
  })

  autoUpdater.on("error", (err) => {
    // 空闲自动重启已经发起、安装器却没能接手：应用还活着，撤销重启记号，之后（有限次数地）再试
    if (idleRestartTriggered) {
      idleRestartTriggered = false
      idleRestartProbes?.cancelRestart()
      silentLog(`自动重启安装没有成功：${err.message}`, "WARN")
    }
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      reportWinDownloadFailure(err)
    }
    getMainWindow()?.webContents.send("updater:error", err.message)
  })
}

function applyHintForPlatform(): string {
  if (process.platform === "darwin") {
    return "可在下一步确认后开始更新。"
  }
  if (process.platform === "win32") {
    return "将下载并安装，完成后按提示重启。"
  }
  return "将打开下载页面。"
}

async function runStartupUpdateCheck(): Promise<void> {
  if (!app.isPackaged && !isDevSimulateUpdate()) {
    return
  }
  if (isSilentUpdateEnabled()) {
    await runSilentUpdateCycle("启动")
    return
  }
  if (!isAutoUpgradePromptEnabled()) {
    if (!isDevSimulateUpdate()) {
      lastKnownRemote = await fetchLatestRelease()
    }
    return
  }

  const simulate = isDevSimulateUpdate()
  let rel: LatestRelease | null

  if (simulate) {
    rel = fakeLatestReleaseForDev()
    lastKnownRemote = rel
  } else {
    rel = await fetchLatestRelease()
    lastKnownRemote = rel
    if (!rel) {
      return
    }
    const cur0 = app.getVersion()
    if (!semver.gt(rel.version, cur0)) {
      return
    }
  }

  const cur = app.getVersion()
  const simSuffix = simulate ? devSimulateDetailSuffix() : ""

  const notes = simulate
    ? buildReleaseNotes(
        [{ version: DEV_FAKE_LATEST_VERSION, date: "", changes: ["模拟更新内容", "用于开发测试"] }],
        cur,
      )
    : await resolveReleaseNotes(cur, rel)
  const notesDetail = notes ? `\n\n更新内容：\n${notes}` : ""

  if (process.platform === "darwin") {
    const r = await showAppModal({
      variant: "info",
      title: "发现新版本",
      message: `新版本 v${rel.version}，当前 v${cur}。`,
      detail: "是否现在更新？" + notesDetail + simSuffix,
      buttons: ["稍后", "立即更新"],
      defaultId: 1,
      cancelId: 0,
    })
    if (r !== 1) {
      return
    }
    if (simulate) {
      await showAppModal({
        variant: "info",
        title: "提示",
        message: "开发测试：未执行真实更新。",
        buttons: ["确定"],
        defaultId: 0,
      })
      return
    }
    const result = await runBrewUpgrade(rel.version)
    const choice = await showAppModal({
      variant: result.ok ? "info" : "error",
      title: result.ok ? "完成" : "更新失败",
      message: result.ok ? (result.message ?? "请重启应用。") : (result.error ?? "未知错误"),
      buttons: result.downloadUrl ? ["关闭", "下载安装包"] : ["确定"],
      defaultId: result.downloadUrl ? 1 : 0,
      cancelId: 0,
    })
    if (choice === 1 && result.downloadUrl) {
      await shell.openExternal(result.downloadUrl)
    }
    return
  }

  if (process.platform === "win32") {
    const r = await showAppModal({
      variant: "info",
      title: "发现新版本",
      message: `新版本 v${rel.version}，当前 v${cur}。`,
      detail: "是否下载并安装？" + notesDetail + simSuffix,
      buttons: ["稍后", "下载并安装"],
      defaultId: 1,
      cancelId: 0,
    })
    if (r !== 1) {
      return
    }
    if (simulate) {
      await showAppModal({
        variant: "info",
        title: "提示",
        message: "开发测试：未执行真实更新。",
        buttons: ["确定"],
        defaultId: 0,
      })
      return
    }
    winDownloadRequested = true
    clearUpdaterCache()
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      winDownloadRequested = false
      await showWinDownloadFallback(e)
    }
    return
  }

  const r = await showAppModal({
    variant: "info",
    title: "发现新版本",
    message: `新版本 v${rel.version}，当前 v${cur}。`,
    detail: "是否在浏览器中打开下载页？" + notesDetail + simSuffix,
    buttons: ["稍后", "打开下载页"],
    defaultId: 1,
    cancelId: 0,
  })
  if (r === 1) {
    await shell.openExternal(rel.htmlUrl)
  }
}

export function registerUpdaterIpc(): void {
  if (updaterIpcRegistered) {
    return
  }
  updaterIpcRegistered = true

  ipcMain.handle("app:modal-result", (_, payload: { requestId: string; response: number }) => {
    const fn = pendingModalResolvers.get(payload.requestId)
    if (fn) {
      pendingModalResolvers.delete(payload.requestId)
      fn(payload.response)
    }
  })

  ipcMain.handle("updater:current-version", () => app.getVersion())

  ipcMain.handle("updater:check", async (): Promise<UpdaterCheckResult> => {
    const currentVersion = app.getVersion()
    if (!app.isPackaged) {
      if (isDevSimulateUpdate()) {
        lastKnownRemote = fakeLatestReleaseForDev()
        const fakeNotes = buildReleaseNotes(
          [{ version: DEV_FAKE_LATEST_VERSION, date: "", changes: ["模拟更新内容", "用于开发测试"] }],
          currentVersion,
        )
        return {
          status: "available",
          currentVersion,
          latestVersion: DEV_FAKE_LATEST_VERSION,
          htmlUrl: lastKnownRemote.htmlUrl,
          applyHint: applyHintForPlatform(),
          releaseNotes: fakeNotes,
        }
      }
      return {
        status: "dev",
        currentVersion,
        message: "开发版本不检查更新。",
      }
    }
    const rel = await fetchLatestRelease()
    if (!rel) {
      return {
        status: "error",
        currentVersion,
        message: "检查失败：无法访问版本源。请到「设置 → 网络」配置代理后重试；若已开系统代理/TUN，确认对本应用生效。",
      }
    }
    lastKnownRemote = rel
    if (semver.gt(rel.version, currentVersion)) {
      const res = await buildAvailableOrReadyResult(currentVersion, rel)
      if (isSilentUpdateEnabled()) {
        if (installReadyVersion && semver.gte(installReadyVersion, rel.version)) {
          return { ...res, status: "ready" }
        }
        void runSilentUpdateCycle("检查更新", rel)
      }
      return res
    }
    return {
      status: "latest",
      currentVersion,
      // 版本源缓存可能滞后于本机（远端 < 当前），此时「最新」就是当前版本，不显示旧远端号
      latestVersion: semver.gt(currentVersion, rel.version) ? currentVersion : rel.version,
    }
  })

  ipcMain.handle("updater:apply", async (): Promise<UpdaterApplyResult> => {
    if (!app.isPackaged) {
      if (isDevSimulateUpdate()) {
        return {
          ok: true,
          message: "开发测试：未执行真实更新。",
        }
      }
      return { ok: false, error: "开发版本无法更新。" }
    }
    const currentVersion = app.getVersion()
    const rel = lastKnownRemote ?? (await fetchLatestRelease())
    if (rel) {
      lastKnownRemote = rel
    }
    if (!rel) {
      return {
        ok: false,
        error: "无法获取远程版本信息。\n请到「设置 → 网络」配置代理后重试。",
      }
    }
    if (!semver.gt(rel.version, currentVersion)) {
      return { ok: false, error: "当前已是最新版本" }
    }

    if (process.platform === "darwin") {
      return runBrewUpgrade(rel.version)
    }

    if (isSilentUpdateEnabled()) {
      if (installReadyVersion && semver.gte(installReadyVersion, rel.version)) {
        silentLog(`立即安装 v${installReadyVersion}`)
        autoUpdater.quitAndInstall(true, true)
        return { ok: true, message: "正在静默安装并重启…" }
      }
      // 后台正在下：别再起第二路
      if (silentRunActive || winDownloadRequested || activeWinDownload) {
        return { ok: true, message: "正在后台下载更新，下好后点「立即安装」，或退出应用时自动安装。" }
      }
    }

    if (process.platform === "win32") {
      await invalidateStaleDownload(rel)
      const cached = readCachedDownloadVersion()
      if (cached && semver.eq(cached, rel.version)) {
        autoUpdater.quitAndInstall(false, true)
        return { ok: true, message: "正在安装并重启…" }
      }
      winDownloadRequested = true
      clearUpdaterCache()
      try {
        await autoUpdater.checkForUpdates()
        return { ok: true, message: "正在下载…" }
      } catch (e) {
        winDownloadRequested = false
        const msg = e instanceof Error ? e.message : String(e)
        const ver = rel.version
        const dlUrl = manualUpdateUrl(ver)
        return {
          ok: false,
          error: [
            msg,
            "",
            "可能原因: 安装包托管在 GitHub，直接访问可能被墙。",
            `手动下载: ${dlUrl}`,
          ].join("\n"),
        }
      }
    }

    await shell.openExternal(rel.htmlUrl)
    return { ok: true, message: "已打开下载页。" }
  })
}

export function initAppUpdater(getMainWindow: () => BrowserWindow | null, idleProbes?: IdleRestartProbes): void {
  mainWindowGetter = getMainWindow
  idleRestartProbes = idleProbes ?? null
  registerUpdaterIpc()
  wireAutoUpdater()
  void applyAppNetworkProxy()
  if (app.isPackaged || isDevSimulateUpdate()) {
    setTimeout(() => {
      void runStartupUpdateCheck()
    }, STARTUP_CHECK_DELAY_MS)
  }
  if (app.isPackaged) {
    // 静默更新：应用常驻托盘、几天不重启时，只靠启动那一次查不到后来发的版本。开关没开时这一轮什么都不做
    setInterval(() => {
      void runSilentUpdateCycle("定时")
    }, SILENT_CHECK_INTERVAL_MS).unref()
    // 空闲时自动重启安装：每分钟看一眼，没开或没有下好的版本时什么都不查
    setInterval(() => {
      void runIdleRestartCheck()
    }, IDLE_RESTART_CHECK_INTERVAL_MS).unref()
  }
}
