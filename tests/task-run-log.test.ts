import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  appendRun,
  describeLastRun,
  describeRun,
  formatRunTime,
  MAX_RUNS_PER_TASK,
  parseTaskRunLog,
  runKindLabel,
  runTone,
  settleRun,
  type TaskRunRecord,
} from "../src/shared/task-run-log-rules.js"
import {
  readAliveAt,
  readTaskRuns,
  recordTaskRun,
  settleTaskRun,
  taskRunLogFile,
  touchAlive,
} from "../src/shared/task-run-log.js"

const at = (h: number, m = 0, day = 20): number => new Date(2026, 10, day, h, m).getTime()
const NOW = at(16, 30)

describe("task-run-log-rules：记录增减", () => {
  it("新记录放在最前面", () => {
    const list = appendRun([{ at: 1, kind: "reported" }], { at: 2, kind: "quiet" })
    expect(list.map((r) => r.at)).toEqual([2, 1])
  })

  it("超过条数上限，最旧的被挤掉", () => {
    let list: TaskRunRecord[] = []
    for (let i = 1; i <= MAX_RUNS_PER_TASK + 5; i++) list = appendRun(list, { at: i, kind: "triggered" })
    expect(list).toHaveLength(MAX_RUNS_PER_TASK)
    expect(list[0].at).toBe(MAX_RUNS_PER_TASK + 5)
    expect(list.at(-1)?.at).toBe(6)
  })

  it("原因太长会被截短，空白原因不存", () => {
    const long = appendRun([], { at: 1, kind: "undelivered", detail: "x".repeat(200) })[0].detail ?? ""
    expect(long.length).toBeLessThan(100)
    expect(long.endsWith("…")).toBe(true)
    expect("detail" in appendRun([], { at: 1, kind: "undelivered", detail: "   " })[0]).toBe(false)
  })

  it("settleRun：按触发点改结果，手动标记保留", () => {
    const before: TaskRunRecord[] = [{ at: 5, kind: "triggered", manual: true }, { at: 3, kind: "triggered" }]
    const after = settleRun(before, 5, { kind: "reported", detail: "IM" })
    expect(after).toEqual([{ at: 5, kind: "reported", detail: "IM", manual: true }, { at: 3, kind: "triggered" }])
    expect(before[0].kind).toBe("triggered")
  })

  it("settleRun：from 对不上就不改（后到的「没提交结果」不能盖掉「没送出去」）", () => {
    const before: TaskRunRecord[] = [{ at: 5, kind: "undelivered", detail: "通道不存在" }]
    expect(settleRun(before, 5, { kind: "no-result" }, "triggered")).toBe(before)
  })

  it("settleRun：找不到触发点原样返回同一个数组", () => {
    const before: TaskRunRecord[] = [{ at: 5, kind: "triggered" }]
    expect(settleRun(before, 99, { kind: "reported" })).toBe(before)
  })

  it("settleRun：没给原因时旧原因不保留", () => {
    const after = settleRun([{ at: 5, kind: "undelivered", detail: "通道不存在" }], 5, { kind: "reported" })
    expect(after[0]).toEqual({ at: 5, kind: "reported" })
  })
})

describe("task-run-log-rules：读入的内容不可信", () => {
  it("不合法的条目丢掉，合法的保留，没有合法条目的任务不留", () => {
    const parsed = parseTaskRunLog({
      a: [{ at: 1, kind: "reported", detail: "IM" }, { at: "x", kind: "reported" }, { at: 2, kind: "bogus" }, null, 7],
      b: [{ at: Number.NaN, kind: "quiet" }],
      c: "not-a-list",
    })
    expect(parsed).toEqual({ a: [{ at: 1, kind: "reported", detail: "IM" }] })
  })

  it("整体不是对象 → 空", () => {
    expect(parseTaskRunLog(null)).toEqual({})
    expect(parseTaskRunLog([1, 2])).toEqual({})
    expect(parseTaskRunLog("x")).toEqual({})
  })

  it("count 只在大于 1 时保留，小数取整；超出条数上限的被截断", () => {
    const many = Array.from({ length: MAX_RUNS_PER_TASK + 3 }, (_, i) => ({ at: i, kind: "missed", count: i === 0 ? 3.9 : 1 }))
    const parsed = parseTaskRunLog({ a: many }).a
    expect(parsed).toHaveLength(MAX_RUNS_PER_TASK)
    expect(parsed[0]).toEqual({ at: 0, kind: "missed", count: 3 })
    expect("count" in parsed[1]).toBe(false)
  })
})

