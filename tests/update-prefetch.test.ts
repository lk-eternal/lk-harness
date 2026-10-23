import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppUpdater } from "electron-updater/out/AppUpdater"
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper"
import { DownloadRetryExhausted, downloadWithResume } from "../electron/resumable-download"
import {
  createRotatingFetch,
  formatRetryNotice,
  pickWindowsInstaller,
  prefetchInstaller,
  type FetchSession,
  type InstallerEntry,
  type UpdateInfoLike,
} from "../electron/update-prefetch"
import { startServer, type TestServer } from "./helpers/range-server"

const RELEASES = "https://github.com/lk-eternal/lk-harness/releases"
const sha512 = (b: Buffer) => createHash("sha512").update(b).digest("base64")
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const fast = { retryDelayMs: () => 0, sleep: async () => undefined }

let tmp: string
let server: TestServer | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-prefetch-"))
})
afterEach(async () => {
  await server?.close()
  server = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

function infoFor(payload: Buffer, version = "1.1.3"): UpdateInfoLike {
  return {
    version,
    tag: `v${version}`,
    files: [{ url: `lk-harness-setup-${version}.exe`, sha512: sha512(payload), size: payload.length }],
  }
}

/** 下载地址换成本地测试服务，其余字段（文件名、sha512、大小）照 latest.yml 算出来的 */
function localEntry(info: UpdateInfoLike, url: string): InstallerEntry {
  const entry = pickWindowsInstaller(info, RELEASES)
  if (!entry) throw new Error("pickWindowsInstaller 应该能找到安装包")
  return { ...entry, url }
}

describe("pickWindowsInstaller", () => {
  const sha = "abc123=="

  it("按 GitHub release 规则算出下载地址与缓存文件名", () => {
    const entry = pickWindowsInstaller(
      { version: "1.1.3", tag: "v1.1.3", files: [{ url: "lk-harness-setup-1.1.3.exe", sha512: sha, size: 171738050 }] },
      RELEASES,
    )
    expect(entry).toEqual({
      fileName: "lk-harness-setup-1.1.3.exe",
      url: "https://github.com/lk-eternal/lk-harness/releases/download/v1.1.3/lk-harness-setup-1.1.3.exe",
      sha512: sha,
      size: 171738050,
      isAdminRightsRequired: false,
    })
  })

  it("没有 tag 时按 v<version> 拼；文件名里的空格换成 -（与 electron-updater 一致）", () => {
    const entry = pickWindowsInstaller({ version: "2.0.0", files: [{ url: "LK Harness Setup 2.0.0.exe", sha512: sha }] }, RELEASES)
    expect(entry?.url).toBe("https://github.com/lk-eternal/lk-harness/releases/download/v2.0.0/LK-Harness-Setup-2.0.0.exe")
    expect(entry?.fileName).toBe("LK-Harness-Setup-2.0.0.exe")
    expect(entry?.size).toBeUndefined()
  })

  it("跳过 blockmap 和非 exe 文件；绝对地址原样使用", () => {
    const entry = pickWindowsInstaller(
      {
        version: "1.1.3",
        files: [
          { url: "lk-harness-setup-1.1.3.exe.blockmap", sha512: "x" },
          { url: "lk-harness_1.1.3_amd64.deb", sha512: "y" },
          { url: "https://mirror.example.com/dl/lk-harness-setup-1.1.3.exe", sha512: sha },
        ],
      },
      RELEASES,
    )
    expect(entry?.url).toBe("https://mirror.example.com/dl/lk-harness-setup-1.1.3.exe")
    expect(entry?.fileName).toBe("lk-harness-setup-1.1.3.exe")
  })

  it("旧格式的 latest.yml（只有 path + sha512）也能用", () => {
    const entry = pickWindowsInstaller({ version: "1.0.0", path: "lk-harness-setup-1.0.0.exe", sha512: sha }, RELEASES)
    expect(entry?.fileName).toBe("lk-harness-setup-1.0.0.exe")
  })

  it("没有 exe 或缺 sha512 时返回 null，由调用方退回 electron-updater 自带的下载", () => {
    expect(pickWindowsInstaller({ version: "1.1.3", files: [] }, RELEASES)).toBeNull()
    expect(pickWindowsInstaller({ version: "1.1.3", files: [{ url: "app.dmg", sha512: sha }] }, RELEASES)).toBeNull()
    expect(pickWindowsInstaller({ version: "1.1.3", files: [{ url: "app.exe", sha512: "" }] }, RELEASES)).toBeNull()
  })
})

describe("prefetchInstaller 与 electron-updater 的缓存校验对接", () => {
  it("下载（含中途断线续传）后，electron-updater 的 DownloadedUpdateHelper 认这份缓存", async () => {
    const payload = randomBytes(400_000)
    server = await startServer(payload, (n) => (n === 0 ? { kind: "drop", afterBytes: 150_000 } : { kind: "ok" }), {
      fileName: "lk-harness-setup-1.1.3.exe",
    })
    const info = infoFor(payload)
    const entry = localEntry(info, server.url)
    const helper = new DownloadedUpdateHelper(tmp)
    // electron-updater 的缓存布局：<cacheDir>/pending/{安装包, update-info.json}
    const pendingDir = helper.cacheDirForPendingUpdate
    expect(pendingDir).toBe(path.join(tmp, "pending"))

    const result = await prefetchInstaller({ ...fast, pendingDir, entry })

    expect(result).toEqual({ reusedExisting: false, attempts: 2 })
    const updateFile = path.join(pendingDir, entry.fileName)
    const validated = await helper.validateDownloadedPath(
      updateFile,
      info as never,
      { url: new URL(entry.url), info: info.files![0] } as never,
      logger as never,
    )
    expect(validated).toBe(updateFile)
    expect(fs.readFileSync(updateFile).equals(payload)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(pendingDir, "update-info.json"), "utf-8"))).toEqual({
      fileName: entry.fileName,
      sha512: entry.sha512,
      isAdminRightsRequired: false,
    })
  })

  it("对照：文件被改过，electron-updater 不认（说明上一条测试确实在校验内容）", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "lk-harness-setup-1.1.3.exe" })
    const info = infoFor(payload)
    const entry = localEntry(info, server.url)
    const helper = new DownloadedUpdateHelper(tmp)
    const pendingDir = helper.cacheDirForPendingUpdate
    await prefetchInstaller({ ...fast, pendingDir, entry })
    const updateFile = path.join(pendingDir, entry.fileName)
    fs.appendFileSync(updateFile, "x")

    const validated = await helper.validateDownloadedPath(
      updateFile,
      info as never,
      { url: new URL(entry.url), info: info.files![0] } as never,
      logger as never,
    )
    expect(validated).toBeNull()
  })

  it("缓存里已有校验通过的安装包时直接复用，不发请求", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "lk-harness-setup-1.1.3.exe" })
    const entry = localEntry(infoFor(payload), server.url)
    const pendingDir = path.join(tmp, "pending")
    await prefetchInstaller({ ...fast, pendingDir, entry })
    expect(server.requests).toHaveLength(1)

    const again = await prefetchInstaller({ ...fast, pendingDir, entry })

    expect(again).toEqual({ reusedExisting: true, attempts: 0 })
    expect(server.requests).toHaveLength(1)
  })

  it("成品在但 update-info.json 丢了（比如改名后崩溃）：校验通过就补写，不重下", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "lk-harness-setup-1.1.3.exe" })
    const entry = localEntry(infoFor(payload), server.url)
    const pendingDir = path.join(tmp, "pending")
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(path.join(pendingDir, entry.fileName), payload)

    const result = await prefetchInstaller({ ...fast, pendingDir, entry })

    expect(result.reusedExisting).toBe(true)
    expect(server.requests).toHaveLength(0)
    expect(fs.existsSync(path.join(pendingDir, "update-info.json"))).toBe(true)
  })

  it("清掉旧版本和失败残留，但保留本版本的 .part 并接着下", async () => {
    const payload = randomBytes(500_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "lk-harness-setup-1.1.3.exe" })
    const entry = localEntry(infoFor(payload), server.url)
    const pendingDir = path.join(tmp, "pending")
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(path.join(pendingDir, "lk-harness-setup-1.1.2.exe"), "old installer")
    fs.writeFileSync(path.join(pendingDir, "temp-lk-harness-setup-1.1.3.exe"), "electron-updater 失败残留")
    fs.writeFileSync(path.join(pendingDir, "current.blockmap"), "stale")
    fs.writeFileSync(
      path.join(pendingDir, "update-info.json"),
      JSON.stringify({ fileName: "lk-harness-setup-1.1.2.exe", sha512: "old", isAdminRightsRequired: false }),
    )
    fs.writeFileSync(path.join(pendingDir, `${entry.fileName}.part`), payload.subarray(0, 200_000))

    await prefetchInstaller({ ...fast, pendingDir, entry })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].range).toBe("bytes=200000-")
    expect(fs.readdirSync(pendingDir).sort()).toEqual(["lk-harness-setup-1.1.3.exe", "update-info.json"])
    expect(JSON.parse(fs.readFileSync(path.join(pendingDir, "update-info.json"), "utf-8")).sha512).toBe(entry.sha512)
  })

  it("重试用尽时抛 DownloadRetryExhausted，且不写 update-info.json（不会让 electron-updater 误以为下完了）", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "status", code: 503 }), { fileName: "lk-harness-setup-1.1.3.exe" })
    const entry = localEntry(infoFor(payload), server.url)
    const pendingDir = path.join(tmp, "pending")

    const err = await prefetchInstaller({ ...fast, pendingDir, entry, maxConsecutiveFailures: 3 }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DownloadRetryExhausted)
    expect(server.requests).toHaveLength(3)
    expect(fs.existsSync(path.join(pendingDir, "update-info.json"))).toBe(false)
    expect(fs.existsSync(path.join(pendingDir, entry.fileName))).toBe(false)
  })
})

