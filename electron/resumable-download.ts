import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 可断点续传、自动重试的文件下载（不依赖 Electron，方便单测）。
 *
 * electron-updater 的整包下载中途断开就整个失败，已下载的部分也会被清掉；而 GitHub 的安装包
 * 在国内网络下经常下到一半被重置。这里改成：数据先写到 `<destination>.part`，断了就用 Range 从断点接着下，
 * 全部收完并通过 sha512 校验后才改名为最终文件。`.part` 会一直保留，重启应用后也能接着下。
 *
 * 失败的计数口径是「连续没有拿到新数据的失败」：每次重连只要续上了新数据（≥ minProgressBytes）计数就清零，
 * 所以反复被掐断但一直在前进的下载会一直续到完成；只有网络彻底不通（连续 maxConsecutiveFailures 次
 * 一点新数据都拿不到）才放弃，交给上层提示手动下载。
 */

/** 连续这么多次重连都一点新数据没拿到，才放弃并提示手动下载（拿到新数据就清零） */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 8
/** 重连等待的上限；8 次连续失败的总等待约 1+2+4+8+10+10+10 = 45 秒 */
export const MAX_RETRY_DELAY_MS = 10_000
/** 连接次数的总上限，防止服务器一直只吐一点点数据导致永远下不完 */
export const DEFAULT_MAX_ATTEMPTS = 100
export const DEFAULT_STALL_TIMEOUT_MS = 30_000
/** 一次连接至少新增这么多字节才算「有进展」，失败计数才清零 */
export const DEFAULT_MIN_PROGRESS_BYTES = 64 * 1024

/** 重试也没用的失败：磁盘写不进去、HTTP 404/403 之类 */
export class FatalDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FatalDownloadError"
  }
}

/** 连续多次没有拿到新数据，放弃了 */
export class DownloadRetryExhausted extends Error {
  readonly attempts: number
  readonly maxConsecutiveFailures: number
  readonly lastError: unknown
  readonly receivedBytes: number
  readonly totalBytes: number | undefined

  constructor(init: {
    attempts: number
    maxConsecutiveFailures: number
    lastError: unknown
    receivedBytes: number
    totalBytes?: number
  }) {
    super(`连续 ${init.maxConsecutiveFailures} 次重试都没有拿到新数据：${errorMessage(init.lastError)}`)
    this.name = "DownloadRetryExhausted"
    this.attempts = init.attempts
    this.maxConsecutiveFailures = init.maxConsecutiveFailures
    this.lastError = init.lastError
    this.receivedBytes = init.receivedBytes
    this.totalBytes = init.totalBytes
  }
}

export interface RetryInfo {
  /** 第几次连接失败了（从 1 起，含已续上数据的那些） */
  attempt: number
  /** 当前「连续没有新数据」的失败次数；0 表示这次失败前已经续上了新数据 */
  failures: number
  maxFailures: number
  error: unknown
  delayMs: number
  receivedBytes: number
  totalBytes?: number
}

export interface ResumableDownloadOptions {
  url: string
  /** 最终文件路径；下载过程中写 `${destination}.part`，校验通过后才改名 */
  destination: string
  /** 完整文件的大小（latest.yml 里的 size），用来判断是否收完整 */
  expectedSize?: number
  /** base64 的 sha512（latest.yml 里的格式），收完后校验 */
  sha512?: string
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
  maxConsecutiveFailures?: number
  maxAttempts?: number
  /** 这么久没收到任何数据就当连接已死 */
  stallTimeoutMs?: number
  minProgressBytes?: number
  /** 第 n 次「连续无进展失败」之后等多久再重连；n=0 表示刚续上过数据 */
  retryDelayMs?: (failures: number) => number
  sleep?: (ms: number) => Promise<void>
  onProgress?: (p: { received: number; total?: number }) => void
  onRetry?: (r: RetryInfo) => void
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === "string" ? e : String(e)
}

export function defaultRetryDelayMs(failures: number): number {
  if (failures <= 0) return 500
  return Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_DELAY_MS)
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).size
  } catch {
    return 0
  }
}

async function removeIfExists(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true })
}

export function sha512Base64(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512")
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("base64")))
  })
}

export function parseContentRange(value: string | null): { start: number; end: number; total?: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((value ?? "").trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? undefined : Number(m[3]) }
}

