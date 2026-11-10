import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import AdmZip from "adm-zip"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createPreviewFileStore } from "../src/shared/preview-file-store"
import {
  createPreviewChecker, createPreviewOpener, listZipByToken, readPreviewBytesByToken, readPreviewTextByToken, type PreviewOpenDeps,
} from "../src/shared/preview-open"
import { PREVIEW_CHECK_MAX_PATHS, PREVIEW_MAX_DOCUMENT_BYTES, PREVIEW_MAX_TEXT_BYTES } from "../src/shared/preview-types"

let root: string
let work: string
let elsewhere: string
/** it.runIf 要在收集阶段就知道条件：提前探测一次能不能建目录链接 */
const canLink = (() => {
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
})()

const SESSION = "app:chan:dir:work"

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lk-preview-open-")))
  work = path.join(root, "work")
  elsewhere = path.join(root, "elsewhere")
  fs.mkdirSync(path.join(work, "sub"), { recursive: true })
  fs.mkdirSync(path.join(work, "dir"))
  fs.mkdirSync(elsewhere)
  fs.mkdirSync(path.join(root, "work-evil"))
  fs.writeFileSync(path.join(work, "a.md"), "# hi")
  fs.writeFileSync(path.join(work, "page.html"), "<p>x</p>")
  fs.writeFileSync(path.join(work, "sub", "main.ts"), "export const x = 1")
  fs.writeFileSync(path.join(work, "notes.txt"), "hello")
  fs.writeFileSync(path.join(elsewhere, "c.txt"), "outside")
  fs.writeFileSync(path.join(root, "work-evil", "x.txt"), "evil sibling")
  if (canLink) fs.symlinkSync(elsewhere, path.join(work, "escape"), "junction")
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function setup(over: Partial<PreviewOpenDeps> & { referenced?: string[] } = {}) {
  const store = createPreviewFileStore()
  let registered = 0
  const counting = { ...store, register: (...args: Parameters<typeof store.register>) => { registered++; return store.register(...args) } }
  const asked: [string, string][] = []
  const deps: PreviewOpenDeps = {
    isAppSession: over.isAppSession ?? ((key) => key === SESSION),
    isReferenced: over.isReferenced ?? (async (key, file) => { asked.push([key, file]); return (over.referenced ?? []).includes(file) }),
    workDir: over.workDir ?? (() => work),
  }
  return { store, open: createPreviewOpener(counting, deps), registered: () => registered, asked }
}

describe("createPreviewOpener：参数和文件本身", () => {
  it("不是应用内会话（别的通道、乱写的键、不是字符串）：不给预览", async () => {
    const { open, registered } = setup()
    for (const key of ["feishu:x:dir:work", "", "garbage"]) {
      expect(await open(key, path.join(work, "notes.txt")), key).toEqual({ ok: false, error: "不是应用内对话的会话" })
    }
    expect((await open(undefined as unknown as string, path.join(work, "notes.txt"))).ok).toBe(false)
    expect(registered()).toBe(0)
  })

  it("相对路径、空、不是字符串：路径无效", async () => {
    const { open, registered } = setup()
    for (const file of ["notes.txt", "./notes.txt", "..\\x", "", undefined as unknown as string, 42 as unknown as string]) {
      expect(await open(SESSION, file), String(file)).toEqual({ ok: false, error: "文件路径无效" })
    }
    expect(registered()).toBe(0)
  })

  it("文件不存在 / 是目录", async () => {
    const { open } = setup()
    expect(await open(SESSION, path.join(work, "gone.txt"))).toEqual({ ok: false, error: "文件不存在，可能已被移动或删除" })
    expect(await open(SESSION, path.join(work, "dir"))).toEqual({ ok: false, error: "不是文件" })
  })
})

