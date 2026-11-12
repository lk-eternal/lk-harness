import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import fsCjs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import {
  deleteSessionRecord,
  getSessionRecord,
  initSessionOverridesStore,
  patchSessionRecord,
  readOverridesSnapshot,
  resetSessionOverridesStoreForTests,
} from "../src/shared/session-overrides-store"
import {
  ensureSessionEntry,
  listSessionEntries,
  readRoutingFileView,
  resetRoutingViewCacheForTests,
  resetSessionEntryKeyCacheForTests,
  sessionEntryDir,
  sessionStatePath,
  SESSION_KEY_FILE,
} from "../src/shared/session-entry-paths"
import { sessionStateDir } from "../src/shared/data-paths"
import { globalRoutingPath } from "../src/shared/session-entry-paths"

/**
 * 会话存储的读路径：几千个会话目录时，每次都整目录扫描就是列表卡顿的来源之一。
 * 真实文件 + 临时目录；用 readdirSync 的调用次数证明「按键读单个会话」不再扫目录。
 */

const KEY = "ch_a|oc_1::D:\\ws\\a"
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-store-scan-"))
  initSessionOverridesStore(root)
  resetSessionEntryKeyCacheForTests()
  resetRoutingViewCacheForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  resetSessionOverridesStoreForTests()
  fs.rmSync(root, { recursive: true, force: true })
})

/** 统计 fn 执行期间 readdirSync 读了几次会话根目录 */
function countRootListings(fn: () => void): number {
  const base = sessionStateDir(root)
  const real = fsCjs.readdirSync
  let n = 0
  // ESM 命名空间不能直接 spy：改 CJS 默认导出，再同步给 import * as fs 的模块
  vi.spyOn(fsCjs, "readdirSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p) === base) n++
    return (real as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readdirSync)
  syncBuiltinESMExports()
  try {
    fn()
  } finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  }
  return n
}

describe("listSessionEntries", () => {
  it("列出会话目录及各自的会话键，跳过 _global、点开头目录和普通文件", () => {
    ensureSessionEntry(root, KEY)
    fs.mkdirSync(path.join(sessionStateDir(root), "_global"), { recursive: true })
    fs.mkdirSync(path.join(sessionStateDir(root), ".tmp"), { recursive: true })
    fs.writeFileSync(path.join(sessionStateDir(root), "stray.txt"), "x")
    const list = listSessionEntries(root)
    expect(list).toEqual([{ dir: sessionEntryDir(root, KEY), sessionKey: KEY }])
  })

  it("已知目录不再重读 session-key.txt（目录名是键的哈希，键不会变）", () => {
    ensureSessionEntry(root, KEY)
    expect(listSessionEntries(root)[0].sessionKey).toBe(KEY)
    // 偷偷改掉文件内容：如果每轮都重读，这里会读到新值
    fs.writeFileSync(path.join(sessionEntryDir(root, KEY), SESSION_KEY_FILE), "changed", "utf8")
    expect(listSessionEntries(root)[0].sessionKey).toBe(KEY)
  })

  it("读不出键的目录不进缓存：session-key.txt 补写后下一轮就能看到", () => {
    const dir = sessionEntryDir(root, KEY)
    fs.mkdirSync(dir, { recursive: true }) // 刚建到一半：还没有 session-key.txt
    expect(listSessionEntries(root)).toEqual([])
    ensureSessionEntry(root, KEY)
    expect(listSessionEntries(root)).toEqual([{ dir, sessionKey: KEY }])
  })

  it("目录被删后从缓存里清掉：同名目录重建（键不同）读到的是新键", () => {
    ensureSessionEntry(root, KEY)
    listSessionEntries(root)
    const dir = sessionEntryDir(root, KEY)
    fs.rmSync(dir, { recursive: true, force: true })
    expect(listSessionEntries(root)).toEqual([])
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SESSION_KEY_FILE), "other-key", "utf8")
    expect(listSessionEntries(root)).toEqual([{ dir, sessionKey: "other-key" }])
  })

  it("会话根目录不存在时返回空", () => {
    expect(listSessionEntries(path.join(root, "nope"))).toEqual([])
  })
})

