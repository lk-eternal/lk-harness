import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PREVIEW_SCHEME, createPreviewFileStore, isPathInside } from "../src/shared/preview-file-store"

let root: string
let site: string
let outside: string
let bigFile: string
let emptyFile: string
let canSymlink = false

async function readBody(body: Readable | undefined): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lk-preview-store-")))
  site = path.join(root, "site")
  outside = path.join(root, "outside")
  fs.mkdirSync(path.join(site, "img"), { recursive: true })
  fs.mkdirSync(path.join(site, "sub"))
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(root, "site-evil"))
  fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>")
  fs.writeFileSync(path.join(site, "style.css"), "h1{color:red}")
  fs.writeFileSync(path.join(site, "img", "a.png"), Buffer.from([1, 2, 3]))
  fs.writeFileSync(path.join(site, "sub", "page.html"), "sub")
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET")
  fs.writeFileSync(path.join(root, "site-evil", "x.txt"), "evil sibling")
  bigFile = path.join(root, "big.bin")
  fs.writeFileSync(bigFile, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)))
  emptyFile = path.join(root, "empty.txt")
  fs.writeFileSync(emptyFile, "")
  try {
    // 目录联接（junction）在 Windows 上不需要管理员权限；POSIX 上这个类型会被忽略，建成普通符号链接
    fs.symlinkSync(outside, path.join(site, "jlink"), "junction")
    canSymlink = true
  } catch { /* 建不了链接的环境跳过相关用例 */ }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("isPathInside", () => {
  it("目录自身和里面的东西算在里面", () => {
    expect(isPathInside(site, site)).toBe(true)
    expect(isPathInside(site, path.join(site, "a", "b.txt"))).toBe(true)
    // 名字以两个点开头的普通文件不是“上级目录”
    expect(isPathInside(site, path.join(site, "..weird.txt"))).toBe(true)
  })
  it("外面的、上级、同名前缀的兄弟目录都不算", () => {
    expect(isPathInside(site, path.join(root, "outside", "x"))).toBe(false)
    expect(isPathInside(site, root)).toBe(false)
    expect(isPathInside(site, path.join(root, "site-evil", "x.txt"))).toBe(false)
    expect(isPathInside(site, path.join(site, "..", "outside"))).toBe(false)
  })
  it.runIf(process.platform === "win32")("Windows 上不区分大小写，跨盘符不算", () => {
    expect(isPathInside("C:\\Work\\Site", "c:\\work\\site\\a.txt")).toBe(true)
    expect(isPathInside("C:\\Work\\Site", "D:\\Work\\Site\\a.txt")).toBe(false)
  })
})

describe("register / lookup / urlFor", () => {
  it("同一个文件重复登记得到同一个令牌，不同文件不同", () => {
    const store = createPreviewFileStore()
    const a = store.register(bigFile)
    expect(store.register(bigFile)).toBe(a)
    expect(store.register(emptyFile)).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{24}$/)
  })

  it("整目录令牌和单文件令牌是两个令牌", () => {
    const store = createPreviewFileStore()
    const file = store.register(path.join(site, "index.html"))
    const dir = store.register(path.join(site, "index.html"), { scopeDir: true })
    expect(dir).not.toBe(file)
    expect(store.lookup(file)?.scopeDir).toBe(false)
    expect(store.lookup(dir)?.scopeDir).toBe(true)
  })

  it("urlFor：lkfile://令牌/编码后的文件名", () => {
    const store = createPreviewFileStore()
    const file = path.join(root, "my file#1.txt")
    fs.writeFileSync(file, "x")
    const token = store.register(file)
    expect(store.urlFor(token)).toBe(`${PREVIEW_SCHEME}://${token}/my%20file%231.txt`)
  })

  it("令牌是随机的：两个仓库给同一文件的令牌不同", () => {
    expect(createPreviewFileStore().register(bigFile)).not.toBe(createPreviewFileStore().register(bigFile))
  })
})