describe("createPreviewOpener：能不能看", () => {
  it("工作目录里的文件：登记令牌并返回类型、大小、地址", async () => {
    const { open, store } = setup()
    const r = await open(SESSION, path.join(work, "sub", "main.ts"))
    if (!r.ok) throw new Error(r.error)
    expect(r).toMatchObject({ name: "main.ts", kind: "code", lang: "typescript", size: 18 })
    expect(r.url).toBe(store.urlFor(r.token))
    expect(store.lookup(r.token)?.file).toBe(path.join(work, "sub", "main.ts"))
    expect(r.mtimeMs).toBeGreaterThan(0)
  })

  it("html 和 md 的令牌覆盖所在目录（要加载同目录的样式/图片），其它类型只覆盖文件本身", async () => {
    const { open, store } = setup()
    const scope = async (name: string) => {
      const r = await open(SESSION, path.join(work, name))
      if (!r.ok) throw new Error(r.error)
      return store.lookup(r.token)?.scopeDir
    }
    expect(await scope("a.md")).toBe(true)
    expect(await scope("page.html")).toBe(true)
    expect(await scope("notes.txt")).toBe(false)
  })

  it("工作目录之外、会话记录里也没出现过：拒绝，不登记令牌", async () => {
    const { open, registered } = setup()
    const r = await open(SESSION, path.join(elsewhere, "c.txt"))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain("不能预览")
    expect(registered()).toBe(0)
  })

  it("名字前缀相同的兄弟目录不算工作目录之内", async () => {
    const { open } = setup()
    expect((await open(SESSION, path.join(root, "work-evil", "x.txt"))).ok).toBe(false)
  })

  it("工作目录之外但会话记录里出现过（Agent 发的文件卡）：可以预览，查记录用的是界面给的原路径", async () => {
    const file = path.join(elsewhere, "c.txt")
    const { open, asked } = setup({ referenced: [file] })
    const r = await open(SESSION, file)
    expect(r.ok).toBe(true)
    expect(asked).toEqual([[SESSION, file]])
  })

  it("没有工作目录 / 工作目录不存在：只认会话记录，不抛错", async () => {
    const file = path.join(work, "notes.txt")
    expect((await setup({ workDir: () => undefined }).open(SESSION, file)).ok).toBe(false)
    expect((await setup({ workDir: () => path.join(root, "no-such-dir") }).open(SESSION, file)).ok).toBe(false)
    expect((await setup({ workDir: () => undefined, referenced: [file] }).open(SESSION, file)).ok).toBe(true)
  })

  it("查会话记录出错（守护进程不可用）：按没出现过处理，工作目录里的文件照样能看，之外的拒绝", async () => {
    const boom = async () => { throw new Error("daemon down") }
    const { open } = setup({ isReferenced: boom })
    expect((await open(SESSION, path.join(work, "notes.txt"))).ok).toBe(true)
    expect((await open(SESSION, path.join(elsewhere, "c.txt"))).ok).toBe(false)
  })

  it.runIf(canLink)("工作目录里的链接指向目录外：按真实位置判断，拒绝；记录里出现过的则放行并登记真实路径", async () => {
    const viaLink = path.join(work, "escape", "c.txt")
    expect((await setup().open(SESSION, viaLink)).ok).toBe(false)
    const { open, store } = setup({ referenced: [viaLink] })
    const r = await open(SESSION, viaLink)
    if (!r.ok) throw new Error(r.error)
    expect(store.lookup(r.token)?.file).toBe(path.join(elsewhere, "c.txt"))
  })

  it("每个会话各看各的：别的会话的工作目录不通用", async () => {
    const { open } = setup({ workDir: (key) => (key === SESSION ? work : elsewhere), isAppSession: () => true })
    expect((await open("app:chan:dir:other", path.join(work, "notes.txt"))).ok).toBe(false)
    expect((await open(SESSION, path.join(work, "notes.txt"))).ok).toBe(true)
  })
})

