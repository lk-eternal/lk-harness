import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DownloadRetryExhausted,
  FatalDownloadError,
  defaultRetryDelayMs,
  downloadWithResume,
  parseContentRange,
  type ResumableDownloadOptions,
} from "../electron/resumable-download"
import { startServer, type TestServer } from "./helpers/range-server"

const sha512 = (b: Buffer) => createHash("sha512").update(b).digest("base64")
const rangeStart = (r: string | null) => (r ? Number(/^bytes=(\d+)-$/.exec(r)?.[1]) : 0)

let tmp: string
let server: TestServer | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-resume-"))
})
afterEach(async () => {
  await server?.close()
  server = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 单测里不真的等：重试间隔 0 */
const fast: Partial<ResumableDownloadOptions> = { retryDelayMs: () => 0, sleep: async () => undefined }

describe("downloadWithResume", () => {
  it("连接被掐断后用 Range 从断点接着下，最终文件与原文件逐字节一致", async () => {
    const payload = randomBytes(1_000_000)
    server = await startServer(payload, (n) => (n < 2 ? { kind: "drop", afterBytes: 300_000 } : { kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    const progress: number[] = []

    const { attempts } = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length,
      sha512: sha512(payload),
      onProgress: (p) => progress.push(p.received),
    })

    expect(attempts).toBe(3)
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
    expect(fs.existsSync(`${dest}.part`)).toBe(false)
    // 第一次从头；之后的每次都从上次收到的位置继续，起点单调递增
    const starts = server.requests.map((r) => rangeStart(r.range))
    expect(server.requests[0].range).toBeNull()
    expect(starts[1]).toBeGreaterThan(0)
    expect(starts[2]).toBeGreaterThan(starts[1])
    expect(progress.at(-1)).toBe(payload.length)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it("服务器不理会 Range、整个文件重发时，丢掉旧的部分从头写，结果仍然正确", async () => {
    const payload = randomBytes(800_000)
    server = await startServer(payload, (n) => (n === 0 ? { kind: "drop", afterBytes: 400_000 } : { kind: "ok" }), {
      supportsRange: false,
    })
    const dest = path.join(tmp, "app.exe")

    const { attempts } = await downloadWithResume({ ...fast, url: server.url, destination: dest, sha512: sha512(payload) })

    expect(attempts).toBe(2)
    expect(server.requests[1].range).not.toBeNull() // 客户端照常请求了续传，只是服务器没给
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it("每次重连都续上了新数据时失败不累计：断线次数超过 maxConsecutiveFailures 也能下完", async () => {
    const payload = randomBytes(2_000_000)
    server = await startServer(payload, (n) => (n < 6 ? { kind: "drop", afterBytes: 200_000 } : { kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    const retries: number[] = []

    const { attempts } = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length,
      sha512: sha512(payload),
      maxConsecutiveFailures: 2,
      onRetry: (r) => retries.push(r.failures),
    })

    expect(attempts).toBe(7)
    expect(retries).toEqual([0, 0, 0, 0, 0, 0]) // 每次失败前都有进展，计数一直是 0
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it("连续没有拿到新数据达到上限就放弃，抛 DownloadRetryExhausted，并保留已下载的部分", async () => {
    const payload = randomBytes(600_000)
    // 第一次下到 300KB 后断开，之后一直 503
    server = await startServer(payload, (n) => (n === 0 ? { kind: "drop", afterBytes: 300_000 } : { kind: "status", code: 503 }))
    const dest = path.join(tmp, "app.exe")
    const retries: { failures: number; max: number }[] = []

    const err = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      maxConsecutiveFailures: 3,
      onRetry: (r) => retries.push({ failures: r.failures, max: r.maxFailures }),
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DownloadRetryExhausted)
    const exhausted = err as DownloadRetryExhausted
    // 第 1 次有进展（failures=0），之后 503 三次无进展：共 4 次连接，其中 3 次重试
    expect(exhausted.attempts).toBe(4)
    expect(server.requests).toHaveLength(4)
    expect(retries).toEqual([
      { failures: 0, max: 3 },
      { failures: 1, max: 3 },
      { failures: 2, max: 3 },
    ])
    expect(exhausted.receivedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(`${dest}.part`)).toBe(true) // 断点还在，下次接着下
    expect(fs.existsSync(dest)).toBe(false)
  })

  it("默认阈值：连续 8 次没拿到新数据才放弃（第 8 次失败时抛出，共连接 8 次）", async () => {
    server = await startServer(randomBytes(50_000), () => ({ kind: "status", code: 503 }))
    const dest = path.join(tmp, "app.exe")
    const failuresSeen: number[] = []

    const err = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      onRetry: (r) => failuresSeen.push(r.failures),
    }).catch((e: unknown) => e)

    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBe(8)
    expect(err).toBeInstanceOf(DownloadRetryExhausted)
    expect((err as DownloadRetryExhausted).maxConsecutiveFailures).toBe(8)
    expect(server.requests).toHaveLength(8)
    expect(failuresSeen).toEqual([1, 2, 3, 4, 5, 6, 7]) // 第 8 次直接放弃，不再重试
  })

  it("503 这类服务器错误会重试，恢复后即可下完", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, (n) => (n < 2 ? { kind: "status", code: 503 } : { kind: "ok" }))
    const dest = path.join(tmp, "app.exe")

    const { attempts } = await downloadWithResume({ ...fast, url: server.url, destination: dest })

    expect(attempts).toBe(3)
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it("404 这类重试也没用的错误立刻失败，不重试", async () => {
    server = await startServer(randomBytes(10), () => ({ kind: "status", code: 404 }))

    const err = await downloadWithResume({ ...fast, url: server.url, destination: path.join(tmp, "app.exe") }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(FatalDownloadError)
    expect((err as Error).message).toContain("404")
    expect(server.requests).toHaveLength(1)
  })

  it("sha512 校验失败：丢弃下载内容，不留下成品，反复失败后放弃", async () => {
    const payload = randomBytes(200_000)
    server = await startServer(payload, () => ({ kind: "ok" }))
    const dest = path.join(tmp, "app.exe")

    const err = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      sha512: sha512(Buffer.from("别的内容")),
      maxConsecutiveFailures: 2,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DownloadRetryExhausted)
    expect((err as DownloadRetryExhausted).lastError).toMatchObject({ message: expect.stringContaining("sha512") })
    expect(server.requests).toHaveLength(2) // 损坏的内容丢掉后是整个重下，不是接着下
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(`${dest}.part`)).toBe(false)
  })

  it("磁盘上已有的 .part 会接着下（模拟应用关闭后再次点更新）", async () => {
    const payload = randomBytes(900_000)
    server = await startServer(payload, () => ({ kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    fs.writeFileSync(`${dest}.part`, payload.subarray(0, 400_000))

    await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length,
      sha512: sha512(payload),
    })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].range).toBe("bytes=400000-")
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it(".part 已经是完整的（只差校验和改名）时不再发任何请求", async () => {
    const payload = randomBytes(50_000)
    server = await startServer(payload, () => ({ kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    fs.writeFileSync(`${dest}.part`, payload)

    const { attempts } = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length,
      sha512: sha512(payload),
    })

    expect(attempts).toBe(1)
    expect(server.requests).toHaveLength(0)
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it(".part 比预期的完整文件还大时视为损坏，从头下", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    fs.writeFileSync(`${dest}.part`, randomBytes(payload.length + 10))

    await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length,
      sha512: sha512(payload),
    })

    expect(server.requests[0].range).toBeNull()
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it("长时间没有收到数据判定为停滞，断开重连后继续", async () => {
    const payload = randomBytes(500_000)
    server = await startServer(payload, (n) => (n === 0 ? { kind: "stall", afterBytes: 200_000 } : { kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    const reasons: string[] = []

    const { attempts } = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      sha512: sha512(payload),
      stallTimeoutMs: 300,
      onRetry: (r) => reasons.push((r.error as Error).message),
    })

    expect(attempts).toBe(2)
    expect(reasons[0]).toContain("下载停滞")
    expect(rangeStart(server.requests[1].range)).toBeGreaterThan(0)
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it("服务器上的文件大小与发布信息对不上时丢弃缓存，反复对不上就放弃", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "ok" }))
    const dest = path.join(tmp, "app.exe")

    const err = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length + 5,
      maxConsecutiveFailures: 2,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DownloadRetryExhausted)
    expect((err as DownloadRetryExhausted).lastError).toMatchObject({ message: expect.stringContaining("不一致") })
    expect(fs.existsSync(dest)).toBe(false)
  })
})

describe("辅助函数", () => {
  it("parseContentRange 解析 206 的 Content-Range", () => {
    expect(parseContentRange("bytes 100-199/1000")).toEqual({ start: 100, end: 199, total: 1000 })
    expect(parseContentRange("bytes 0-9/*")).toEqual({ start: 0, end: 9, total: undefined })
    expect(parseContentRange("bytes */1000")).toBeNull()
    expect(parseContentRange(null)).toBeNull()
  })

  it("重试间隔指数退避，上限 15 秒；刚续上过数据时只等半秒", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(defaultRetryDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000])
  })
})
