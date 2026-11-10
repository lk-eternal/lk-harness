import * as fs from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { handleMobilePreviewRequest } from "../src/shared/mobile-preview-http"
import { mobilePreviewPath } from "../src/shared/mobile-preview"
import { createPreviewFileStore, type PreviewFileStore } from "../src/shared/preview-file-store"

let root: string
let site: string
let textFile: string
let binFile: string
let outside: string
let now = 1_000_000
const store = createPreviewFileStore(300, { ttlMs: 60_000, now: () => now })

/** 测试里替换成桩实现的 serve（用来观察文件流有没有被关掉、出错时连接怎么处理）；为空时走真实仓库 */
let serveOverride: PreviewFileStore["serve"] | undefined

let server: http.Server
let base: string

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lk-mobile-pv-")))
  site = path.join(root, "site")
  outside = path.join(root, "outside")
  fs.mkdirSync(site)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>")
  fs.writeFileSync(path.join(site, "style.css"), "h1{color:red}")
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET")
  textFile = path.join(root, "报告 1.txt")
  fs.writeFileSync(textFile, "hello world")
  binFile = path.join(root, "data.bin")
  fs.writeFileSync(binFile, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)))

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const handled = handleMobilePreviewRequest(
      (token, rel, opts) => (serveOverride ?? store.serve)(token, rel, opts),
      req,
      res,
      url.pathname,
      (r) => r.setHeader("Access-Control-Allow-Origin", "*"),
    )
    if (!handled) {
      res.writeHead(404, { "x-fallthrough": "1" })
      res.end("fallthrough")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  fs.rmSync(root, { recursive: true, force: true })
})

const urlOf = (token: string, name = "file") => `${base}${mobilePreviewPath(token, name)}`

