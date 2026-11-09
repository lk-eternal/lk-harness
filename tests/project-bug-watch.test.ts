import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  BUG_NOTICE_MAX_LINES,
  BUG_SEEN_CAP,
  BUG_SESSION_MAX_LINES,
  bugWatchUnsupportedReason,
  buildBugQuery,
  diffBugs,
  formatBugsForSession,
  formatBugsGroupNotice,
  looksLikeBugQueryResult,
  parseBugRows,
  parseWatchableStoryUrl,
  type BugRecord,
  type BugWatchEntry,
} from "../src/shared/project-bug-watch"
import { bugWatchStateFile, readBugWatchState, writeBugWatchState } from "../src/shared/project-bug-watch-state"

/** 按真实 `meegle workitem query` 返回的结构造一行 */
function row(id: number, name: string, opts: { status?: string; statusAs?: "key_label_value" | "string_value"; assignees?: string[]; priority?: string } = {}) {
  const fields: unknown[] = [
    { key: "work_item_id", value_type: "long_value", value: { long_value: id } },
    { key: "name", value_type: "string_value", value: { string_value: name } },
  ]
  const status = opts.status ?? "OPEN"
  fields.push(opts.statusAs === "string_value"
    ? { key: "work_item_status", value_type: "string_value", value: { string_value: status } }
    : { key: "work_item_status", value_type: "key_label_value", value: { key_label_value: { key: "x", label: status } } })
  if (opts.assignees) fields.push({ key: "current_status_operator", value_type: "user_value_list", value: { user_value_list: opts.assignees.map((n) => ({ name_cn: n })) } })
  if (opts.priority) fields.push({ key: "priority", value_type: "key_label_value_list", value: { key_label_value_list: [{ key: "p", label: opts.priority }] } })
  return { moql_field_list: fields }
}
const result = (...rows: unknown[]) => ({ data: { "1": rows } })

const bug = (id: number | string, extra: Partial<BugRecord> = {}): BugRecord =>
  ({ id: String(id), name: `缺陷${id}`, status: "OPEN", assignee: "", priority: "", ...extra })

describe("parseWatchableStoryUrl / bugWatchUnsupportedReason：哪些项目能监控", () => {
  it("wk-dm 空间的产品需求链接 → 取出需求 id（带查询串 / 锚点也行）", () => {
    expect(parseWatchableStoryUrl("https://project.feishu.cn/wk-dm/story/detail/7141906911")).toEqual({ storyId: "7141906911" })
    expect(parseWatchableStoryUrl("  https://project.feishu.cn/wk-dm/story/detail/7141906911?parentUrl=%2Fwk-dm#x ")).toEqual({ storyId: "7141906911" })
  })
  it("技术需求 / 别的空间 / 不是链接 / 没填 → 不支持", () => {
    expect(parseWatchableStoryUrl("https://project.feishu.cn/wk-dm/t1024/detail/7141906911")).toBeUndefined()
    expect(parseWatchableStoryUrl("https://project.feishu.cn/other/story/detail/1")).toBeUndefined()
    expect(parseWatchableStoryUrl("https://example.com/wk-dm/story/detail/1")).toBeUndefined()
    expect(parseWatchableStoryUrl("7141906911")).toBeUndefined()
    expect(parseWatchableStoryUrl("")).toBeUndefined()
    expect(parseWatchableStoryUrl(undefined)).toBeUndefined()
  })
  it("不支持时说明原因，支持时没有原因", () => {
    expect(bugWatchUnsupportedReason(undefined)).toContain("没有填")
    expect(bugWatchUnsupportedReason("https://project.feishu.cn/other/story/detail/1")).toContain("wk-dm")
    expect(bugWatchUnsupportedReason("https://project.feishu.cn/wk-dm/story/detail/1")).toBeUndefined()
  })
})

