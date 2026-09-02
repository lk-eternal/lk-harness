import { app, BrowserWindow, dialog, ipcMain, shell, net, session } from "electron"
import electronUpdater from "electron-updater"
import type { AppUpdater } from "electron-updater"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import * as path from "node:path"
import semver from "semver"
import { getConfig } from "./config-store"
import { syncMainProcessProxyEnv } from "./agent-env"

const execFileAsync = promisify(execFile)

const autoUpdater: AppUpdater = (electronUpdater as { autoUpdater: AppUpdater }).autoUpdater

const GITHUB_OWNER = "lk-eternal"
const GITHUB_REPO = "lk-harness"
const HOMEBREW_TAP = "lk-eternal/tap"
const HOMEBREW_CASK = "lk-harness"

const STARTUP_CHECK_DELAY_MS = 4_000

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
}

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let winDownloadRequested = false
let lastKnownRemote: LatestRelease | null = null
let autoUpdaterWired = false
let updaterIpcRegistered = false
let downloadedUpdateVersion: string | null = null

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

function promptInstallDownloaded(version: string): void {
  if (!isAutoUpgradePromptEnabled()) {
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
export async function applyAppNetworkProxy(): Promise<void> {
  const config = getConfig()
  syncMainProcessProxyEnv(config)
  const proxy = (config.httpsProxy || config.httpProxy || "").trim()
  const bypass = (config.noProxy || "localhost,127.0.0.1,<local>").trim()
  try {
    if (proxy) {
      await session.defaultSession.setProxy({ proxyRules: proxy, proxyBypassRules: bypass })
    } else {
      await session.defaultSession.setProxy({ mode: "system" })
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

const BREW_MANUAL_GUIDE = [
  "手动更新方法（在终端中执行）：",
  `  brew untap ${HOMEBREW_TAP}`,
  `  brew tap ${HOMEBREW_TAP}`,
  `  brew upgrade --cask ${HOMEBREW_CASK}`,
  "  xattr -cr /Applications/Cursor\\ Claw.app",
  "",
  `FAQ: https://github.com/${HOMEBREW_TAP}`,
].join("\n")

async function runBrewUpgrade(): Promise<UpdaterApplyResult> {
  const brew = getBrewExecutable()
  if (!brew) {
    return { ok: false, error: `未找到 Homebrew（/opt/homebrew 或 /usr/local）\n\n${BREW_MANUAL_GUIDE}` }
  }
  const brewEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
  }
  try {
    await execFileAsync(brew, ["tap", HOMEBREW_TAP], { timeout: 120_000, env: brewEnv })
    await execFileAsync(brew, ["update"], { timeout: 300_000, env: brewEnv })
    await execFileAsync(brew, ["upgrade", "--cask", HOMEBREW_CASK], { timeout: 600_000, env: brewEnv })
    return {
      ok: true,
      message: "更新已完成，请重启应用。",
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `brew 执行失败：${msg}\n\n${BREW_MANUAL_GUIDE}` }
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
  const detail = [
    `错误: ${errMsg}`,
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

function wireAutoUpdater(): void {
  if (autoUpdaterWired || !app.isPackaged) {
    return
  }
  autoUpdaterWired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on("update-available", () => {
    getMainWindow()?.webContents.send("updater:status", { kind: "available" as const })
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      getMainWindow()?.webContents.send("updater:status", { kind: "downloading" as const })
      void autoUpdater.downloadUpdate().catch((err: unknown) => {
        void showWinDownloadFallback(err)
      })
    }
  })

  autoUpdater.on("update-not-available", () => {
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      void showWinDownloadFallback(new Error("未找到可用更新"))
    }
  })

  autoUpdater.on("download-progress", (p) => {
    getMainWindow()?.webContents.send("updater:progress", p.percent)
  })

  autoUpdater.on("update-downloaded", (info) => {
    const version = normalizeReleaseVersion(info.version)
    downloadedUpdateVersion = semver.valid(version) ? version : null
    getMainWindow()?.webContents.send("updater:status", {
      kind: "downloaded" as const,
      version: downloadedUpdateVersion ?? version,
    })
    promptInstallDownloaded(downloadedUpdateVersion ?? version)
  })

  autoUpdater.on("error", (err) => {
    if (winDownloadRequested && process.platform === "win32") {
      winDownloadRequested = false
      void showWinDownloadFallback(err)
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
    const result = await runBrewUpgrade()
    await showAppModal({
      variant: result.ok ? "info" : "error",
      title: result.ok ? "完成" : "更新失败",
      message: result.ok ? (result.message ?? "请重启应用。") : (result.error ?? "未知错误"),
      buttons: ["确定"],
      defaultId: 0,
    })
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
      return buildAvailableOrReadyResult(currentVersion, rel)
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
      return runBrewUpgrade()
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

export function initAppUpdater(getMainWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getMainWindow
  registerUpdaterIpc()
  wireAutoUpdater()
  void applyAppNetworkProxy()
  if (app.isPackaged || isDevSimulateUpdate()) {
    setTimeout(() => {
      void runStartupUpdateCheck()
    }, STARTUP_CHECK_DELAY_MS)
  }
}
