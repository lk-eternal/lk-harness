/**
 * macOS 上 dmg 安装的应用内更新（brew 装的不走这里，见 brew-update.ts 的 detectMacInstallMethod）。
 *
 * 为什么不用 electron-updater：它在 mac 上走 Squirrel.Mac，要求应用做过代码签名并发布 zip；
 * 我们的 mac 包只有 dmg、没有签名。所以这里自己做一遍最小的流程：
 *   下载 dmg（断点续传 + sha512）→ 挂载 → 拷出 .app 放到旧应用旁边的暂存目录 → 核对版本
 *   → 用户确认后应用退出 → 独立脚本把旧应用换成新应用 → 重新打开。
 * 任何一步失败都不动旧应用，由调用方退回「手动下载 dmg」。
 *
 * 这个文件不依赖 electron，命令执行、文件系统都可以注入，方便单测；真实的挂载、拷贝只能在 macOS 上跑。
 */

import { execFile, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import semver from "semver"
import { parse as parseYaml } from "yaml"
import { macInstallerUrl } from "./brew-update"
import {
  downloadWithResume,
  errorMessage,
  sha512Base64,
  type ResumableDownloadOptions,
} from "./resumable-download"

/** 暂存目录：放在旧应用旁边（同一个卷，最后换位置是改名，一步到位）。点开头，不会被当成应用，也不显示在 Finder 里 */
export const MAC_STAGE_DIRNAME = ".LK-Harness-update"
/** 下载的 dmg、替换脚本、结果文件放在 `<userData>/mac-update` */
export const MAC_WORK_DIRNAME = "mac-update"

const SWAP_SCRIPT_NAME = "apply-update.sh"
const SWAP_RESULT_NAME = "apply-result.txt"
/** 一次更新最多占用的空间，按 dmg 大小的倍数算：dmg 本身（压缩的）不算，暂存的新应用解压后约是 dmg 的 2 倍多，再留余量 */
const FREE_SPACE_FACTOR = 3

const HDIUTIL = "/usr/bin/hdiutil"
const DITTO = "/usr/bin/ditto"
const XATTR = "/usr/bin/xattr"
const PLUTIL = "/usr/bin/plutil"

// ── latest-mac.yml ────────────────────────────────────────────────

export interface MacDmgEntry {
  fileName: string
  url: string
  /** base64 的 sha512，和 latest-mac.yml 里一致 */
  sha512: string
  size?: number
}

export interface MacSourceOptions {
  version: string
  arch: string
  releasesBase: string
  /** 测试用的更新源（环境变量 LK_MAC_UPDATE_FEED）：latest-mac.yml 和 dmg 都从这里取，不走 GitHub */
  feedBase?: string | null
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "")
}

/** latest-mac.yml 的下载地址 */
export function macYmlUrl(opts: Pick<MacSourceOptions, "version" | "releasesBase" | "feedBase">): string {
  return opts.feedBase
    ? `${trimSlash(opts.feedBase)}/latest-mac.yml`
    : `${trimSlash(opts.releasesBase)}/download/v${opts.version}/latest-mac.yml`
}

interface YmlFile {
  url?: unknown
  sha512?: unknown
  size?: unknown
}