describe("预览链接", () => {
  it("凭令牌取文件：不用 Authorization；内容、类型、安全头、CORS 头都对", async () => {
    const token = store.register(textFile)
    const res = await fetch(urlOf(token, "报告 1.txt"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello world")
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("content-length")).toBe("11")
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("Range：206 + Content-Range，内容是对应的字节（拖动播放进度）", async () => {
    const token = store.register(binFile)
    const res = await fetch(urlOf(token), { headers: { range: "bytes=10-19" } })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe("bytes 10-19/1000")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(Array.from({ length: 10 }, (_, i) => (10 + i) % 251)))
  })

  it("Range 越界：416", async () => {
    const token = store.register(binFile)
    const res = await fetch(urlOf(token), { headers: { range: "bytes=5000-6000" } })
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe("bytes */1000")
  })

  it("HEAD：只有头，没有内容", async () => {
    const token = store.register(binFile)
    const res = await fetch(urlOf(token), { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-length")).toBe("1000")
    expect(await res.text()).toBe("")
  })

  it("把令牌、令牌之下的路径、请求方法和 Range 头原样交给仓库（HEAD 不用白白打开文件流）", async () => {
    const seen: unknown[] = []
    serveOverride = (token, rel, opts) => {
      seen.push({ token, rel, opts })
      return { status: 204, headers: {} }
    }
    try {
      const token = "a".repeat(24)
      await fetch(`${base}/api/mobile/pv/${token}/sub/a%20b.css`, { method: "HEAD", headers: { range: "bytes=1-2" } })
      await fetch(`${base}/api/mobile/pv/${token}/x`)
    } finally {
      serveOverride = undefined
    }
    expect(seen).toEqual([
      { token: "a".repeat(24), rel: "/sub/a%20b.css", opts: { range: "bytes=1-2", method: "HEAD" } },
      { token: "a".repeat(24), rel: "/x", opts: { range: null, method: "GET" } },
    ])
  })

  it("不认识的令牌（格式对）：403，什么都不给", async () => {
    const res = await fetch(urlOf("0".repeat(24)))
    expect(res.status).toBe(403)
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts")
    expect(await res.text()).not.toContain("hello")
  })

  it("令牌过了有效期：403；在用的令牌（每次请求续期）不会过期", async () => {
    const token = store.register(textFile)
    now += 50_000
    expect((await fetch(urlOf(token))).status).toBe(200)
    now += 50_000
    expect((await fetch(urlOf(token))).status).toBe(200)
    now += 61_000
    expect((await fetch(urlOf(token))).status).toBe(403)
  })

  it("格式不对的令牌、不是预览链接、非 GET/HEAD：不处理（返回给下一个路由）", async () => {
    for (const url of [`${base}/api/mobile/pv/xyz/a`, `${base}/api/mobile/pv/`, `${base}/api/mobile/other`]) {
      const res = await fetch(url)
      expect(res.headers.get("x-fallthrough"), url).toBe("1")
      expect(res.headers.get("access-control-allow-origin"), url).toBeNull()
    }
    const token = store.register(textFile)
    const post = await fetch(urlOf(token), { method: "POST", body: "{}" })
    expect(post.headers.get("x-fallthrough")).toBe("1")
  })
})

describe("html / md 的目录令牌", () => {
  it("同目录的样式、页面按各自的类型返回", async () => {
    const token = store.register(path.join(site, "index.html"), { scopeDir: true })
    const page = await fetch(`${base}/api/mobile/pv/${token}/index.html`)
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await page.text()).toBe("<h1>hi</h1>")
    const css = await fetch(`${base}/api/mobile/pv/${token}/style.css`)
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect(await css.text()).toBe("h1{color:red}")
  })

  it("用编码过的 .. 走出目录：读不到外面的文件", async () => {
    const token = store.register(path.join(site, "index.html"), { scopeDir: true })
    for (const rel of ["%2e%2e%2foutside%2fsecret.txt", "..%2foutside%2fsecret.txt", "%2e%2e/outside/secret.txt"]) {
      const res = await fetch(`${base}/api/mobile/pv/${token}/${rel}`)
      expect(res.status, rel).toBeGreaterThanOrEqual(400)
      expect(await res.text(), rel).not.toContain("TOP SECRET")
    }
  })

  it("单文件令牌不管后面写什么路径，都只给登记的那个文件", async () => {
    const token = store.register(textFile)
    const res = await fetch(`${base}/api/mobile/pv/${token}/..%2foutside%2fsecret.txt`)
    expect(await res.text()).toBe("hello world")
  })
})

describe("连接中断和读取出错", () => {
  const slowStream = () => {
    let sent = 0
    const body = new Readable({
      read() {
        // 每次给一点，不结束：只有对方断开（或被关掉）才会停
        setTimeout(() => this.push(Buffer.alloc(1024, 97)), 5)
        sent++
      },
    })
    return { body, sent: () => sent }
  }
  const stub = (body: Readable): PreviewFileStore["serve"] => () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body })

  it("手机提前断开：文件流被关掉，不会一直开着", async () => {
    const { body } = slowStream()
    serveOverride = stub(body)
    try {
      const ctrl = new AbortController()
      const res = await fetch(urlOf("1".repeat(24)), { signal: ctrl.signal })
      const reader = res.body!.getReader()
      await reader.read()
      ctrl.abort()
      const end = Date.now() + 3000
      while (!body.destroyed && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
      expect(body.destroyed).toBe(true)
    } finally {
      serveOverride = undefined
    }
  })

  it("读文件中途出错：连接被掐断（对方读不完整，而不是以为拿到了完整内容）", async () => {
    let n = 0
    const body = new Readable({
      read() {
        if (n++ === 0) this.push(Buffer.alloc(100, 98))
        else setTimeout(() => this.destroy(new Error("disk error")), 5)
      },
    })
    serveOverride = stub(body)
    try {
      const res = await fetch(urlOf("2".repeat(24)))
      await expect(res.arrayBuffer()).rejects.toThrow()
    } finally {
      serveOverride = undefined
    }
  })
})