describe("formatRetryNotice", () => {
  it("刚续上过数据：提示从断点继续；没有进展：显示连续失败次数和放弃的上限", () => {
    const error = new Error("net::ERR_CONNECTION_CLOSED")
    expect(formatRetryNotice({ failures: 0, maxFailures: 8, error })).toBe(
      "连接中断，正在从断点继续下载…\nnet::ERR_CONNECTION_CLOSED",
    )
    expect(formatRetryNotice({ failures: 2, maxFailures: 8, error })).toContain("连续失败 2/8 次")
  })
})

describe("createRotatingFetch", () => {
  const tag = (name: string, log: string[]): FetchSession => ({
    fetch: async () => {
      log.push(name)
      return new Response("ok")
    },
  })

  it("第一次用初始 session，rotate 之后改用新建的 session，之后一直用它直到下次 rotate", async () => {
    const used: string[] = []
    let created = 0
    const rf = createRotatingFetch({
      initial: tag("default", used),
      createSession: async () => tag(`fresh-${++created}`, used),
    })

    await rf.fetch("http://x")
    rf.rotate()
    await rf.fetch("http://x")
    await rf.fetch("http://x")
    rf.rotate()
    await rf.fetch("http://x")

    expect(used).toEqual(["default", "fresh-1", "fresh-1", "fresh-2"])
  })

  it("rotate 是异步创建的：紧跟着的 fetch 要等新 session 建好，不会误用旧的", async () => {
    const used: string[] = []
    const rf = createRotatingFetch({
      initial: tag("default", used),
      createSession: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return tag("fresh", used)
      },
    })
    rf.rotate()
    await rf.fetch("http://x")
    expect(used).toEqual(["fresh"])
  })

  it("新建 session 失败时沿用当前的，不让轮换本身变成失败点；之后的 rotate 仍然可用", async () => {
    const used: string[] = []
    let calls = 0
    const rf = createRotatingFetch({
      initial: tag("default", used),
      createSession: async () => {
        if (++calls === 1) throw new Error("boom")
        return tag("fresh", used)
      },
    })
    rf.rotate()
    await rf.fetch("http://x")
    rf.rotate()
    await rf.fetch("http://x")
    expect(used).toEqual(["default", "fresh"])
  })

  it("网络服务崩溃场景：初始 session 永远 ERR_FAILED，只要每次重试前 rotate，就能续传下完", async () => {
    const payload = randomBytes(600_000)
    server = await startServer(payload, (n) => (n === 0 ? { kind: "drop", afterBytes: 250_000 } : { kind: "ok" }))
    const dest = path.join(tmp, "app.exe")
    const poisonedCalls: string[] = []
    const poisoned: FetchSession = {
      fetch: async () => {
        poisonedCalls.push("x")
        throw new TypeError("net::ERR_FAILED")
      },
    }
    // 第一次连接（初始 session）正常收到一部分后被掐断；这之后「默认 session」就坏了
    let firstUse = true
    const initial: FetchSession = {
      fetch: (url, init) => {
        if (firstUse) {
          firstUse = false
          return fetch(url, init)
        }
        return poisoned.fetch(url, init)
      },
    }
    const rf = createRotatingFetch({ initial, createSession: async () => ({ fetch: (u, i) => fetch(u, i) }) })

    const { attempts } = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: dest,
      expectedSize: payload.length,
      sha512: sha512(payload),
      fetchImpl: rf.fetch,
      onRetry: () => rf.rotate(),
    })

    expect(attempts).toBe(2)
    expect(poisonedCalls).toHaveLength(0) // 重试时根本没再碰坏掉的 session
    expect(fs.readFileSync(dest).equals(payload)).toBe(true)
  })

  it("对照：不轮换时，坏掉的 session 会让下载耗尽重试（说明上一条确实依赖 rotate）", async () => {
    const payload = randomBytes(600_000)
    server = await startServer(payload, (n) => (n === 0 ? { kind: "drop", afterBytes: 250_000 } : { kind: "ok" }))
    let firstUse = true
    const initial: FetchSession = {
      fetch: (url, init) => {
        if (firstUse) {
          firstUse = false
          return fetch(url, init)
        }
        return Promise.reject(new TypeError("net::ERR_FAILED"))
      },
    }
    const rf = createRotatingFetch({ initial, createSession: async () => ({ fetch: (u, i) => fetch(u, i) }) })

    const err = await downloadWithResume({
      ...fast,
      url: server.url,
      destination: path.join(tmp, "app.exe"),
      expectedSize: payload.length,
      sha512: sha512(payload),
      fetchImpl: rf.fetch,
      maxConsecutiveFailures: 3,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DownloadRetryExhausted)
  })
})

describe("对 electron-updater 内部实现的依赖（升级 electron-updater 时由这里提醒）", () => {
  it("AppUpdater 仍有 getOrCreateDownloadHelper，DownloadedUpdateHelper 仍用 pending 目录", () => {
    // updater.ts 靠这个私有方法拿到缓存目录；没有了就会退回它自带的下载，续传/重试静默失效
    expect(typeof (AppUpdater.prototype as unknown as Record<string, unknown>).getOrCreateDownloadHelper).toBe("function")
    expect(new DownloadedUpdateHelper("/x").cacheDirForPendingUpdate).toBe(path.join("/x", "pending"))
  })
})
