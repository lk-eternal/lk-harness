import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { aiScheduleStateFile, readAiScheduleRuns, writeAiScheduleRuns } from "../src/shared/ai-schedule-state.js"

let root = ""
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-ai-state-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe("ai-schedule-state", () => {
  it("文件放在 config/ 下，不和任务文件同名（调度器只监听 scheduled-tasks.json）", () => {
    const f = aiScheduleStateFile(root)
    expect(path.basename(path.dirname(f))).toBe("config")
    expect(path.basename(f)).not.toBe("scheduled-tasks.json")
  })

  it("没有文件 → 空记录", () => {
    expect(readAiScheduleRuns(aiScheduleStateFile(root))).toEqual({})
  })

  it("写入后读回；目录不存在会自动创建", () => {
    const f = aiScheduleStateFile(root)
    writeAiScheduleRuns(f, { a: 1, b: 7 })
    expect(readAiScheduleRuns(f)).toEqual({ a: 1, b: 7 })
  })

  it("损坏的文件 → 当作没有记录，不抛错", () => {
    const f = aiScheduleStateFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, "{not json", "utf-8")
    expect(readAiScheduleRuns(f)).toEqual({})
  })

  it("内容不合法的条目被丢掉，合法的保留，小数取整", () => {
    const f = aiScheduleStateFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ runs: { ok: 3, frac: 2.9, neg: -1, str: "5", nul: null } }), "utf-8")
    expect(readAiScheduleRuns(f)).toEqual({ ok: 3, frac: 2 })
  })

  it("runs 不是对象 → 空记录", () => {
    const f = aiScheduleStateFile(root)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ runs: [1, 2] }), "utf-8")
    expect(readAiScheduleRuns(f)).toEqual({})
  })
})
