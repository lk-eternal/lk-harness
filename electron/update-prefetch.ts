import * as fs from "node:fs"
import * as path from "node:path"
import {
  downloadWithResume,
  errorMessage,
  sha512Base64,
  type ResumableDownloadOptions,
  type RetryInfo,
} from "./resumable-download"

/**
 * 把新版安装包「预取」进 electron-updater 的缓存目录（`<缓存>/pending`）。
 *
 * electron-updater 的 `downloadUpdate()` 会先校验缓存：`pending/update-info.json` 里的 sha512 与 latest.yml 一致、
 * 同名安装包存在且 sha512 吻合，就直接当作「已下载」触发 update-downloaded，不再自己去下载。
 * 所以我们先用带续传和重试的下载把文件放到位、写好 update-info.json，再调它的 `downloadUpdate()` 收尾，
 * 之后的「安装并重启」「下次启动安装」都沿用它的原有流程。
 */

export interface UpdateFileLike {
  url: string
  sha512: string
  size?: number
  isAdminRightsRequired?: boolean
}

export interface UpdateInfoLike {
  version: string
  /** GitHubProvider 解析出来的 tag（如 v1.1.3） */
  tag?: string
  files?: UpdateFileLike[]
  path?: string
  sha512?: string
}

export interface InstallerEntry {
  fileName: string
  url: string
  sha512: string
  size?: number
  isAdminRightsRequired: boolean
}

const INFO_FILE = "update-info.json"

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/**
 * 在 latest.yml 的文件列表里找 Windows 安装包，并算出下载地址与缓存文件名。
 * 规则与 electron-updater 的 GitHubProvider 一致：`<releases>/download/<tag>/<文件名>`，文件名里的空格换成 `-`；
 * 缓存文件名取下载地址路径的最后一段。
 */
export function pickWindowsInstaller(info: UpdateInfoLike, releasesBase: string): InstallerEntry | null {
  const tag = info.tag ?? `v${info.version}`
  const files: UpdateFileLike[] = info.files?.length
    ? info.files
    : info.path && info.sha512
      ? [{ url: info.path, sha512: info.sha512 }]
      : []
  const file = files.find((f) => {
    const name = f.url.split(/[?#]/)[0].toLowerCase()
    return name.endsWith(".exe") && !!f.sha512
  })
  if (!file) return null

  let resolved: URL
  try {
    resolved = isAbsoluteHttpUrl(file.url)
      ? new URL(file.url)
      : new URL(`${releasesBase.replace(/\/+$/, "")}/download/${tag}/${file.url.replace(/ /g, "-")}`)
  } catch {
    return null
  }
  const fileName = path.posix.basename(decodeURIComponent(resolved.pathname))
  if (!fileName) return null
  return {
    fileName,
    url: resolved.toString(),
    sha512: file.sha512,
    size: typeof file.size === "number" && file.size > 0 ? file.size : undefined,
    isAdminRightsRequired: file.isAdminRightsRequired === true,
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file)
    return true
  } catch {
    return false
  }
}

async function readInfoFile(pendingDir: string): Promise<{ fileName?: string; sha512?: string } | null> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(pendingDir, INFO_FILE), "utf-8")) as {
      fileName?: string
      sha512?: string
    }
  } catch {
    return null
  }
}

async function writeInfoFile(pendingDir: string, entry: InstallerEntry): Promise<void> {
  // 字段与 electron-updater 的 DownloadedUpdateHelper.setDownloadedFile 写的一致
  await fs.promises.writeFile(
    path.join(pendingDir, INFO_FILE),
    JSON.stringify({
      fileName: entry.fileName,
      sha512: entry.sha512,
      isAdminRightsRequired: entry.isAdminRightsRequired,
    }),
  )
}

/**
 * 清掉 pending 里与这次下载无关的东西（旧版本安装包、electron-updater 失败留下的 temp-*、过期的 update-info），
 * 只保留这次的 `.part`（断点续传要用）和已经对得上的成品。
 */
async function prunePending(pendingDir: string, entry: InstallerEntry): Promise<void> {
  const info = await readInfoFile(pendingDir)
  const infoMatches = info?.fileName === entry.fileName && info?.sha512 === entry.sha512
  const keep = new Set([entry.fileName, `${entry.fileName}.part`])
  if (infoMatches) keep.add(INFO_FILE)
  for (const name of await fs.promises.readdir(pendingDir)) {
    if (keep.has(name)) continue
    await fs.promises.rm(path.join(pendingDir, name), { recursive: true, force: true })
  }
}

export interface PrefetchOptions
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
  pendingDir: string
  entry: InstallerEntry
}

export interface PrefetchResult {
  /** 缓存里已经有校验通过的安装包，没有再下载 */
  reusedExisting: boolean
  /** 连接了几次（复用已有文件时为 0） */
  attempts: number
}

export async function prefetchInstaller(opts: PrefetchOptions): Promise<PrefetchResult> {
  const { pendingDir, entry, ...download } = opts
  await fs.promises.mkdir(pendingDir, { recursive: true })
  await prunePending(pendingDir, entry)

  const finalPath = path.join(pendingDir, entry.fileName)
  if (await exists(finalPath)) {
    if ((await sha512Base64(finalPath)) === entry.sha512) {
      await writeInfoFile(pendingDir, entry)
      return { reusedExisting: true, attempts: 0 }
    }
    await fs.promises.rm(finalPath, { force: true })
  }
  // 成品没了，对应的 update-info 也别留着，免得 electron-updater 读到一个指向不存在文件的记录
  await fs.promises.rm(path.join(pendingDir, INFO_FILE), { force: true })

  const { attempts } = await downloadWithResume({
    ...download,
    url: entry.url,
    destination: finalPath,
    expectedSize: entry.size,
    sha512: entry.sha512,
  })
  await writeInfoFile(pendingDir, entry)
  return { reusedExisting: false, attempts }
}

/** 重试时给界面看的提示 */
export function formatRetryNotice(r: Pick<RetryInfo, "failures" | "maxFailures" | "error">): string {
  const head =
    r.failures === 0
      ? "连接中断，正在从断点继续下载…"
      : `连接中断，正在重试（连续失败 ${r.failures}/${r.maxFailures} 次，超过后会提示手动下载）…`
  return `${head}\n${errorMessage(r.error)}`
}

export interface FetchSession {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

/**
 * 每次重连前换一个全新的网络会话。
 *
 * 实测：Chromium 的网络服务进程崩溃/被杀之后，默认 session 上的 fetch 会一直 `net::ERR_FAILED`
 * （观察 50 秒以上不恢复），而新建的 session 立刻就能用。所以重试不能一直复用同一个 session。
 * 第一次用 `initial`（默认 session）；之后每调用一次 `rotate()`，下一次 fetch 就走新建的 session。
 * 新建失败时沿用当前 session，不让轮换本身变成新的失败点。
 */
export function createRotatingFetch(opts: { initial: FetchSession; createSession: () => Promise<FetchSession> }): {
  fetch: typeof fetch
  rotate: () => void
} {
  let current: FetchSession = opts.initial
  let pending: Promise<void> = Promise.resolve()
  return {
    rotate() {
      pending = pending
        .then(() => opts.createSession())
        .then(
          (next) => {
            current = next
          },
          () => undefined,
        )
    },
    fetch: (async (url: string, init?: RequestInit) => {
      await pending
      return current.fetch(url, init)
    }) as unknown as typeof fetch,
  }
}
