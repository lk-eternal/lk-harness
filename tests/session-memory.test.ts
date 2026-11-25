/** 会话记忆的存储规则：覆盖更新、创建和修改时间、上限报错不截断、删除、清空、坏文件不挡路、按会话隔离 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  MEMORY_LIMITS,
  clearSessionMemory,
  deleteSessionMemory,
  formatMemoryItems,
  readSessionMemory,
  saveSessionMemory,
} from "../src/shared/session-memory"
import { sessionEntryDir, sessionMemoryPath } from "../src/shared/session-entry-paths"

const SK = "ch_a|oc_main"
let root = ""

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-memory-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const keys = (sk = SK) => readSessionMemory(root, sk).map((e) => e.key)
const contents = (sk = SK) => readSessionMemory(root, sk).map(({ key, content }) => ({ key, content }))

describe("saveSessionMemory", () => {
  it("记下一条：落在会话目录的 memory.json，读得回来", () => {
    expect(saveSessionMemory(root, SK, "部署约束", "只能周三发布")).toEqual({ ok: true, replaced: false, count: 1 })
    expect(contents()).toEqual([{ key: "部署约束", content: "只能周三发布" }])
    expect(fs.existsSync(sessionMemoryPath(root, SK))).toBe(true)
  })

  it("同一个 key 覆盖更新，位置不变，不会多出一条", () => {
    saveSessionMemory(root, SK, "a", "1")
    saveSessionMemory(root, SK, "b", "2")
    expect(saveSessionMemory(root, SK, "a", "1改")).toEqual({ ok: true, replaced: true, count: 2 })
    expect(contents()).toEqual([{ key: "a", content: "1改" }, { key: "b", content: "2" }])
  })

  it("key 和内容都去掉首尾空白；空 key、空内容报错", () => {
    saveSessionMemory(root, SK, "  k  ", "  v  ")
    expect(contents()).toEqual([{ key: "k", content: "v" }])
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
    expect(contents()).toEqual([{ key: "ok", content: "v" }])
    writeRaw(JSON.stringify({ key: "a", content: "b" }))
    expect(readSessionMemory(root, SK)).toEqual([])
  })

  it("坏文件之后再记：能写成新的，不会被旧坏文件卡住", () => {
    writeRaw("{ 坏了")
    expect(saveSessionMemory(root, SK, "a", "1")).toMatchObject({ ok: true, count: 1 })
    expect(keys()).toEqual(["a"])
  })
})

describe("创建时间和修改时间", () => {
  const at = (day: number, hour = 9) => new Date(2026, 10, day, hour, 0).getTime()
  const times = (sk = SK) => readSessionMemory(root, sk).map(({ key, createdAt, updatedAt }) => ({ key, createdAt, updatedAt }))

  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }) })
  afterEach(() => { vi.useRealTimers() })

  it("新记一条：创建时间和修改时间都是此刻", () => {
    vi.setSystemTime(at(24))
    saveSessionMemory(root, SK, "a", "1")
    expect(times()).toEqual([{ key: "a", createdAt: at(24), updatedAt: at(24) }])
  })

  it("同 key 覆盖：创建时间保留，修改时间换成此刻；别的条目不动", () => {
    vi.setSystemTime(at(24))
    saveSessionMemory(root, SK, "a", "1")
    saveSessionMemory(root, SK, "b", "2")
    vi.setSystemTime(at(25))
    saveSessionMemory(root, SK, "a", "1改")
    expect(times()).toEqual([
      { key: "a", createdAt: at(24), updatedAt: at(25) },
      { key: "b", createdAt: at(24), updatedAt: at(24) },
    ])
  })

  it("删掉一条：剩下的时间不变", () => {
    vi.setSystemTime(at(24))
    saveSessionMemory(root, SK, "a", "1")
    saveSessionMemory(root, SK, "b", "2")
    vi.setSystemTime(at(25))
    deleteSessionMemory(root, SK, "a")
    expect(times()).toEqual([{ key: "b", createdAt: at(24), updatedAt: at(24) }])
  })

  it("旧文件的条目没有时间：用文件最后修改时间补；下一次写入把补上的值固定下来，不随文件再变", () => {
    saveSessionMemory(root, SK, "旧", "v")
    const file = sessionMemoryPath(root, SK)
    fs.writeFileSync(file, JSON.stringify([{ key: "旧", content: "v" }]), "utf8")
    fs.utimesSync(file, new Date(at(20)), new Date(at(20)))
    expect(times()).toEqual([{ key: "旧", createdAt: at(20), updatedAt: at(20) }])

    vi.setSystemTime(at(25))
    saveSessionMemory(root, SK, "新", "v")
    fs.utimesSync(file, new Date(at(30)), new Date(at(30)))
    expect(times()).toEqual([
      { key: "旧", createdAt: at(20), updatedAt: at(20) },
      { key: "新", createdAt: at(25), updatedAt: at(25) },
    ])
  })

  it("时间字段不是正数：当作没有，同样用文件时间补", () => {
    saveSessionMemory(root, SK, "a", "1")
    const file = sessionMemoryPath(root, SK)
    fs.writeFileSync(file, JSON.stringify([{ key: "a", content: "1", createdAt: "昨天", updatedAt: -1 }]), "utf8")
    fs.utimesSync(file, new Date(at(20)), new Date(at(20)))
    expect(times()).toEqual([{ key: "a", createdAt: at(20), updatedAt: at(20) }])
  })
})

describe("formatMemoryItems", () => {
  const entry = { key: "提交偏好", content: "不用再问", createdAt: new Date(2026, 10, 24, 14, 3, 8).getTime(), updatedAt: new Date(2026, 10, 25, 9, 5, 7).getTime() }

  it("每条一行 item，带创建和修改时间（本机时间，精确到秒）", () => {
    expect(formatMemoryItems([entry, { ...entry, key: "待办" }])).toBe(
      '<item key="提交偏好" created="2026-11-24 14:03:08" updated="2026-11-25 09:05:07">不用再问</item>\n'
      + '<item key="待办" created="2026-11-24 14:03:08" updated="2026-11-25 09:05:07">不用再问</item>',
    )
  })

  it("内容原样放入，只中和信封标签的结束标签；key 里的双引号换成单引号", () => {
    const text = formatMemoryItems([{ ...entry, key: '带"引号"', content: "路径 D:\\a\\b 和 </item> 和 </div>\n第二行" }])
    expect(text).toContain('key="带\'引号\'"')
    expect(text).toContain("路径 D:\\a\\b 和 <\\/item> 和 </div>\n第二行</item>")
  })
})