describe("getSessionRecord / deleteSessionRecord 不扫目录", () => {
  it("按键读单个会话：读盘一次都不列会话根目录", () => {
    patchSessionRecord(KEY, { model: "m1" })
    // 再放一批无关会话，扫描的话代价随它们增长
    for (let i = 0; i < 30; i++) patchSessionRecord(`ch_a|oc_${i}::D:\\ws\\x${i}`, { model: "x" })
    // 对照：整份快照要列目录。探针数得到它，下面的 0 才有意义
    expect(countRootListings(() => { readOverridesSnapshot() })).toBeGreaterThan(0)
    let rec: ReturnType<typeof getSessionRecord>
    const listings = countRootListings(() => { rec = getSessionRecord(KEY) })
    expect(rec!.model).toBe("m1")
    expect(listings).toBe(0)
  })

  it("读不到的键返回 undefined，也不扫目录（非 Windows）", () => {
    patchSessionRecord(KEY, { model: "m1" })
    let rec: ReturnType<typeof getSessionRecord> = { model: "sentinel" }
    const listings = countRootListings(() => { rec = getSessionRecord("ch_a|oc_9::D:\\ws\\nope") })
    expect(rec).toBeUndefined()
    // Windows 上路径大小写不敏感，找不到时会按大小写无关再找一遍，那里才允许扫
    if (process.platform !== "win32") expect(listings).toBe(0)
  })

  it("deleteSessionRecord 删掉的就是这一条，其余不动", () => {
    patchSessionRecord(KEY, { model: "m1" })
    patchSessionRecord("ch_a|oc_2::D:\\ws\\b", { model: "m2" })
    deleteSessionRecord(KEY)
    expect(getSessionRecord(KEY)).toBeUndefined()
    expect(getSessionRecord("ch_a|oc_2::D:\\ws\\b")?.model).toBe("m2")
  })

  it("与整份快照一致：快照里有的键，直读都读得到同样的记录", () => {
    patchSessionRecord(KEY, { model: "m1", agentId: "a1" })
    patchSessionRecord("ch_b|oc_3::D:\\ws\\c", { model: "m3" })
    const snap = readOverridesSnapshot()
    for (const [k, rec] of Object.entries(snap.sessions)) {
      expect(getSessionRecord(k)).toEqual(rec)
    }
  })

  it.runIf(process.platform === "win32")("Windows：路径大小写不同的键也能读到、删到同一条记录", () => {
    patchSessionRecord(KEY, { model: "m1" })
    const variant = KEY.toLowerCase()
    expect(variant).not.toBe(KEY)
    expect(getSessionRecord(variant)?.model).toBe("m1")
    deleteSessionRecord(variant)
    expect(getSessionRecord(KEY)).toBeUndefined()
    expect(fs.existsSync(sessionStatePath(root, KEY))).toBe(false)
  })
})

describe("readRoutingFileView", () => {
  const file = () => globalRoutingPath(root)
  const write = (obj: unknown, ageMs = 0) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), typeof obj === "string" ? obj : JSON.stringify(obj))
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs)
      fs.utimesSync(file(), t, t)
    }
  }

  it("文件不存在 / 内容坏 / 不是对象：都是 undefined", () => {
    expect(readRoutingFileView(root)).toBeUndefined()
    write("{ not json")
    expect(readRoutingFileView(root)).toBeUndefined()
    write("null")
    expect(readRoutingFileView(root)).toBeUndefined()
    write("[1,2]")
    expect(readRoutingFileView(root)).toBeUndefined()
  })

  it("只暴露 sessionToChat 与 chatType，不带 messageSession 这类大表", () => {
    write({ sessionToChat: { a: "c1" }, chatType: { c1: "p2p" }, messageSession: { m: "a" } })
    const v = readRoutingFileView(root)!
    expect(v).toEqual({ sessionToChat: { a: "c1" }, chatType: { c1: "p2p" } })
    expect("messageSession" in v).toBe(false)
  })

  it("文件有一阵没动：复用上次解析结果（同一个对象）", () => {
    write({ sessionToChat: { a: "c1" } }, 10_000)
    const first = readRoutingFileView(root)
    expect(readRoutingFileView(root)).toBe(first)
  })

  it("文件被改（大小变了）：重新读到新内容", () => {
    write({ sessionToChat: { a: "c1" } }, 10_000)
    expect(readRoutingFileView(root)?.sessionToChat).toEqual({ a: "c1" })
    write({ sessionToChat: { a: "c1", b: "c2" } }, 10_000)
    expect(readRoutingFileView(root)?.sessionToChat).toEqual({ a: "c1", b: "c2" })
  })

  it("文件刚改过不缓存：同样大小的连续改写也读得到最新内容（mtime 粒度粗时不会读到旧的）", () => {
    write({ sessionToChat: { a: "c1" } })
    expect(readRoutingFileView(root)?.sessionToChat).toEqual({ a: "c1" })
    write({ sessionToChat: { a: "c2" } }) // 同样大小
    expect(readRoutingFileView(root)?.sessionToChat).toEqual({ a: "c2" })
  })

  it("文件被删后不再返回旧缓存", () => {
    write({ sessionToChat: { a: "c1" } }, 10_000)
    expect(readRoutingFileView(root)).toBeDefined()
    fs.rmSync(file())
    expect(readRoutingFileView(root)).toBeUndefined()
  })
})