describe("createPreviewChecker", () => {
  function checker(over: Partial<PreviewOpenDeps> & { referenced?: string[] } = {}) {
    const asked: string[] = []
    const check = createPreviewChecker({
      isAppSession: over.isAppSession ?? ((key) => key === SESSION),
      isReferenced: over.isReferenced ?? (async (_key, file) => { asked.push(file); return (over.referenced ?? []).includes(file) }),
      workDir: over.workDir ?? (() => work),
    })
    return { check, asked }
  }

  it("相对路径按工作目录解析，返回绝对路径；不存在的、目录、工作目录之外的是 null，数量和顺序与输入一致", async () => {
    const { check } = checker()
    const out = await check(SESSION, ["notes.txt", "./sub/main.ts", "gone.txt", "dir", path.join(elsewhere, "c.txt"), path.join(work, "a.md")])
    expect(out).toEqual([
      path.join(work, "notes.txt"),
      path.join(work, "sub", "main.ts"),
      null,
      null,
      null,
      path.join(work, "a.md"),
    ])
  })

  it("绝对路径里的 .. 和多余分隔符先规整，返回规整后的路径（界面拿它去开文件、去重）", async () => {
    const { check } = checker()
    const messy = `${work}${path.sep}sub${path.sep}..${path.sep}${path.sep}notes.txt`
    expect(await check(SESSION, [messy])).toEqual([path.join(work, "notes.txt")])
  })

  it("..  跳出工作目录的相对路径：不放行", async () => {
    const { check } = checker()
    expect(await check(SESSION, ["../elsewhere/c.txt", "sub/../../elsewhere/c.txt"])).toEqual([null, null])
  })

  it("工作目录之外但会话记录里出现过的绝对路径：放行", async () => {
    const file = path.join(elsewhere, "c.txt")
    const { check } = checker({ referenced: [file] })
    expect(await check(SESSION, [file])).toEqual([file])
  })

  it("工作目录里的文件不用查会话记录（批量检查时省掉守护进程的往返）", async () => {
    const { check, asked } = checker()
    await check(SESSION, ["notes.txt", "sub/main.ts"])
    expect(asked).toEqual([])
  })

  it("工作目录之外的才去查记录，查出错就当没有", async () => {
    const boom = async () => { throw new Error("daemon down") }
    const { check } = checker({ isReferenced: boom })
    expect(await check(SESSION, [path.join(elsewhere, "c.txt"), "notes.txt"])).toEqual([null, path.join(work, "notes.txt")])
  })

  it("不是应用内会话、没有工作目录时的相对路径：全是 null，不抛错", async () => {
    expect(await checker().check("feishu:x:dir:work", ["notes.txt", path.join(work, "notes.txt")])).toEqual([null, null])
    expect(await checker({ workDir: () => undefined }).check(SESSION, ["notes.txt"])).toEqual([null])
  })

  it("~ 开头、空串、含 NUL、过长、不是字符串：null", async () => {
    const { check } = checker()
    expect(await check(SESSION, ["~/x.txt", "", "a\0b.txt", "a".repeat(601) + ".txt", 42 as unknown as string, undefined as unknown as string])).toEqual([null, null, null, null, null, null])
  })

  it("超过数量上限的部分一律是 null；参数不是数组返回空数组", async () => {
    const { check } = checker()
    const many = Array.from({ length: PREVIEW_CHECK_MAX_PATHS + 5 }, () => "notes.txt")
    const out = await check(SESSION, many)
    expect(out).toHaveLength(many.length)
    expect(out.slice(0, PREVIEW_CHECK_MAX_PATHS).every((p) => p === path.join(work, "notes.txt"))).toBe(true)
    expect(out.slice(PREVIEW_CHECK_MAX_PATHS)).toEqual([null, null, null, null, null])
    expect(await check(SESSION, "notes.txt" as unknown as string[])).toEqual([])
  })

  it.runIf(canLink)("工作目录里指向目录外的链接：按真实位置判断，不放行", async () => {
    const { check } = checker()
    expect(await check(SESSION, ["escape/c.txt"])).toEqual([null])
  })
})

