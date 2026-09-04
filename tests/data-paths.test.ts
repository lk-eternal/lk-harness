import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  configDir,
  sessionStateDir,
  transcriptDir,
  catalogDir,
  migrateDataLayout,
} from "../src/shared/data-paths.js"

describe("data-paths", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-layout-"))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  it("散文件搬进子目录，幂等", () => {
    fs.writeFileSync(path.join(root, "session-routing.json"), "{}")
    fs.writeFileSync(path.join(root, "carryover-pending.json"), "{}")
    fs.writeFileSync(path.join(root, "transcript-abc.jsonl"), "{}\n")
    fs.writeFileSync(path.join(root, "scheduled-tasks.json"), "[]")
    const moved = migrateDataLayout(root)
    expect(moved.length).toBe(4)
    expect(fs.existsSync(path.join(sessionStateDir(root), "session-routing.json"))).toBe(true)
    expect(fs.existsSync(path.join(transcriptDir(root), "carryover-pending.json"))).toBe(true)
    expect(fs.existsSync(path.join(transcriptDir(root), "transcript-abc.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(configDir(root), "scheduled-tasks.json"))).toBe(true)
    expect(fs.existsSync(path.join(root, "session-routing.json"))).toBe(false)
    expect(migrateDataLayout(root)).toEqual([])
  })
  it("目标已存在则跳过，不覆盖", () => {
    fs.mkdirSync(sessionStateDir(root), { recursive: true })
    fs.writeFileSync(path.join(sessionStateDir(root), "session-routing.json"), '{"new":1}')
    fs.writeFileSync(path.join(root, "session-routing.json"), '{"old":1}')
    expect(migrateDataLayout(root)).toEqual([])
    expect(fs.readFileSync(path.join(sessionStateDir(root), "session-routing.json"), "utf8")).toBe('{"new":1}')
  })
  it("空目录无事可做", () => {
    expect(migrateDataLayout(root)).toEqual([])
    expect(catalogDir(root).endsWith("catalogs")).toBe(true)
  })
})