/** 从 latest-mac.yml 里读出版本号（给测试用的更新源用，正式流程版本号来自 GitHub Release） */
export function readMacYmlVersion(ymlText: string): string | null {
  try {
    const doc = parseYaml(ymlText) as { version?: unknown } | null
    const v = doc && doc.version !== undefined ? String(doc.version) : ""
    return semver.valid(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 在 latest-mac.yml 里找本机芯片对应的 dmg。
 *
 * yml 里的地址是 `LK-Harness-1.4.3.dmg`（空格换成 `-`），而 GitHub 上真实的资源名是 `LK.Harness-1.4.3.dmg`
 * （上传时空格换成了 `.`），照 yml 的地址去下会 404。所以只信 yml 里的 sha512 和大小，
 * 下载地址仍用 macInstallerUrl（和手动下载同一个）。yml 里的版本号和要装的版本对不上也不用，免得装错版本。
 */
export function pickMacDmg(ymlText: string, opts: MacSourceOptions): MacDmgEntry | null {
  let doc: unknown
  try {
    doc = parseYaml(ymlText)
  } catch {
    return null
  }
  if (!doc || typeof doc !== "object") return null
  const d = doc as { version?: unknown; files?: unknown; path?: unknown; sha512?: unknown }
  if (d.version === undefined || String(d.version) !== opts.version) return null

  const files: YmlFile[] =
    Array.isArray(d.files) && d.files.length > 0
      ? (d.files as YmlFile[])
      : typeof d.path === "string" && typeof d.sha512 === "string"
        ? [{ url: d.path, sha512: d.sha512 }]
        : []

  const wantArm = opts.arch === "arm64"
  const hit = files.find((f) => {
    if (!f || typeof f.url !== "string" || typeof f.sha512 !== "string" || !f.sha512) return false
    const name = f.url.split(/[?#]/)[0]
    return /\.dmg$/i.test(name) && /-arm64\.dmg$/i.test(name) === wantArm
  })
  if (!hit) return null

  const ymlName = path.posix.basename((hit.url as string).split(/[?#]/)[0])
  const url = opts.feedBase
    ? `${trimSlash(opts.feedBase)}/${encodeURIComponent(ymlName)}`
    : macInstallerUrl(opts.releasesBase, opts.version, wantArm ? "arm64" : "x64")
  const size = typeof hit.size === "number" && hit.size > 0 ? hit.size : undefined
  return {
    fileName: opts.feedBase ? ymlName : path.posix.basename(url),
    url,
    sha512: hit.sha512 as string,
    size,
  }
}

// ── 安装位置 ──────────────────────────────────────────────────────

/** 从主程序路径找出所在的 .app（取最外层的那个）。`/Applications/LK Harness.app/Contents/MacOS/LK Harness` → `/Applications/LK Harness.app` */
export function locateAppBundle(exePath: string): string | null {
  const parts = exePath.split("/")
  const idx = parts.findIndex((p, i) => i > 0 && p.toLowerCase().endsWith(".app"))
  if (idx < 0) return null
  return parts.slice(0, idx + 1).join("/")
}

export type InstallBlockReason = "no-bundle" | "translocated" | "not-writable" | "low-disk"

export type InstallCheck =
  | { ok: true; bundle: string; installDir: string }
  | { ok: false; reason: InstallBlockReason; message: string }

export interface InstallIo {
  realpath(p: string): Promise<string>
  canWrite(dir: string): Promise<boolean>
  /** 目录所在卷还剩多少字节；取不到为 null */
  freeBytes(dir: string): Promise<number | null>
}

export const nodeInstallIo: InstallIo = {
  realpath: (p) => fs.promises.realpath(p),
  canWrite: async (dir) => {
    try {
      await fs.promises.access(dir, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  freeBytes: async (dir) => {
    try {
      const s = await fs.promises.statfs(dir)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      return null
    }
  },
}

/**
 * 能不能原地换掉这份应用。换位置要在旧应用所在的文件夹里改名，所以需要那个文件夹的写入权限；
 * 从 dmg 里直接运行、或刚从「下载」里打开时，系统会把应用放到一个只读的随机路径（App Translocation），也换不了。
 * 不满足时给出能照着做的原因，由调用方退回手动下载。
 */
export async function checkMacInstallTarget(
  bundlePath: string | null,
  io: InstallIo,
  dmgSize: number | undefined,
): Promise<InstallCheck> {
  if (!bundlePath) {
    return { ok: false, reason: "no-bundle", message: "找不到应用自己的位置（不是从 .app 里运行的）。" }
  }
  let real: string
  try {
    real = await io.realpath(bundlePath)
  } catch (e) {
    return { ok: false, reason: "no-bundle", message: `读不到应用的位置：${errorMessage(e)}` }
  }
  if (real.includes("/AppTranslocation/")) {
    return {
      ok: false,
      reason: "translocated",
      message: "应用现在运行在系统的临时只读位置（刚从 dmg 或「下载」文件夹里直接打开的）。请先把它拖进「应用程序」，再从那里打开。",
    }
  }
  const installDir = path.posix.dirname(real)
  if (!(await io.canWrite(installDir))) {
    return {
      ok: false,
      reason: "not-writable",
      message: `当前账号没有「${installDir}」的写入权限（不是管理员账号，或者放在了只读的位置），应用没法自己替换自己。`,
    }
  }
  if (dmgSize !== undefined) {
    const free = await io.freeBytes(installDir)
    const need = dmgSize * FREE_SPACE_FACTOR
    if (free !== null && free < need) {
      const mb = (n: number) => Math.round(n / 1024 / 1024)
      return {
        ok: false,
        reason: "low-disk",
        message: `磁盘空间不够：「${installDir}」所在的磁盘还剩 ${mb(free)} MB，更新需要约 ${mb(need)} MB。`,
      }
    }
  }
  return { ok: true, bundle: real, installDir }
}

// ── 下载 ──────────────────────────────────────────────────────────

export interface MacDownloadOptions
  extends Pick<
    ResumableDownloadOptions,
    | "fetchImpl"
    | "headers"
    | "maxConsecutiveFailures"
    | "maxAttempts"
    | "stallTimeoutMs"
    | "minProgressBytes"
    | "retryDelayMs"
    | "sleep"
    | "onProgress"
    | "onRetry"
  > {
  dir: string
  entry: MacDmgEntry
}

export interface MacDownloadResult {
  file: string
  /** 目录里已经有校验通过的 dmg，没有再下载 */
  reusedExisting: boolean
  attempts: number
}

const DMG_FILE_RE = /^(?:.+)\.dmg(?:\.part)?$/i

/** 下载 dmg 到 dir。续传、重试、sha512 校验都在 downloadWithResume 里；这里只管复用已有的成品、清掉别的版本的 dmg */
export async function downloadMacDmg(opts: MacDownloadOptions): Promise<MacDownloadResult> {
  const { dir, entry, ...download } = opts
  await fs.promises.mkdir(dir, { recursive: true })
  const keep = new Set([entry.fileName, `${entry.fileName}.part`])
  for (const name of await fs.promises.readdir(dir)) {
    if (DMG_FILE_RE.test(name) && !keep.has(name)) {
      await fs.promises.rm(path.join(dir, name), { force: true })
    }
  }

  const file = path.join(dir, entry.fileName)
  try {
    await fs.promises.access(file)
    if ((await sha512Base64(file)) === entry.sha512) return { file, reusedExisting: true, attempts: 0 }
    await fs.promises.rm(file, { force: true })
  } catch {
    /* 还没有成品 */
  }

  const { attempts } = await downloadWithResume({
    ...download,
    url: entry.url,
    destination: file,
    expectedSize: entry.size,
    sha512: entry.sha512,
  })
  return { file, reusedExisting: false, attempts }
}

// ── 挂载、拷出、核对 ──────────────────────────────────────────────

/** 执行一条系统命令，返回 stdout；失败抛出带 stderr 的错误 */
export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

export const execRun: RunFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(String(stdout))
        return
      }
      const detail = String(stderr || err.message).trim().split("\n").slice(-3).join(" ")
      reject(new Error(`${path.basename(cmd)} ${args[0] ?? ""} 失败：${detail}`))
    })
  })

export interface PrepareOptions {
  dmgPath: string
  /** `<userData>/mac-update`：挂载点建在这里 */
  workDir: string
  /** 正在运行的应用（已解开符号链接的真实路径） */
  targetBundle: string
  version: string
  run: RunFn
}

export interface PreparedUpdate {
  /** 暂存好的新应用 */
  stagedApp: string
  stageDir: string
}

async function findAppInDir(dir: string, preferredName: string): Promise<string | null> {
  const apps = (await fs.promises.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.toLowerCase().endsWith(".app"))
    .map((e) => e.name)
  if (apps.includes(preferredName)) return preferredName
  return apps[0] ?? null
}

async function detach(run: RunFn, mountDir: string): Promise<void> {
  try {
    await run(HDIUTIL, ["detach", mountDir], 60_000)
  } catch {
    // 刚拷完文件有时还有进程占着，强制卸载
    await run(HDIUTIL, ["detach", "-force", mountDir], 60_000).catch(() => undefined)
  }
}

/**
 * 把 dmg 里的新应用拷到旧应用旁边的暂存目录，并核对版本号。
 *
 * 挂载点建在自己的目录里（不占 /Volumes，也不会和用户手动挂的同名卷冲突），`-nobrowse` 不在 Finder 里出现。
 * `-noverify` 跳过 dmg 自带的校验：整个文件的 sha512 已经对过了。
 * 拷贝用 ditto：保留符号链接、权限和扩展属性，应用里的签名（arm64 至少是临时签名）不会被破坏。
 * 失败时清掉暂存目录；无论成败都卸载 dmg。
 */
export async function prepareMacApp(opts: PrepareOptions): Promise<PreparedUpdate> {
  const { dmgPath, workDir, targetBundle, version, run } = opts
  const stageDir = path.join(path.dirname(targetBundle), MAC_STAGE_DIRNAME)
  await fs.promises.rm(stageDir, { recursive: true, force: true })
  await fs.promises.mkdir(stageDir, { recursive: true })
  await fs.promises.mkdir(workDir, { recursive: true })
  const mountDir = await fs.promises.mkdtemp(path.join(workDir, "mnt-"))
  let mounted = false
  try {
    await run(
      HDIUTIL,
      ["attach", dmgPath, "-nobrowse", "-readonly", "-noautoopen", "-noverify", "-mountpoint", mountDir],
      180_000,
    )
    mounted = true

    const appName = await findAppInDir(mountDir, path.basename(targetBundle))
    if (!appName) throw new Error("安装包里没有找到 .app")
    const stagedApp = path.join(stageDir, path.basename(targetBundle))
    await run(DITTO, [path.join(mountDir, appName), stagedApp], 900_000)
    // 自己下载的文件本来就没有隔离标记；清一遍只是保险，清不掉也不影响
    await run(XATTR, ["-dr", "com.apple.quarantine", stagedApp], 60_000).catch(() => undefined)

    const plist = path.join(stagedApp, "Contents", "Info.plist")
    const got = (await run(PLUTIL, ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], 30_000)).trim()
    if (got !== version) throw new Error(`安装包里的版本是 ${got || "（读不到）"}，不是预期的 ${version}`)
    return { stagedApp, stageDir }
  } catch (e) {
    await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    throw e
  } finally {
    if (mounted) await detach(run, mountDir)
    // 用 rmdir 不用递归删除：万一没卸载掉，不能顺着挂载点去删 dmg 里的东西
    await fs.promises.rmdir(mountDir).catch(() => undefined)
  }
}

// ── 替换并重新打开 ────────────────────────────────────────────────

/**
 * 退出后执行的替换脚本。参数：应用进程号、暂存的新应用、旧应用路径、暂存目录、结果文件、版本、打开命令。
 *
 * 顺序：等应用退出（最多 90 秒）→ 旧应用改名挪进暂存目录 → 新应用改名到旧位置 → 删暂存目录 → 重新打开。
 * 改名都在同一个文件夹里，不会出现「新应用只拷了一半」；第二步失败就把旧应用挪回去。
 * 无论成败都会重新打开应用（失败时打开的是旧版），结果写进结果文件，下次启动时读出来告诉用户。
 */
export function swapScriptText(): string {
  // 模板字面量里的换行规范上就是 LF；这里再兜一道：脚本里混进 \r 的话 macOS 的 sh 会直接报语法错
  return SWAP_SCRIPT.replace(/\r\n/g, "\n")
}

const SWAP_SCRIPT = `#!/bin/sh
# LK Harness 应用内更新（macOS）：等应用退出，把暂存好的新版本换到原位置，再重新打开。
# 参数：进程号 新应用 旧应用 暂存目录 结果文件 版本 [打开命令]
PATH=/usr/bin:/bin:/usr/sbin:/sbin
PID="$1"
NEW="$2"
TARGET="$3"
STAGE="$4"
RESULT="$5"
VERSION="$6"
OPEN_CMD="\${7:-/usr/bin/open}"
LOG="$RESULT.log"

say() { printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
finish() { printf '%s\\n%s\\n%s\\n' "$1" "$2" "$VERSION" > "$RESULT"; say "$1: $2"; }
reopen() { "$OPEN_CMD" "$TARGET" >> "$LOG" 2>&1 || say "重新打开失败: $TARGET"; }

say "开始替换 v$VERSION: $TARGET"

if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  waited=0
  while kill -0 "$PID" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 180 ]; then
      finish failed "应用在 90 秒内没有退出，没有替换"
      exit 1
    fi
    sleep 0.5
  done
  sleep 1
fi

if [ ! -d "$NEW" ]; then
  finish failed "暂存的新版本不见了: $NEW"
  reopen
  exit 1
fi

PREV="$STAGE/previous"
rm -rf "$PREV"
if ! mkdir -p "$PREV"; then
  finish failed "无法创建 $PREV"
  reopen
  exit 1
fi

if ! mv "$TARGET" "$PREV/old.app" 2>> "$LOG"; then
  finish failed "无法移开旧版本（没有权限？）"
  reopen
  exit 1
fi

if ! mv "$NEW" "$TARGET" 2>> "$LOG"; then
  if mv "$PREV/old.app" "$TARGET" 2>> "$LOG"; then
    finish failed "无法把新版本放到位，已还原旧版本"
  else
    finish failed "无法把新版本放到位，也没能还原，旧版本在 $PREV/old.app"
  fi
  reopen
  exit 1
fi

rm -rf "$STAGE"
finish ok "已更新到 v$VERSION"
reopen
`

export interface SwapLaunchOptions {
  workDir: string
  /** 要等它退出的进程（应用自己的主进程） */
  pid: number
  version: string
  stagedApp: string
  targetBundle: string
  stageDir: string
  /** 测试用：替换默认的 /bin/sh 和 /usr/bin/open */
  shell?: string
  openCmd?: string
}

/** 写好替换脚本并以独立进程启动（应用退出后它继续跑）。启动本身失败才抛错 */
export async function launchMacSwap(opts: SwapLaunchOptions): Promise<{ scriptPath: string; resultPath: string }> {
  await fs.promises.mkdir(opts.workDir, { recursive: true })
  const scriptPath = path.join(opts.workDir, SWAP_SCRIPT_NAME)
  const resultPath = path.join(opts.workDir, SWAP_RESULT_NAME)
  await fs.promises.writeFile(scriptPath, swapScriptText(), { mode: 0o755 })
  await fs.promises.rm(resultPath, { force: true })

  const args = [
    scriptPath,
    String(opts.pid),
    opts.stagedApp,
    opts.targetBundle,
    opts.stageDir,
    resultPath,
    opts.version,
    ...(opts.openCmd ? [opts.openCmd] : []),
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.shell ?? "/bin/sh", args, { detached: true, stdio: "ignore" })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
  return { scriptPath, resultPath }
}

export interface SwapOutcome {
  ok: boolean
  detail: string
  version: string
}

/** 读出上次替换脚本留下的结果（读完就删，只报一次）。没有结果文件说明上次没做过应用内更新 */
export async function consumeSwapResult(workDir: string): Promise<SwapOutcome | null> {
  const resultPath = path.join(workDir, SWAP_RESULT_NAME)
  let text: string
  try {
    text = await fs.promises.readFile(resultPath, "utf-8")
  } catch {
    return null
  }
  await fs.promises.rm(resultPath, { force: true }).catch(() => undefined)
  const [status = "", detail = "", version = ""] = text.replace(/\r/g, "").split("\n")
  return { ok: status.trim() === "ok", detail: detail.trim(), version: version.trim() }
}

// ── 启动时善后 ────────────────────────────────────────────────────

export interface CleanupOptions {
  workDir: string
  currentVersion: string
  /** 正在运行的应用（真实路径）；找不到为 null */
  bundle: string | null
}

/** dmg 文件名里的版本号：`LK.Harness-1.4.4-arm64.dmg.part` → 1.4.4 */
function dmgVersion(name: string): string | null {
  const m = /^.+?-(\d+\.\d+\.\d+.*?)(?:-arm64)?\.dmg(?:\.part)?$/i.exec(name)
  return m && semver.valid(m[1]) ? m[1] : null
}

/**
 * 应用启动时清理上次更新留下的东西，返回清掉了什么（写日志用）：
 * - 旧应用旁边的暂存目录（内存里的「已准备好」状态不跨重启，留着只占空间）；
 * - 版本不高于当前版本的 dmg（已经装上了，或是更老的）；
 * - 没卸载干净留下的空挂载点目录。
 */
export async function cleanupMacUpdateLeftovers(opts: CleanupOptions): Promise<string[]> {
  const removed: string[] = []
  if (opts.bundle) {
    const stageDir = path.join(path.dirname(opts.bundle), MAC_STAGE_DIRNAME)
    try {
      await fs.promises.access(stageDir)
      await fs.promises.rm(stageDir, { recursive: true, force: true })
      removed.push(stageDir)
    } catch {
      /* 没有，或者清不掉（没权限）：下次再说 */
    }
  }
  let names: string[] = []
  try {
    names = await fs.promises.readdir(opts.workDir)
  } catch {
    return removed
  }
  for (const name of names) {
    const full = path.join(opts.workDir, name)
    if (name.startsWith("mnt-")) {
      if (await fs.promises.rmdir(full).then(() => true, () => false)) removed.push(full)
      continue
    }
    const v = dmgVersion(name)
    if (v && semver.valid(opts.currentVersion) && semver.lte(v, opts.currentVersion)) {
      await fs.promises.rm(full, { force: true })
      removed.push(full)
    }
  }
  return removed
}