describe("serve：单文件令牌", () => {
  it("没登记过的令牌 403", () => {
    const store = createPreviewFileStore()
    expect(store.serve("deadbeef", "/x").status).toBe(403)
    expect(store.serve("", "/").status).toBe(403)
  })

  it("整份返回：状态 200，长度、类型和安全头齐全", async () => {
    const store = createPreviewFileStore()
    const r = store.serve(store.register(bigFile), "/big.bin")
    expect(r.status).toBe(200)
    expect(r.headers["content-length"]).toBe("1000")
    expect(r.headers["accept-ranges"]).toBe("bytes")
    expect(r.headers["cache-control"]).toBe("no-store")
    expect(r.headers["x-content-type-options"]).toBe("nosniff")
    expect(r.headers["content-type"]).toBe("application/octet-stream")
    expect(r.headers["content-range"]).toBeUndefined()
    expect(await readBody(r.body)).toEqual(fs.readFileSync(bigFile))
  })

  it("单文件令牌不看请求路径：想靠路径读同目录别的文件不行", async () => {
    const store = createPreviewFileStore()
    const token = store.register(path.join(site, "index.html"))
    const r = store.serve(token, "/../outside/secret.txt")
    expect((await readBody(r.body)).toString()).toBe("<h1>hi</h1>")
    const r2 = store.serve(token, "/style.css")
    expect((await readBody(r2.body)).toString()).toBe("<h1>hi</h1>")
  })

  it("Range：区间 206 + Content-Range，内容是对应的字节", async () => {
    const store = createPreviewFileStore()
    const token = store.register(bigFile)
    const whole = fs.readFileSync(bigFile)

    const mid = store.serve(token, "/", { range: "bytes=10-19" })
    expect(mid.status).toBe(206)
    expect(mid.headers["content-range"]).toBe("bytes 10-19/1000")
    expect(mid.headers["content-length"]).toBe("10")
    expect(await readBody(mid.body)).toEqual(whole.subarray(10, 20))

    const tail = store.serve(token, "/", { range: "bytes=990-" })
    expect(tail.status).toBe(206)
    expect(tail.headers["content-range"]).toBe("bytes 990-999/1000")
    expect(await readBody(tail.body)).toEqual(whole.subarray(990))

    const suffix = store.serve(token, "/", { range: "bytes=-5" })
    expect(suffix.headers["content-range"]).toBe("bytes 995-999/1000")
    expect(await readBody(suffix.body)).toEqual(whole.subarray(995))
  })

  it("Range 越界：416，Content-Range 标出文件大小，没有 body", () => {
    const store = createPreviewFileStore()
    const r = store.serve(store.register(bigFile), "/", { range: "bytes=2000-" })
    expect(r.status).toBe(416)
    expect(r.headers["content-range"]).toBe("bytes */1000")
    expect(r.body).toBeUndefined()
  })

  it("HEAD：只有头，没有 body；Range 也照样回 206 的头", () => {
    const store = createPreviewFileStore()
    const token = store.register(bigFile)
    const head = store.serve(token, "/", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(head.headers["content-length"]).toBe("1000")
    expect(head.body).toBeUndefined()
    const ranged = store.serve(token, "/", { method: "HEAD", range: "bytes=0-9" })
    expect(ranged.status).toBe(206)
    expect(ranged.body).toBeUndefined()
  })

  it("空文件：200，长度 0，没有 body", () => {
    const store = createPreviewFileStore()
    const r = store.serve(store.register(emptyFile), "/")
    expect(r.status).toBe(200)
    expect(r.headers["content-length"]).toBe("0")
    expect(r.body).toBeUndefined()
  })

  it("文件在登记之后被删了：404", () => {
    const store = createPreviewFileStore()
    const gone = path.join(root, "gone.txt")
    fs.writeFileSync(gone, "x")
    const token = store.register(gone)
    fs.rmSync(gone)
    expect(store.serve(token, "/").status).toBe(404)
  })
})

describe("serve：整目录令牌（html / md 引用同目录资源）", () => {
  const entry = () => path.join(site, "index.html")

  it("入口文件和同目录里的资源都能读，类型按扩展名", async () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    const page = store.serve(token, "/index.html")
    expect(page.status).toBe(200)
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect((await readBody(page.body)).toString()).toBe("<h1>hi</h1>")

    const css = store.serve(token, "/style.css")
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8")
    expect(store.serve(token, "/img/a.png").status).toBe(200)
    expect(store.serve(token, "/sub%2Fpage.html").status).toBe(200)
    // 路径为空（只给了令牌）就是入口文件
    expect((await readBody(store.serve(token, "/").body)).toString()).toBe("<h1>hi</h1>")
  })

  it("用 .. 走出目录：403，读不到上级目录的文件", () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    for (const rel of [
      "/../outside/secret.txt",
      "/..%2Foutside%2Fsecret.txt",
      "/%2e%2e/outside/secret.txt",
      "/img/../../outside/secret.txt",
      "/..\\outside\\secret.txt",
    ]) {
      const r = store.serve(token, rel)
      expect(r.status, rel).toBe(403)
      expect(r.body, rel).toBeUndefined()
    }
  })

  it("名字前缀相同的兄弟目录（site-evil）也不能进", () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    expect(store.serve(token, "/../site-evil/x.txt").status).toBe(403)
  })

  it("给绝对路径也读不到目录外的文件", () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    const abs = path.join(outside, "secret.txt")
    for (const rel of ["/" + abs.replace(/\\/g, "/"), "/" + encodeURIComponent(abs), abs]) {
      const r = store.serve(token, rel)
      expect(r.status, rel).not.toBe(200)
      expect(r.status, rel).not.toBe(206)
    }
  })

  it.runIf(canLinkAtCollect())("目录里的链接指向目录外：403（不能借链接读到目录外的文件）", () => {
    expect(canSymlink).toBe(true)
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    expect(store.serve(token, "/jlink/secret.txt").status).toBe(403)
  })

  it("坏的百分号编码和 NUL：400", () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    expect(store.serve(token, "/%E0%A4%A").status).toBe(400)
    expect(store.serve(token, "/index.html%00.png").status).toBe(400)
  })

  it("不存在的文件 404；目录不是文件，404", () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    expect(store.serve(token, "/nope.css").status).toBe(404)
    expect(store.serve(token, "/sub").status).toBe(404)
  })

  it("目录令牌也支持 Range", async () => {
    const store = createPreviewFileStore()
    const token = store.register(entry(), { scopeDir: true })
    const r = store.serve(token, "/style.css", { range: "bytes=0-1" })
    expect(r.status).toBe(206)
    expect((await readBody(r.body)).toString()).toBe("h1")
  })
})