describe("readPreviewTextByToken", () => {
  const registerFile = (name: string, content: Buffer | string) => {
    const store = createPreviewFileStore()
    const file = path.join(root, name)
    fs.writeFileSync(file, content)
    return { store, file, token: store.register(file) }
  }

  it("没登记过 / 不是字符串的令牌：预览已失效", async () => {
    const store = createPreviewFileStore()
    expect(await readPreviewTextByToken(store, "nope")).toEqual({ ok: false, error: "预览已失效，请重新打开" })
    expect((await readPreviewTextByToken(store, undefined as unknown as string)).ok).toBe(false)
  })

  it("UTF-8 文本", async () => {
    const { store, token } = registerFile("t-utf8.txt", "你好\nworld")
    expect(await readPreviewTextByToken(store, token)).toEqual({ ok: true, text: "你好\nworld", encoding: "utf-8", size: 12, truncated: false })
  })

  it("GBK 文本（国内 Windows 的 txt）", async () => {
    const { store, token } = registerFile("t-gbk.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    expect(await readPreviewTextByToken(store, token)).toMatchObject({ ok: true, text: "你好", encoding: "gb18030" })
  })

  it("二进制文件：不当文本显示", async () => {
    const { store, token } = registerFile("t-bin.txt", Buffer.from([0x50, 0x4b, 0, 0, 1, 2, 3]))
    expect(await readPreviewTextByToken(store, token)).toEqual({ ok: false, error: "这是二进制文件，无法按文本显示" })
  })

  it("超过上限只读开头一段并标出被截断；切在多字节字符中间不产生乱码", async () => {
    // 3 字节的汉字，上限不是 3 的倍数 → 一定切在字符中间
    expect(PREVIEW_MAX_TEXT_BYTES % 3).not.toBe(0)
    const { store, token } = registerFile("t-big.txt", Buffer.from("你".repeat(Math.ceil(PREVIEW_MAX_TEXT_BYTES / 3) + 10)))
    const r = await readPreviewTextByToken(store, token)
    if (!r.ok) throw new Error(r.error)
    expect(r.truncated).toBe(true)
    expect(r.size).toBeGreaterThan(PREVIEW_MAX_TEXT_BYTES)
    expect(r.encoding).toBe("utf-8")
    expect(r.text).not.toContain("\uFFFD")
    expect(r.text.length).toBe(Math.floor(PREVIEW_MAX_TEXT_BYTES / 3))
  })

  it("空文件：空文本", async () => {
    const { store, token } = registerFile("t-empty.txt", "")
    expect(await readPreviewTextByToken(store, token)).toMatchObject({ ok: true, text: "", size: 0, truncated: false })
  })

  it("文件在登记之后被删：读取失败", async () => {
    const { store, token, file } = registerFile("t-gone.txt", "x")
    fs.rmSync(file)
    expect(await readPreviewTextByToken(store, token)).toEqual({ ok: false, error: "读取文件失败，可能已被移动或删除" })
  })
})

describe("readPreviewBytesByToken", () => {
  const registerFile = (name: string, content: Buffer | string) => {
    const store = createPreviewFileStore()
    const file = path.join(root, name)
    fs.writeFileSync(file, content)
    return { store, file, token: store.register(file) }
  }

  it("读出整个文件的字节（二进制原样）", async () => {
    const { store, token } = registerFile("b-doc.bin", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255, 128]))
    const r = await readPreviewBytesByToken(store, token)
    if (!r.ok) throw new Error(r.error)
    expect(Array.from(r.bytes)).toEqual([0x50, 0x4b, 0x03, 0x04, 0, 255, 128])
  })

  it("没登记过 / 不是字符串的令牌：预览已失效", async () => {
    const store = createPreviewFileStore()
    expect(await readPreviewBytesByToken(store, "nope")).toEqual({ ok: false, error: "预览已失效，请重新打开" })
    expect((await readPreviewBytesByToken(store, undefined as unknown as string)).ok).toBe(false)
  })

  it("超过上限不读，说清楚文件多大、上限多少", async () => {
    const { store, token } = registerFile("b-big.bin", Buffer.alloc(3 * 1024 * 1024))
    const r = await readPreviewBytesByToken(store, token, 2 * 1024 * 1024)
    expect(r).toEqual({ ok: false, error: "文件有 3.0 MB，超过应用内预览的上限（2 MB），请用其他程序打开" })
  })

  it("刚好等于上限可以读", async () => {
    const { store, token } = registerFile("b-edge.bin", Buffer.alloc(1024))
    expect((await readPreviewBytesByToken(store, token, 1024)).ok).toBe(true)
  })

  it("默认上限是 25 MB", async () => {
    expect(PREVIEW_MAX_DOCUMENT_BYTES).toBe(25 * 1024 * 1024)
  })

  it("文件在登记之后被删：读取失败", async () => {
    const { store, token, file } = registerFile("b-gone.bin", "x")
    fs.rmSync(file)
    expect(await readPreviewBytesByToken(store, token)).toEqual({ ok: false, error: "读取文件失败，可能已被移动或删除" })
  })
})

describe("listZipByToken", () => {
  const registerZip = (name: string, build: (z: AdmZip) => void) => {
    const store = createPreviewFileStore()
    const file = path.join(root, name)
    const z = new AdmZip()
    build(z)
    fs.writeFileSync(file, z.toBuffer())
    return { store, file, token: store.register(file) }
  }

  it("列出真实文件里的清单，并带上文件大小", async () => {
    const { store, token, file } = registerZip("z-ok.zip", (z) => {
      z.addFile("a.txt", Buffer.from("hello"))
      z.addFile("dir/b.txt", Buffer.from("world!"))
    })
    const r = await listZipByToken(store, token)
    if (!r.ok) throw new Error(r.error)
    expect(r.size).toBe(fs.statSync(file).size)
    expect(r.total).toBe(2)
    expect(r.truncated).toBe(false)
    expect(r.entries.map((e) => [e.name, e.size])).toEqual([["a.txt", 5], ["dir/b.txt", 6]])
  })

  it("没登记过的令牌：预览已失效", async () => {
    expect(await listZipByToken(createPreviewFileStore(), "nope")).toEqual({ ok: false, error: "预览已失效，请重新打开" })
  })

  it("不是 zip（改了扩展名的文本）：说清楚是文件格式不对", async () => {
    const store = createPreviewFileStore()
    const file = path.join(root, "z-fake.zip")
    fs.writeFileSync(file, "this is plain text pretending to be a zip archive, nothing more")
    const r = await listZipByToken(store, store.register(file))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("不是有效的 zip 文件")
  })

  it("空文件、过短的文件：同样是格式不对，不抛到界面", async () => {
    const store = createPreviewFileStore()
    const file = path.join(root, "z-empty.zip")
    fs.writeFileSync(file, "")
    const r = await listZipByToken(store, store.register(file))
    expect(r.ok).toBe(false)
  })

  it("文件在登记之后被删：读取失败", async () => {
    const { store, token, file } = registerZip("z-gone.zip", (z) => z.addFile("a", Buffer.from("x")))
    fs.rmSync(file)
    expect(await listZipByToken(store, token)).toEqual({ ok: false, error: "读取文件失败，可能已被移动或删除" })
  })
})
