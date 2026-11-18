import { describe, it, expect, afterEach, vi } from "vitest"
import { Writable } from "node:stream"
import { spawn } from "node:child_process"
import {
  isBrokenPipeError,
  guardBrokenPipe,
  parsePidEnv,
  defaultIsAlive,
  startParentWatchdog,
} from "../src/shared/process-guards.js"

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("isBrokenPipeError", () => {
  it.each(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET"])("%s 算管道断开", (code) => {
    expect(isBrokenPipeError(errWithCode(code))).toBe(true)
  })

  it("别的错误、空值不算", () => {
    expect(isBrokenPipeError(errWithCode("EACCES"))).toBe(false)
    expect(isBrokenPipeError(new Error("boom"))).toBe(false)
    expect(isBrokenPipeError(undefined)).toBe(false)
    expect(isBrokenPipeError(null)).toBe(false)
  })
})

describe("guardBrokenPipe：应用没了以后写 stderr 不能自激", () => {
  it("没装监听时，EPIPE 的 error 事件会抛出（这就是掉进 uncaughtException 无限循环的起点）", () => {
    const s = new Writable({ write: (_c, _e, cb) => cb() })
    expect(() => s.emit("error", errWithCode("EPIPE"))).toThrow(/EPIPE/)
  })

  it.each(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET"])("装了以后 %s 被吞掉，不再抛出", (code) => {
    const s = new Writable({ write: (_c, _e, cb) => cb() })
    guardBrokenPipe([s])
    expect(() => s.emit("error", errWithCode(code))).not.toThrow()
  })

  it("别的错误照旧抛出，不吞真问题", () => {
    const s = new Writable({ write: (_c, _e, cb) => cb() })
    guardBrokenPipe([s])
    expect(() => s.emit("error", errWithCode("EACCES"))).toThrow(/EACCES/)
  })

  it("真实写入失败（对端已断）：写了也不产生未处理错误", async () => {
    const s = new Writable({ write: (_c, _e, cb) => cb(errWithCode("EPIPE")) })
    guardBrokenPipe([s])
    s.write("日志一行\n")
    s.write("日志又一行\n")
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    // 走到这里没有未处理的 error 事件（vitest 遇到未处理异常会让整个运行失败）
    expect(s.destroyed).toBe(true)
  })

  it("多个流都装上", () => {
    const a = new Writable({ write: (_c, _e, cb) => cb() })
    const b = new Writable({ write: (_c, _e, cb) => cb() })
    guardBrokenPipe([a, b])
    expect(() => a.emit("error", errWithCode("EPIPE"))).not.toThrow()
    expect(() => b.emit("error", errWithCode("EPIPE"))).not.toThrow()
  })
})

describe("parsePidEnv", () => {
  it("正整数 → pid", () => {
    expect(parsePidEnv("1234")).toBe(1234)
    expect(parsePidEnv(" 42 ")).toBe(42)
  })

  it("空 / 非数字 / 0 / 负数 / 小数 / 带后缀 → undefined（不开看门狗）", () => {
    for (const raw of [undefined, "", "abc", "0", "-5", "1.5", "12abc", "1e3", "99999999999999999999"]) {
      expect(parsePidEnv(raw), String(raw)).toBeUndefined()
    }
  })
})

describe("defaultIsAlive", () => {
  it("自己还活着", () => {
    expect(defaultIsAlive(process.pid)).toBe(true)
  })

  it("已退出的进程判为不在", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    const pid = child.pid!
    await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    expect(defaultIsAlive(pid)).toBe(false)
  })
})

describe("startParentWatchdog：父进程没了就通知退出", () => {
  it("父进程在时不动；没了以后在下一次检查时通知一次，且之后不再检查", () => {
    vi.useFakeTimers()
    let alive = true
    const probes: number[] = []
    const onOrphaned = vi.fn()
    startParentWatchdog({
      parentPid: 4321,
      intervalMs: 1000,
      isAlive: (pid) => { probes.push(pid); return alive },
      onOrphaned,
    })

    vi.advanceTimersByTime(3000)
    expect(probes).toEqual([4321, 4321, 4321])
    expect(onOrphaned).not.toHaveBeenCalled()

    alive = false
    vi.advanceTimersByTime(1000)
    expect(onOrphaned).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    expect(onOrphaned).toHaveBeenCalledTimes(1)
    expect(probes).toHaveLength(4)
  })

  it("默认每 5 秒检查一次", () => {
    vi.useFakeTimers()
    const isAlive = vi.fn(() => true)
    startParentWatchdog({ parentPid: 1, isAlive, onOrphaned: () => {} })
    vi.advanceTimersByTime(4999)
    expect(isAlive).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(isAlive).toHaveBeenCalledTimes(1)
  })

  it("返回的停止函数能取消看门狗", () => {
    vi.useFakeTimers()
    const onOrphaned = vi.fn()
    const stop = startParentWatchdog({ parentPid: 1, intervalMs: 1000, isAlive: () => false, onOrphaned })
    stop()
    vi.advanceTimersByTime(5000)
    expect(onOrphaned).not.toHaveBeenCalled()
  })

  it("默认探测：一个已退出的父进程会被发现", async () => {
    const parent = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    const pid = parent.pid!
    await new Promise<void>((resolve) => parent.once("exit", () => resolve()))
    const orphaned = await new Promise<boolean>((resolve) => {
      startParentWatchdog({ parentPid: pid, intervalMs: 20, onOrphaned: () => resolve(true) })
      setTimeout(() => resolve(false), 2000)
    })
    expect(orphaned).toBe(true)
  })
})