describe("令牌淘汰", () => {
  const files = ["a", "b", "c", "d"].map((n) => {
    const f = path.join(os.tmpdir(), `lk-preview-lru-${process.pid}-${n}.txt`)
    fs.writeFileSync(f, n)
    return f
  })
  afterAll(() => { for (const f of files) fs.rmSync(f, { force: true }) })

  it("超过上限，最旧的先被淘汰；淘汰后再登记是新令牌", () => {
    const store = createPreviewFileStore(2)
    const [a, b, c] = files.slice(0, 3).map((f) => store.register(f))
    expect(store.lookup(a)).toBeUndefined()
    expect(store.serve(a, "/").status).toBe(403)
    expect(store.lookup(b)).toBeDefined()
    expect(store.lookup(c)).toBeDefined()
    expect(store.register(files[0])).not.toBe(a)
  })

  it("重复登记会刷新“最近使用”：被再次打开的不会先被淘汰", () => {
    const store = createPreviewFileStore(2)
    const a = store.register(files[0])
    const b = store.register(files[1])
    expect(store.register(files[0])).toBe(a)
    const c = store.register(files[2])
    expect(store.lookup(b)).toBeUndefined()
    expect(store.lookup(a)).toBeDefined()
    expect(store.lookup(c)).toBeDefined()
  })
})