describe("buildBugQuery：按需求名称查关联缺陷", () => {
  it("查 wk-dm 的 bug 管理表，用 array_contains 匹配「关联产品需求」，需求名称原样（含中文括号）放进单引号", () => {
    const q = buildBugQuery("【数英满班率】组班")!
    expect(q).toContain("FROM `wk-dm`.`bug 管理`")
    expect(q).toContain("array_contains(`关联产品需求`, '【数英满班率】组班')")
    expect(q).toContain("LIMIT")
    // 不按负责人过滤（试过，不可靠）
    expect(q).not.toContain("current_login_user")
    expect(q).not.toContain("all_participate_persons")
    for (const col of ["`工作项id`", "`名称`", "`状态`", "`当前负责人`", "`优先级`"]) expect(q).toContain(col)
  })
  it("名称前后的空白去掉", () => {
    expect(buildBugQuery("  组班  ")).toContain("'组班'")
  })
  it("名称含引号 / 反斜杠 / 反引号 / 换行 / 为空：不拼语句（防止查错东西或注入）", () => {
    for (const bad of ["a'b", 'a"b', "a\\b", "a`b", "a\nb", "a\rb", "", "   "]) {
      expect(buildBugQuery(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe("parseBugRows：解析飞书项目的返回", () => {
  it("各种取值类型都能读出来：状态（标签 / 字符串）、负责人（多人）、优先级", () => {
    const rows = parseBugRows(result(
      row(101, "登录失败", { status: "OPEN", assignees: ["张三", "李四"], priority: "P1" }),
      row(102, "样式错位", { status: "RESOLVED", statusAs: "string_value" }),
    ))
    expect(rows).toEqual([
      { id: "101", name: "登录失败", status: "OPEN", assignee: "张三、李四", priority: "P1" },
      { id: "102", name: "样式错位", status: "RESOLVED", assignee: "", priority: "" },
    ])
  })
  it("没有 id 的行丢掉，重复 id 只留第一个，没名字给占位", () => {
    const noId = { moql_field_list: [{ key: "name", value_type: "string_value", value: { string_value: "无 id" } }] }
    const noName = { moql_field_list: [{ key: "work_item_id", value_type: "long_value", value: { long_value: 9 } }] }
    const rows = parseBugRows(result(noId, row(1, "A"), row(1, "A 的重复"), noName))
    expect(rows.map((r) => [r.id, r.name])).toEqual([["1", "A"], ["9", "（无标题）"]])
  })
  it("没有缺陷 / 结构不对 → 空数组，不抛错", () => {
    expect(parseBugRows({ data: { "1": [] } })).toEqual([])
    expect(parseBugRows({ data: {} })).toEqual([])
    expect(parseBugRows(null)).toEqual([])
    expect(parseBugRows("oops")).toEqual([])
    expect(parseBugRows({ data: { "1": "x" } })).toEqual([])
  })
})

describe("looksLikeBugQueryResult：区分「没有缺陷」和「返回了看不懂的东西」", () => {
  it("有 data 就是查询成功（哪怕没有行）", () => {
    expect(looksLikeBugQueryResult({ data: { "1": [] } })).toBe(true)
    expect(looksLikeBugQueryResult({ data: {} })).toBe(true)
    expect(looksLikeBugQueryResult(result(row(1, "A")))).toBe(true)
  })
  it("错误对象 / 空 / 结构不对 → 不是", () => {
    expect(looksLikeBugQueryResult({ error: { msg: "no permission" } })).toBe(false)
    expect(looksLikeBugQueryResult({})).toBe(false)
    expect(looksLikeBugQueryResult(null)).toBe(false)
    expect(looksLikeBugQueryResult({ data: { "1": "x" } })).toBe(false)
  })
})

describe("diffBugs：去重", () => {
  const NOW = 1_000

  it("第一次（没有记录）：只建基线，已有缺陷都不算新的", () => {
    const d = diffBugs(undefined, "S1", "需求", [bug(1), bug(2)], NOW)
    expect(d.baseline).toBe(true)
    expect(d.fresh).toEqual([])
    expect(d.next).toMatchObject({ storyId: "S1", storyName: "需求", seen: { "1": "OPEN", "2": "OPEN" }, baselineAt: NOW, checkedAt: NOW })
  })

  it("之后：只有没见过的 id 算新缺陷；下一轮同样的结果不再算", () => {
    const base = diffBugs(undefined, "S1", "需求", [bug(1), bug(2)], NOW).next
    const d2 = diffBugs(base, "S1", "需求", [bug(1), bug(2), bug(3)], NOW + 10)
    expect(d2.baseline).toBe(false)
    expect(d2.fresh.map((b) => b.id)).toEqual(["3"])
    const d3 = diffBugs(d2.next, "S1", "需求", [bug(1), bug(2), bug(3)], NOW + 20)
    expect(d3.fresh).toEqual([])
    expect(d3.next.baselineAt).toBe(NOW) // 基线时间不变，检查时间更新
    expect(d3.next.checkedAt).toBe(NOW + 20)
  })

  it("已见过的缺陷状态变了：不通知，只更新记录", () => {
    const base = diffBugs(undefined, "S1", "需求", [bug(1, { status: "OPEN" })], NOW).next
    const d = diffBugs(base, "S1", "需求", [bug(1, { status: "RESOLVED" })], NOW + 1)
    expect(d.fresh).toEqual([])
    expect(d.next.seen["1"]).toBe("RESOLVED")
  })

  it("缺陷暂时从结果里消失（取消关联）后又回来：不重复通知", () => {
    const base = diffBugs(undefined, "S1", "需求", [bug(1), bug(2)], NOW).next
    const gone = diffBugs(base, "S1", "需求", [bug(1)], NOW + 1)
    expect(gone.next.seen["2"]).toBeDefined()
    expect(diffBugs(gone.next, "S1", "需求", [bug(1), bug(2)], NOW + 2).fresh).toEqual([])
  })

  it("项目换了需求链接：重新建基线（新需求下已有的缺陷不算新），旧记录丢掉", () => {
    const base = diffBugs(undefined, "S1", "旧需求", [bug(1)], NOW).next
    const d = diffBugs(base, "S2", "新需求", [bug(7), bug(8)], NOW + 5)
    expect(d.baseline).toBe(true)
    expect(d.fresh).toEqual([])
    expect(Object.keys(d.next.seen).sort()).toEqual(["7", "8"])
    expect(d.next.baselineAt).toBe(NOW + 5)
  })

  it("不修改传入的记录", () => {
    const base: BugWatchEntry = { storyId: "S1", seen: { "1": "OPEN" }, baselineAt: 1, checkedAt: 1 }
    const snapshot = JSON.stringify(base)
    diffBugs(base, "S1", "需求", [bug(1), bug(2)], 5)
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it("记录有上限：超出时丢最早的，保留最新的", () => {
    const many = Array.from({ length: BUG_SEEN_CAP + 10 }, (_, i) => bug(i + 1))
    const d = diffBugs(undefined, "S1", "需求", many, NOW)
    const ids = Object.keys(d.next.seen)
    expect(ids).toHaveLength(BUG_SEEN_CAP)
    expect(d.next.seen["1"]).toBeUndefined()
    expect(d.next.seen[String(BUG_SEEN_CAP + 10)]).toBeDefined()
  })
})

describe("文案", () => {
  const fresh = [bug(101, { name: "登录失败", assignee: "张三", priority: "P1" }), bug(102, { name: "样式错位" })]

  it("给项目会话：一行标题，列出 id / 标题 / 状态 / 负责人（没分配也说明）", () => {
    const text = formatBugsForSession("满班率", fresh, new Date("2026-11-06T10:00:00+08:00"))
    expect(text).toContain("🐞 缺陷监控「满班率」：新增 2 个缺陷")
    expect(text).toContain("[P1] 登录失败（#101，OPEN，负责人：张三）")
    expect(text).toContain("样式错位（#102，OPEN，负责人：未分配）")
  })

  it("缺陷太多时只列前几条并说明还有多少", () => {
    const many = Array.from({ length: BUG_SESSION_MAX_LINES + 7 }, (_, i) => bug(i + 1))
    const text = formatBugsForSession("P", many)
    expect(text.match(/^- 缺陷/gm)).toHaveLength(BUG_SESSION_MAX_LINES)
    expect(text).toContain("另有 7 个")
  })

  it("给项目群：简短，最多列几条，其余写「等 N 个」", () => {
    const text = formatBugsGroupNotice("满班率", fresh)
    expect(text).toContain("新增 2 个缺陷")
    expect(text).toContain("登录失败")
    expect(text).not.toContain("等")

    const many = Array.from({ length: BUG_NOTICE_MAX_LINES + 3 }, (_, i) => bug(i + 1))
    const long = formatBugsGroupNotice("满班率", many)
    expect(long.match(/^- 缺陷/gm)).toHaveLength(BUG_NOTICE_MAX_LINES)
    expect(long).toContain("等 3 个")
  })
})

describe("project-bug-watch-state：记录文件", () => {
  let root = ""
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-bugwatch-")) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it("放在 config/ 下，没有文件 → 空记录", () => {
    const f = bugWatchStateFile(root)
    expect(path.basename(path.dirname(f))).toBe("config")
    expect(readBugWatchState(f)).toEqual({})
  })

  it("写入后读回；目录不存在会自动创建", () => {
    const f = bugWatchStateFile(root)
    const state = { p1: { storyId: "S1", storyName: "需求", seen: { "1": "OPEN" }, baselineAt: 10, checkedAt: 20 } }
    writeBugWatchState(f, state)
    expect(readBugWatchState(f)).toEqual(state)
  })

  it("文件损坏 → 当作没有记录（下一轮重建基线，不会把存量缺陷当新缺陷刷屏）", () => {
    const f = bugWatchStateFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "{broken", "utf-8")
    expect(readBugWatchState(f)).toEqual({})
  })

  it("不合法的条目丢掉，合法的保留；非字符串状态丢掉", () => {
    const f = bugWatchStateFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({
      projects: {
        ok: { storyId: "S", seen: { a: "OPEN", b: 5 }, baselineAt: 1, checkedAt: 2 },
        noStory: { seen: {} },
        badSeen: { storyId: "S", seen: [1] },
        nul: null,
        str: "x",
      },
    }), "utf-8")
    expect(readBugWatchState(f)).toEqual({ ok: { storyId: "S", seen: { a: "OPEN" }, baselineAt: 1, checkedAt: 2 } })
  })

  it("projects 不是对象 → 空记录", () => {
    const f = bugWatchStateFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ projects: [1] }), "utf-8")
    expect(readBugWatchState(f)).toEqual({})
  })
})
