import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { removeLockFileIfOwned } from "../src/shared/lock-file.js"

let dir: string
let lockPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-lock-"))
  lockPath = path.join(dir, "daemon.lock")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("removeLockFileIfOwned：旧 daemon 晚退出，不能删掉新 daemon 的锁", () => {
  it("锁是自己写的：删除", () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 111, port: 19528 }))
    expect(removeLockFileIfOwned(lockPath, 111)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("锁已被新 daemon 覆盖（pid 不同）：保留", () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 222, port: 19529 }))
    expect(removeLockFileIfOwned(lockPath, 111)).toBe(false)
    expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toEqual({ pid: 222, port: 19529 })
  })

  it("没有锁文件：什么都不做，不报错", () => {
    expect(removeLockFileIfOwned(lockPath, 111)).toBe(false)
  })

  it("锁文件损坏（读不出 pid）：当没有主人，清掉", () => {
    fs.writeFileSync(lockPath, "{not json")
    expect(removeLockFileIfOwned(lockPath, 111)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("锁里没有 pid 字段：当没有主人，清掉", () => {
    fs.writeFileSync(lockPath, JSON.stringify({ port: 19528 }))
    expect(removeLockFileIfOwned(lockPath, 111)).toBe(true)
  })
})