describe("令牌有效期（手机端用，令牌在 HTTP 链接里）", () => {
  const MIN = 60_000
  const setup = (ttlMs = 30 * MIN) => {
    let t = 1_000_000
    const store = createPreviewFileStore(300, { ttlMs, now: () => t })
    return { store, advance: (ms: number) => { t += ms } }
  }
  /** 只看状态码；响应带的文件流要读完，否则测试结束删临时目录时它还没打开完 */
  const statusOf = async (r: ReturnType<ReturnType<typeof createPreviewFileStore>["serve"]>) => {
    await readBody(r.body)
    return r.status
  }

  it("没设 ttlMs（电脑端）：令牌一直有效", async () => {
    const store = createPreviewFileStore(300, { now: () => Number.MAX_SAFE_INTEGER })
    const token = store.register(bigFile)
    expect(store.lookup(token)).toBeDefined()
    expect(await statusOf(store.serve(token, "/x"))).toBe(200)
  })

  it("过了有效期没人用，令牌失效：lookup 取不到、serve 403", () => {
    const { store, advance } = setup()
    const token = store.register(bigFile)
    advance(30 * MIN - 1)
    expect(store.lookup(token)).toBeDefined()
    advance(30 * MIN + 1)
    expect(store.lookup(token)).toBeUndefined()
    expect(store.serve(token, "/x").status).toBe(403)
  })

  it("刚好到期的那一刻就失效", () => {
    const { store, advance } = setup(MIN)
    const token = store.register(bigFile)
    advance(MIN)
    expect(store.lookup(token)).toBeUndefined()
  })

  it("用一次续一次：正在使用的令牌不会到期（长视频一直在发 Range 请求）", async () => {
    const { store, advance } = setup()
    const token = store.register(bigFile)
    for (let i = 0; i < 5; i++) {
      advance(20 * MIN)
      expect(await statusOf(store.serve(token, "/x", { range: "bytes=0-9" }))).toBe(206)
    }
    expect(store.lookup(token)).toBeDefined()
  })

  it("lookup 也算使用，同样续期", () => {
    const { store, advance } = setup()
    const token = store.register(bigFile)
    advance(25 * MIN)
    expect(store.lookup(token)).toBeDefined()
    advance(25 * MIN)
    expect(store.lookup(token)).toBeDefined()
  })

  it("失效后重新登记同一个文件：得到新令牌，旧令牌仍然不能用", () => {
    const { store, advance } = setup()
    const old = store.register(bigFile)
    advance(31 * MIN)
    const fresh = store.register(bigFile)
    expect(fresh).not.toBe(old)
    expect(store.lookup(old)).toBeUndefined()
    expect(store.lookup(fresh)).toBeDefined()
  })

  it("旧令牌过期后被查询过，之后重新登记的新令牌仍然稳定（再登记得到同一个）", () => {
    const { store, advance } = setup()
    const old = store.register(bigFile)
    advance(31 * MIN)
    expect(store.lookup(old)).toBeUndefined()
    const fresh = store.register(bigFile)
    expect(store.register(bigFile)).toBe(fresh)
    expect(store.lookup(fresh)).toBeDefined()
  })

  it("还在有效期内重新登记：同一个令牌，并续期", () => {
    const { store, advance } = setup()
    const token = store.register(bigFile)
    advance(20 * MIN)
    expect(store.register(bigFile)).toBe(token)
    advance(20 * MIN)
    expect(store.lookup(token)).toBeDefined()
  })

  it("登记时顺手清掉过期的：名额满了挤掉的是过期的，不是还在用的", () => {
    let t = 0
    const store = createPreviewFileStore(2, { ttlMs: 60_000, now: () => t })
    const a = store.register(bigFile) // 登记最早，但后面一直有人用
    t = 10_000
    const b = store.register(emptyFile) // 之后没人用，到 70s 过期
    t = 50_000
    expect(store.lookup(a)).toBeDefined() // a 续期到 110s
    t = 75_000
    const c = store.register(path.join(site, "index.html"))
    expect(store.lookup(b)).toBeUndefined()
    expect(store.lookup(a)).toBeDefined()
    expect(store.lookup(c)).toBeDefined()
  })

  it("目录令牌也有有效期，过期后同目录的资源也读不了", async () => {
    const { store, advance } = setup()
    const token = store.register(path.join(site, "index.html"), { scopeDir: true })
    expect(await statusOf(store.serve(token, "/style.css"))).toBe(200)
    advance(31 * MIN)
    expect(store.serve(token, "/style.css").status).toBe(403)
  })
})

/** it.runIf 要在收集阶段就知道条件；这里提前探测一次能不能建目录链接 */
function canLinkAtCollect(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-link-probe-"))
  try {
    fs.mkdirSync(path.join(dir, "t"))
    fs.symlinkSync(path.join(dir, "t"), path.join(dir, "l"), "junction")
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