/** Windows 上刚写完的文件可能被杀毒软件短暂占用，改名遇到 EBUSY/EPERM 时多试几次 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && i < 20) {
        await new Promise((r) => setTimeout(r, 250))
        continue
      }
      throw new FatalDownloadError(`无法把下载好的文件改名到位：${errorMessage(e)}`)
    }
  }
}

interface RunState {
  total: number | undefined
}

export async function downloadWithResume(opts: ResumableDownloadOptions): Promise<{ attempts: number }> {
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const minProgress = opts.minProgressBytes ?? DEFAULT_MIN_PROGRESS_BYTES
  const retryDelay = opts.retryDelayMs ?? defaultRetryDelayMs
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const partPath = `${opts.destination}.part`
  const state: RunState = { total: opts.expectedSize }

  await fs.promises.mkdir(path.dirname(opts.destination), { recursive: true })

  let failures = 0
  for (let attempt = 1; ; attempt++) {
    const sizeBefore = await fileSize(partPath)
    try {
      await attemptOnce(opts, partPath, state)
      return { attempts: attempt }
    } catch (err) {
      if (err instanceof FatalDownloadError) throw err
      const sizeAfter = await fileSize(partPath)
      // 以 .part 的净增长判断有没有进展：服务器不支持 Range、每次都从头来的话，
      // 不会超过上次的高水位，不算进展，避免无休止地重复下载同一段
      failures = sizeAfter - sizeBefore >= minProgress ? 0 : failures + 1
      if (failures >= maxFailures || attempt >= maxAttempts) {
        throw new DownloadRetryExhausted({
          attempts: attempt,
          maxConsecutiveFailures: maxFailures,
          lastError: err,
          receivedBytes: sizeAfter,
          totalBytes: state.total,
        })
      }
      const delayMs = retryDelay(failures)
      opts.onRetry?.({
        attempt,
        failures,
        maxFailures,
        error: err,
        delayMs,
        receivedBytes: sizeAfter,
        totalBytes: state.total,
      })
      await sleep(delayMs)
    }
  }
}

async function attemptOnce(opts: ResumableDownloadOptions, partPath: string, state: RunState): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS

  let offset = await fileSize(partPath)
  if (state.total !== undefined) {
    if (offset > state.total) {
      await removeIfExists(partPath)
      offset = 0
    }
    if (offset === state.total) {
      // 上次已经收完整，只差校验和改名（比如收完后应用被关掉）
      await finalize(opts, partPath)
      return
    }
  }

  const controller = new AbortController()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, stallMs)
  }

  try {
    try {
      arm()
      await streamToPart(opts, fetchImpl, controller, partPath, offset, state, arm)
    } catch (err) {
      controller.abort()
      if (stalled) throw new Error(`下载停滞：${Math.round(stallMs / 1000)} 秒没有收到数据`)
      throw err
    }
  } finally {
    if (timer) clearTimeout(timer)
  }

  const sizeNow = await fileSize(partPath)
  if (state.total !== undefined && sizeNow < state.total) {
    throw new Error(`连接提前结束（已收到 ${sizeNow}/${state.total} 字节）`)
  }
  if (state.total !== undefined && sizeNow > state.total) {
    await removeIfExists(partPath)
    throw new Error("收到的内容比预期的大，已丢弃重新下载")
  }
  await finalize(opts, partPath)
}

async function streamToPart(
  opts: ResumableDownloadOptions,
  fetchImpl: typeof fetch,
  controller: AbortController,
  partPath: string,
  offset: number,
  state: RunState,
  arm: () => void,
): Promise<void> {
  const res = await fetchImpl(opts.url, {
    headers: { ...(opts.headers ?? {}), ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}) },
    signal: controller.signal,
  })
  const discardBody = async () => {
    try {
      await res.body?.cancel()
    } catch {
      /* 连接可能已经断了 */
    }
  }

  if (res.status === 416) {
    // 本地已有的部分对不上服务器上的文件：丢掉重来
    await discardBody()
    await removeIfExists(partPath)
    throw new Error("服务器拒绝了续传位置（HTTP 416），已丢弃本地缓存重新下载")
  }
  if (res.status >= 400) {
    await discardBody()
    const message = `HTTP ${res.status} ${res.statusText}`.trim()
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429
    throw retryable ? new Error(message) : new FatalDownloadError(message)
  }

  let startAt = offset
  let responseTotal: number | undefined
  if (res.status === 206) {
    const cr = parseContentRange(res.headers.get("content-range"))
    if (!cr || cr.start !== offset) {
      await discardBody()
      await removeIfExists(partPath)
      throw new Error("服务器返回的续传位置与请求不一致，已丢弃本地缓存重新下载")
    }
    responseTotal = cr.total
  } else if (res.status === 200) {
    if (offset > 0) {
      // 服务器没有理会 Range，整个文件重新发了：只能从头写
      await removeIfExists(partPath)
      startAt = 0
    }
    const len = Number(res.headers.get("content-length"))
    responseTotal = Number.isFinite(len) && len > 0 ? len : undefined
  } else {
    await discardBody()
    throw new Error(`意外的响应：HTTP ${res.status}`)
  }

  if (responseTotal !== undefined) {
    if (state.total !== undefined && state.total !== responseTotal) {
      await discardBody()
      await removeIfExists(partPath)
      throw new Error(`服务器上的文件大小（${responseTotal}）与发布信息（${state.total}）不一致，已丢弃重新下载`)
    }
    state.total = responseTotal
  }
  if (!res.body) throw new Error("响应没有内容")

  const handle = await fs.promises.open(partPath, startAt > 0 ? "a" : "w")
  let received = startAt
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      if (!value || value.length === 0) continue
      try {
        await handle.write(value)
      } catch (e) {
        throw new FatalDownloadError(`写入下载文件失败：${errorMessage(e)}`)
      }
      received += value.length
      opts.onProgress?.({ received, total: state.total })
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function finalize(opts: ResumableDownloadOptions, partPath: string): Promise<void> {
  if (opts.sha512) {
    const actual = await sha512Base64(partPath)
    if (actual !== opts.sha512) {
      await removeIfExists(partPath)
      throw new Error("sha512 校验失败：下载内容已损坏，将重新下载")
    }
  }
  await removeIfExists(opts.destination)
  await renameWithRetry(partPath, opts.destination)
}