describe("task-run-log-rules：文案", () => {
  it("今天 / 昨天 / 更早", () => {
    expect(formatRunTime(at(9), NOW)).toBe("今天 09:00")
    expect(formatRunTime(at(23, 5, 19), NOW)).toBe("昨天 23:05")
    expect(formatRunTime(at(9, 0, 17), NOW)).toBe("11/17 09:00")
  })

  it("一行说明：时间 + 结果 + 原因；手动触发有标记", () => {
    expect(describeRun({ at: at(9), kind: "reported", detail: "IM" }, NOW)).toBe("今天 09:00 已汇报 · IM")
    expect(describeRun({ at: at(9), kind: "triggered", manual: true }, NOW)).toBe("今天 09:00（手动） 已触发")
  })

  it("错过一次只写「错过」，多次写次数", () => {
    expect(runKindLabel({ kind: "missed" })).toBe("错过")
    expect(runKindLabel({ kind: "missed", count: 1 })).toBe("错过")
    expect(runKindLabel({ kind: "missed", count: 3 })).toBe("错过 3 次")
    expect(runKindLabel({ kind: "reported", count: 3 })).toBe("已汇报")
  })

  it("列表里的「上次」取最新一条；没有记录是空串", () => {
    expect(describeLastRun([{ at: at(9), kind: "quiet" }, { at: at(8), kind: "reported" }], NOW)).toBe("上次：今天 09:00 无需汇报")
    expect(describeLastRun([], NOW)).toBe("")
    expect(describeLastRun(undefined, NOW)).toBe("")
  })

  it("失败和错过用醒目的颜色，正常的不抢眼", () => {
    expect(runTone("undelivered")).toBe("bad")
    expect(runTone("missed")).toBe("bad")
    expect(runTone("skipped")).toBe("warn")
    expect(runTone("no-result")).toBe("warn")
    expect(runTone("reported")).toBe("ok")
    expect(runTone("quiet")).toBe("muted")
    expect(runTone("triggered")).toBe("muted")
  })
})

describe("task-run-log：文件读写", () => {
  let root = ""
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-run-log-")) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it("文件放在 config/ 下，不和任务文件同名（调度器只监听 scheduled-tasks.json）", () => {
    const f = taskRunLogFile(root)
    expect(path.basename(path.dirname(f))).toBe("config")
    expect(path.basename(f)).not.toBe("scheduled-tasks.json")
  })

  it("没有文件 → 没有记录，也没有存活时间", () => {
    const f = taskRunLogFile(root)
    expect(readTaskRuns(f)).toEqual({})
    expect(readAliveAt(f)).toBeUndefined()
  })

  it("记录后读回；不同任务互不影响；目录不存在会自动创建", () => {
    const f = taskRunLogFile(root)
    recordTaskRun(f, "a", { at: 1, kind: "triggered" })
    recordTaskRun(f, "a", { at: 2, kind: "skipped", detail: "上一次还没结束" })
    recordTaskRun(f, "b", { at: 3, kind: "undelivered", detail: "通道不存在" })
    expect(readTaskRuns(f)).toEqual({
      a: [{ at: 2, kind: "skipped", detail: "上一次还没结束" }, { at: 1, kind: "triggered" }],
      b: [{ at: 3, kind: "undelivered", detail: "通道不存在" }],
    })
  })

  it("settleTaskRun：改成最终结果；找不到时不动文件", () => {
    const f = taskRunLogFile(root)
    recordTaskRun(f, "a", { at: 1, kind: "triggered" })
    settleTaskRun(f, "a", 1, { kind: "reported", detail: "IM" })
    expect(readTaskRuns(f).a).toEqual([{ at: 1, kind: "reported", detail: "IM" }])
    const mtime = fs.statSync(f).mtimeMs
    settleTaskRun(f, "a", 99, { kind: "quiet" })
    settleTaskRun(f, "nope", 1, { kind: "quiet" })
    expect(fs.statSync(f).mtimeMs).toBe(mtime)
  })

  it("touchAlive：记时间，并清掉已不存在任务的记录", () => {
    const f = taskRunLogFile(root)
    recordTaskRun(f, "keep", { at: 1, kind: "reported" })
    recordTaskRun(f, "gone", { at: 1, kind: "reported" })
    touchAlive(f, 1234, new Set(["keep"]))
    expect(readAliveAt(f)).toBe(1234)
    expect(Object.keys(readTaskRuns(f))).toEqual(["keep"])
  })

  it("touchAlive 没给任务清单（任务文件读不出来）：只记时间，不清记录", () => {
    const f = taskRunLogFile(root)
    recordTaskRun(f, "a", { at: 1, kind: "reported" })
    touchAlive(f, 99)
    expect(readAliveAt(f)).toBe(99)
    expect(Object.keys(readTaskRuns(f))).toEqual(["a"])
  })

  it("记录和存活时间互不覆盖", () => {
    const f = taskRunLogFile(root)
    touchAlive(f, 500)
    recordTaskRun(f, "a", { at: 1, kind: "reported" })
    expect(readAliveAt(f)).toBe(500)
  })

  it("损坏的文件 → 当作没有记录，不抛错，也不留备份文件；下一次写入照常", () => {
    const f = taskRunLogFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "{not json", "utf-8")
    expect(readTaskRuns(f)).toEqual({})
    expect(readAliveAt(f)).toBeUndefined()
    expect(fs.readdirSync(path.dirname(f))).toEqual([path.basename(f)])
    recordTaskRun(f, "a", { at: 1, kind: "reported" })
    expect(readTaskRuns(f).a).toHaveLength(1)
  })
})
