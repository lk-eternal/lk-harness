/** 会话记忆的存储规则：覆盖更新、上限报错不截断、删除、清空、坏文件不挡路、按会话隔离 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  MEMORY_LIMITS,
  clearSessionMemory,
  deleteSessionMemory,
  memoryForPrompt,
  readSessionMemory,
  saveSessionMemory,
} from "../src/shared/session-memory"
import { sessionEntryDir, sessionMemoryPath } from "../src/shared/session-entry-paths"

const SK = "ch_a|oc_main"
let root = ""

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-memory-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const keys = (sk = SK) => readSessionMemory(root, sk).map((e) => e.key)

describe("saveSessionMemory", () => {
  it("记下一条：落在会话目录的 memory.json，读得回来", () => {
    expect(saveSessionMemory(root, SK, "部署约束", "只能周三发布")).toEqual({ ok: true, replaced: false, count: 1 })
    expect(readSessionMemory(root, SK)).toEqual([{ key: "部署约束", content: "只能周三发布" }])
    expect(fs.existsSync(sessionMemoryPath(root, SK))).toBe(true)
  })

  it("同一个 key 覆盖更新，位置不变，不会多出一条", () => {
    saveSessionMemory(root, SK, "a", "1")
    saveSessionMemory(root, SK, "b", "2")
    expect(saveSessionMemory(root, SK, "a", "1改")).toEqual({ ok: true, replaced: true, count: 2 })
    expect(readSessionMemory(root, SK)).toEqual([{ key: "a", content: "1改" }, { key: "b", content: "2" }])
  })

  it("key 和内容都去掉首尾空白；空 key、空内容报错", () => {
    saveSessionMemory(root, SK, "  k  ", "  v  ")
    expect(readSessionMemory(root, SK)).toEqual([{ key: "k", content: "v" }])
    expect(saveSessionMemory(root, SK, "  ", "v")).toMatchObject({ ok: false, error: expect.stringContaining("key") })
    expect(saveSessionMemory(root, SK, "k2", "   ")).toMatchObject({ ok: false, error: expect.stringContaining("memory_delete") })
    expect(keys()).toEqual(["k"])
  })

  it("超长报错且不写入，不静默截断", () => {
    const longContent = "字".repeat(MEMORY_LIMITS.maxContentChars + 1)
    expect(saveSessionMemory(root, SK, "k", longContent)).toMatchObject({ ok: false, error: expect.stringContaining(`${MEMORY_LIMITS.maxContentChars}`) })
    expect(saveSessionMemory(root, SK, "k".repeat(MEMORY_LIMITS.maxKeyChars + 1), "v")).toMatchObject({ ok: false })
    expect(readSessionMemory(root, SK)).toEqual([])
    expect(saveSessionMemory(root, SK, "k", "字".repeat(MEMORY_LIMITS.maxContentChars))).toMatchObject({ ok: true })
  })

  it("满了：新 key 报错并列出现有 key；已有的 key 仍可覆盖更新", () => {
    for (let i = 0; i < MEMORY_LIMITS.maxEntries; i++) saveSessionMemory(root, SK, `k${i}`, "v")
    const r = saveSessionMemory(root, SK, "新的", "v")
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("memory_delete") })
    expect((r as { error: string }).error).toContain("k0")
    expect(keys()).toHaveLength(MEMORY_LIMITS.maxEntries)
    expect(saveSessionMemory(root, SK, "k0", "改")).toMatchObject({ ok: true, replaced: true })
  })

  it("按会话隔离：别的会话看不到", () => {
    saveSessionMemory(root, SK, "a", "1")
    expect(keys("ch_a|oc_other")).toEqual([])
  })

  it("工作目录路径里反斜杠写成一个或两个，指向同一个会话：daemon 的请求头和 Electron 的会话键写法可能不同", () => {
    saveSessionMemory(root, "ch_a|oc_main::D:\\\\ws\\\\a", "a", "1")
    expect(keys("ch_a|oc_main::D:\\ws\\a")).toEqual(["a"])
  })
})

describe("deleteSessionMemory", () => {
  it("删掉一条；删光后文件也没了", () => {
    saveSessionMemory(root, SK, "a", "1")
    saveSessionMemory(root, SK, "b", "2")
    expect(deleteSessionMemory(root, SK, "a")).toEqual({ ok: true, count: 1 })
    expect(keys()).toEqual(["b"])
    expect(deleteSessionMemory(root, SK, "b")).toEqual({ ok: true, count: 0 })
    expect(fs.existsSync(sessionMemoryPath(root, SK))).toBe(false)
  })

  it("没有这个 key：报错并列出现有 key；一条记忆都没有时说清楚", () => {
    expect(deleteSessionMemory(root, SK, "x")).toMatchObject({ ok: false, error: expect.stringContaining("还没有记忆") })
    saveSessionMemory(root, SK, "a", "1")
    const r = deleteSessionMemory(root, SK, "x")
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("现有 key：a") })
    expect(keys()).toEqual(["a"])
  })
})

describe("clearSessionMemory", () => {
  it("清空只影响本会话", () => {
    saveSessionMemory(root, SK, "a", "1")
    saveSessionMemory(root, "ch_a|oc_other", "b", "2")
    clearSessionMemory(root, SK)
    expect(keys()).toEqual([])
    expect(keys("ch_a|oc_other")).toEqual(["b"])
  })

  it("会话目录不存在时：不会把目录建回来", () => {
    const gone = "ch_a|oc_gone"
    clearSessionMemory(root, gone)
    expect(fs.existsSync(sessionEntryDir(root, gone))).toBe(false)
  })
})

describe("readSessionMemory 对坏文件的态度", () => {
  const writeRaw = (raw: string) => {
    saveSessionMemory(root, SK, "seed", "v")
    fs.writeFileSync(sessionMemoryPath(root, SK), raw, "utf8")
  }

  it("JSON 损坏：读成空，并留下 .corrupt 备份，不抛错（不能因为它挡住一轮对话）", () => {
    writeRaw("{ 坏了")
    expect(readSessionMemory(root, SK)).toEqual([])
    const backups = fs.readdirSync(path.dirname(sessionMemoryPath(root, SK))).filter((n) => n.includes(".corrupt-"))
    expect(backups).toHaveLength(1)
  })

  it("形状不对的条目被丢掉，好的保留；整体不是数组读成空", () => {
    writeRaw(JSON.stringify([{ key: "ok", content: "v" }, { key: "", content: "x" }, { key: "no-content" }, 3, null]))
    expect(readSessionMemory(root, SK)).toEqual([{ key: "ok", content: "v" }])
    writeRaw(JSON.stringify({ key: "a", content: "b" }))
    expect(readSessionMemory(root, SK)).toEqual([])
  })

  it("坏文件之后再记：能写成新的，不会被旧坏文件卡住", () => {
    writeRaw("{ 坏了")
    expect(saveSessionMemory(root, SK, "a", "1")).toMatchObject({ ok: true, count: 1 })
    expect(keys()).toEqual(["a"])
  })
})

describe("memoryForPrompt", () => {
  it("没有记忆：返回 undefined（提示词里不出现 memory 字段）", () => {
    expect(memoryForPrompt([])).toBeUndefined()
  })

  it("key → 内容，按记下的顺序", () => {
    expect(JSON.stringify(memoryForPrompt([{ key: "b", content: "2" }, { key: "a", content: "1" }]))).toBe('{"b":"2","a":"1"}')
  })
})
