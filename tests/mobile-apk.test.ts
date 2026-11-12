import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  MOBILE_APK_FILE,
  MOBILE_APK_MANIFEST,
  apkDownloadUrls,
  apkUrlForRequest,
  bundledApkInfo,
  findBundledApk,
  handleMobileApkRequest,
  requestOrigin,
  withDesktopApkUrl,
} from "../electron/mobile-apk"
import { MOBILE_APK_PATH, MOBILE_APK_URL } from "../src/shared/app-update"

const made: string[] = []
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-apk-"))
  made.push(dir)
  return dir
}

/** 和 CI（mobile-apk.yml 里「Write APK manifest」那步）写出来的形状一致 */
function putApk(dir: string, opts: { version?: string; size?: number | "actual"; body?: Buffer } = {}): Buffer {
  const body = opts.body ?? Buffer.from("PK\u0003\u0004 fake apk bytes ".repeat(50))
  fs.writeFileSync(path.join(dir, MOBILE_APK_FILE), body)
  const size = opts.size === undefined || opts.size === "actual" ? body.length : opts.size
  fs.writeFileSync(path.join(dir, MOBILE_APK_MANIFEST), JSON.stringify({ version: opts.version ?? "1.3.0", size }) + "\n")
  return body
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("findBundledApk", () => {
  it("清单和文件都在、大小对得上时给出版本和文件路径", () => {
    const dir = tmpDir()
    const body = putApk(dir, { version: "1.3.0" })
    expect(findBundledApk([dir])).toEqual({
      version: "1.3.0",
      filePath: path.join(dir, MOBILE_APK_FILE),
      size: body.length,
    })
  })

  it("目录不存在、没有清单、没有 APK 都当作没有", () => {
    expect(findBundledApk([path.join(tmpDir(), "nope")])).toBeNull()
    const noManifest = tmpDir()
    fs.writeFileSync(path.join(noManifest, MOBILE_APK_FILE), "x")
    expect(findBundledApk([noManifest])).toBeNull()
    const noApk = tmpDir()
    fs.writeFileSync(path.join(noApk, MOBILE_APK_MANIFEST), JSON.stringify({ version: "1.3.0", size: 1 }))
    expect(findBundledApk([noApk])).toBeNull()
  })

  it("文件大小和清单对不上（没拷完整）、空文件、清单缺大小，都不能当作可用的安装包", () => {
    const partial = tmpDir()
    putApk(partial, { size: 999_999 })
    expect(findBundledApk([partial])).toBeNull()

    const empty = tmpDir()
    putApk(empty, { body: Buffer.alloc(0), size: 0 })
    expect(findBundledApk([empty])).toBeNull()

    const noSize = tmpDir()
    putApk(noSize)
    fs.writeFileSync(path.join(noSize, MOBILE_APK_MANIFEST), JSON.stringify({ version: "1.3.0" }))
    expect(findBundledApk([noSize])).toBeNull()
  })

  it("版本号不合法（会进下载文件名）、清单不是 JSON 都当作没有", () => {
    for (const version of ["", "latest", '1.3.0"; rm -rf /', "../1.3.0", "1.3.0 beta"]) {
      const dir = tmpDir()
      putApk(dir, { version })
      expect(findBundledApk([dir]), version).toBeNull()
    }
    const broken = tmpDir()
    putApk(broken)
    fs.writeFileSync(path.join(broken, MOBILE_APK_MANIFEST), "{not json")
    expect(findBundledApk([broken])).toBeNull()
  })

  it("按候选目录的顺序取第一个可用的，前面的坏了就用后面的", () => {
    const bad = tmpDir()
    putApk(bad, { size: 1 })
    const good = tmpDir()
    putApk(good, { version: "1.4.0" })
    const other = tmpDir()
    putApk(other, { version: "9.9.9" })
    expect(findBundledApk([bad, good, other])?.version).toBe("1.4.0")
    expect(findBundledApk([])).toBeNull()
  })
})

describe("bundledApkInfo", () => {
  it("版本以内置 APK 为准，给相对路径，来源是电脑端", () => {
    expect(bundledApkInfo({ version: "1.3.0", filePath: "/x", size: 1 })).toMatchObject({
      ok: true,
      latestVersion: "1.3.0",
      apkPath: MOBILE_APK_PATH,
      source: "desktop",
    })
  })
})

describe("apkUrlForRequest", () => {
  it("局域网直连：按手机连上来的地址拼 http", () => {
    expect(apkUrlForRequest({ host: "192.168.1.5:19529", publicUrl: "" })).toBe(`http://192.168.1.5:19529${MOBILE_APK_PATH}`)
  })

  it("Host 就是设置里的公网地址：沿用公网地址的协议和路径前缀", () => {
    expect(apkUrlForRequest({ host: "lk.example.com", publicUrl: "https://lk.example.com" })).toBe(
      `https://lk.example.com${MOBILE_APK_PATH}`,
    )
    expect(apkUrlForRequest({ host: "example.com", publicUrl: "https://example.com/harness/" })).toBe(
      `https://example.com/harness${MOBILE_APK_PATH}`,
    )
  })

  it("反向代理给了 X-Forwarded-Proto 就听它的（取第一个值）", () => {
    expect(apkUrlForRequest({ host: "lk.example.com", forwardedProto: "https, http", publicUrl: "" })).toBe(
      `https://lk.example.com${MOBILE_APK_PATH}`,
    )
    expect(apkUrlForRequest({ host: "10.0.0.2:80", forwardedProto: "ftp", publicUrl: "" })).toBe(`http://10.0.0.2:80${MOBILE_APK_PATH}`)
  })

  it("Host 和公网地址不一致时不借用公网地址的路径前缀", () => {
    expect(apkUrlForRequest({ host: "192.168.1.5:19529", publicUrl: "https://example.com/harness" })).toBe(
      `http://192.168.1.5:19529${MOBILE_APK_PATH}`,
    )
  })

  it("公网地址写坏了也不抛，IPv6 地址能用", () => {
    expect(apkUrlForRequest({ host: "192.168.1.5:19529", publicUrl: "::::" })).toBe(`http://192.168.1.5:19529${MOBILE_APK_PATH}`)
    expect(apkUrlForRequest({ host: "[fe80::1]:19529", publicUrl: "" })).toBe(`http://[fe80::1]:19529${MOBILE_APK_PATH}`)
  })

  it("Host 缺失或带奇怪字符时拼不出来", () => {
    expect(apkUrlForRequest({ host: undefined })).toBeNull()
    expect(apkUrlForRequest({ host: "" })).toBeNull()
    expect(apkUrlForRequest({ host: "evil.com/\r\nSet-Cookie: x" })).toBeNull()
    expect(apkUrlForRequest({ host: "a b" })).toBeNull()
    expect(apkUrlForRequest({ host: "host:99999999" })).toBeNull()
  })
})

describe("requestOrigin / withDesktopApkUrl", () => {
  const desktopInfo = bundledApkInfo({ version: "1.3.0", filePath: "/x", size: 1 })

  it("请求头里的 Host 和 X-Forwarded-Proto 用来拼绝对地址，旧版 App 直接用 apkUrl", () => {
    const origin = requestOrigin({ host: "192.168.1.5:19529" }, "")
    expect(withDesktopApkUrl(desktopInfo, origin)).toMatchObject({
      latestVersion: "1.3.0",
      apkUrl: `http://192.168.1.5:19529${MOBILE_APK_PATH}`,
      apkPath: MOBILE_APK_PATH,
    })
    const proxied = requestOrigin({ host: "lk.example.com", "x-forwarded-proto": ["https"] }, "")
    expect(withDesktopApkUrl(desktopInfo, proxied).apkUrl).toBe(`https://lk.example.com${MOBILE_APK_PATH}`)
  })

  it("拼不出来时退回 GitHub 地址，至少和以前一样", () => {
    expect(withDesktopApkUrl(desktopInfo, requestOrigin({}, "")).apkUrl).toBe(MOBILE_APK_URL)
  })

  it("GitHub 来源和失败的信息原样返回", () => {
    const github = { ok: true, latestVersion: "1.3.0", apkUrl: MOBILE_APK_URL, source: "github" as const }
    expect(withDesktopApkUrl(github, requestOrigin({ host: "1.2.3.4:5" }, ""))).toBe(github)
    const failed = { ok: false, error: "x" }
    expect(withDesktopApkUrl(failed, requestOrigin({ host: "1.2.3.4:5" }, ""))).toBe(failed)
  })
})

describe("apkDownloadUrls", () => {
  it("局域网地址在前、公网地址在后，去掉末尾斜杠和空项", () => {
    expect(apkDownloadUrls(["http://192.168.1.5:19529", "http://10.0.0.2:19529/"], "https://lk.example.com/")).toEqual([
      `http://192.168.1.5:19529${MOBILE_APK_PATH}`,
      `http://10.0.0.2:19529${MOBILE_APK_PATH}`,
      `https://lk.example.com${MOBILE_APK_PATH}`,
    ])
    expect(apkDownloadUrls([], "")).toEqual([])
  })
})

describe("handleMobileApkRequest：真实的 HTTP 服务", () => {
  let dir = ""
  let body: Buffer
  let server: http.Server
  let base = ""
  let bundled = true

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-apk-srv-"))
    body = putApk(dir, { version: "1.3.0", body: Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251)) })
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x")
      // 和 mobile-server.ts 里一样：APK 路径排在网页兜底之前
      if (handleMobileApkRequest(() => (bundled ? findBundledApk([dir]) : null), req, res, url.pathname)) return
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<html>首页兜底</html>")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("GET 把完整的 APK 发出去，头里带安装包类型、长度和带版本号的文件名", async () => {
    const res = await fetch(`${base}${MOBILE_APK_PATH}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive")
    expect(res.headers.get("content-length")).toBe(String(body.length))
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="lk-harness-mobile-1.3.0.apk"')
    const got = Buffer.from(await res.arrayBuffer())
    expect(got.equals(body)).toBe(true)
  })

  it("HEAD 只给头，不发内容", async () => {
    const res = await fetch(`${base}${MOBILE_APK_PATH}`, { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-length")).toBe(String(body.length))
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it("不要求令牌：没带 Authorization 也能下（新手机扫码安装时还没配对）", async () => {
    const res = await fetch(`${base}${MOBILE_APK_PATH}`, { headers: {} })
    expect(res.status).toBe(200)
  })

  it("别的路径、别的方法不处理，交给后面的路由", async () => {
    const other = await fetch(`${base}/index.html`)
    expect(await other.text()).toContain("首页兜底")
    const post = await fetch(`${base}${MOBILE_APK_PATH}`, { method: "POST" })
    expect(await post.text()).toContain("首页兜底")
  })

  it("没有内置 APK 时明说 404，而不是落到首页兜底上让人下到一个 HTML", async () => {
    bundled = false
    try {
      const res = await fetch(`${base}${MOBILE_APK_PATH}`)
      expect(res.status).toBe(404)
      expect(await res.text()).toContain("没有内置手机安装包")
    } finally {
      bundled = true
    }
  })

  it("换了安装包不用重启：每次请求都重新读清单", async () => {
    const swapped = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-apk-swap-"))
    try {
      const newBody = putApk(swapped, { version: "2.0.0", body: Buffer.from("second build ".repeat(40)) })
      const live = http.createServer((req, res) => {
        handleMobileApkRequest(() => findBundledApk([swapped]), req, res, MOBILE_APK_PATH)
      })
      await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve))
      const url = `http://127.0.0.1:${(live.address() as { port: number }).port}/`
      try {
        const first = await fetch(url)
        expect(first.headers.get("content-disposition")).toContain("2.0.0")
        expect(Buffer.from(await first.arrayBuffer()).equals(newBody)).toBe(true)
        const third = putApk(swapped, { version: "2.1.0", body: Buffer.from("third build ".repeat(10)) })
        const second = await fetch(url)
        expect(second.headers.get("content-disposition")).toContain("2.1.0")
        expect(Buffer.from(await second.arrayBuffer()).equals(third)).toBe(true)
      } finally {
        await new Promise<void>((resolve) => live.close(() => resolve()))
      }
    } finally {
      fs.rmSync(swapped, { recursive: true, force: true })
    }
  })
})
