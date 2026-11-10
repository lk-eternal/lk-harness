import { describe, expect, it } from "vitest"
import { createPathResolver, type CheckPaths } from "../src/renderer/components/preview/path-resolver"
import { PREVIEW_CHECK_MAX_PATHS } from "../src/shared/preview-types"

/** 记录每次批量检查的参数；结果由 answer 决定（默认：以 ok/ 开头的能预览，返回 /abs/<原路径>） */
function fakeCheck(answer: (raw: string) => string | null = (raw) => (raw.startsWith("ok/") ? `/abs/${raw}` : null)) {
  const calls: string[][] = []
  const check: CheckPaths = async (paths) => {
    calls.push(paths)
    return paths.map(answer)
  }
  return { check, calls }
}

describe("合并请求", () => {
  it("同一时刻的多个请求合并成一次批量检查，结果按各自的路径对上", async () => {
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check)
    const out = await Promise.all([resolve("ok/a.ts"), resolve("no/b.ts"), resolve("ok/c.ts")])
    expect(out).toEqual(["/abs/ok/a.ts", null, "/abs/ok/c.ts"])
    expect(calls).toEqual([["ok/a.ts", "no/b.ts", "ok/c.ts"]])
  })

  it("同一个路径被多处同时问到：只查一次，每个调用方都拿到结果", async () => {
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check)
    const out = await Promise.all([resolve("ok/a.ts"), resolve("ok/a.ts"), resolve("ok/a.ts")])
    expect(out).toEqual(["/abs/ok/a.ts", "/abs/ok/a.ts", "/abs/ok/a.ts"])
    expect(calls).toEqual([["ok/a.ts"]])
  })

  it("第一批还在查的时候又来问同一个路径：不重复发起检查", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const calls: string[][] = []
    const check: CheckPaths = async (paths) => { calls.push(paths); await gate; return paths.map((p) => `/abs/${p}`) }
    const resolve = createPathResolver(check)
    const first = resolve("ok/a.ts")
    await Promise.resolve()
    await Promise.resolve()
    const second = resolve("ok/a.ts")
    release()
    expect(await Promise.all([first, second])).toEqual(["/abs/ok/a.ts", "/abs/ok/a.ts"])
    expect(calls).toHaveLength(1)
  })

  it("超过单次上限的分批发出，每批不超上限，结果仍然一一对应", async () => {
    const { check, calls } = fakeCheck(() => "/x")
    const resolve = createPathResolver(check)
    const raws = Array.from({ length: PREVIEW_CHECK_MAX_PATHS * 2 + 5 }, (_, i) => `ok/f${i}.ts`)
    const out = await Promise.all(raws.map(resolve))
    expect(out.every((p) => p === "/x")).toBe(true)
    expect(calls.map((c) => c.length)).toEqual([PREVIEW_CHECK_MAX_PATHS, PREVIEW_CHECK_MAX_PATHS, 5])
    expect(calls.flat()).toEqual(raws)
  })
})

describe("缓存", () => {
  it("确认能预览的一直有效，不再检查", async () => {
    let t = 0
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check, { now: () => t })
    expect(await resolve("ok/a.ts")).toBe("/abs/ok/a.ts")
    t += 3_600_000
    expect(await resolve("ok/a.ts")).toBe("/abs/ok/a.ts")
    expect(calls).toHaveLength(1)
  })

  it("查不到的只缓存一小会儿：期内不重查，过期后重新问（文件可能是刚写出来的）", async () => {
    let t = 1000
    let exists = false
    const { check, calls } = fakeCheck(() => (exists ? "/abs/late.ts" : null))
    const resolve = createPathResolver(check, { now: () => t, missTtlMs: 5000 })
    expect(await resolve("late.ts")).toBeNull()
    t += 4999
    expect(await resolve("late.ts")).toBeNull()
    expect(calls).toHaveLength(1)
    exists = true
    t += 2
    expect(await resolve("late.ts")).toBe("/abs/late.ts")
    expect(calls).toHaveLength(2)
  })
})

describe("出错", () => {
  it("检查本身抛错：这一批都当查不到，且不缓存，下次还会再问", async () => {
    let fail = true
    const calls: string[][] = []
    const check: CheckPaths = async (paths) => {
      calls.push(paths)
      if (fail) throw new Error("ipc down")
      return paths.map((p) => `/abs/${p}`)
    }
    const resolve = createPathResolver(check)
    expect(await Promise.all([resolve("a.ts"), resolve("b.ts")])).toEqual([null, null])
    fail = false
    expect(await resolve("a.ts")).toBe("/abs/a.ts")
    expect(calls).toHaveLength(2)
  })

  it("返回的数组比输入短：缺的当查不到", async () => {
    const check: CheckPaths = async () => ["/abs/a.ts"]
    const resolve = createPathResolver(check)
    expect(await Promise.all([resolve("a.ts"), resolve("b.ts")])).toEqual(["/abs/a.ts", null])
  })

  it("某一批出错不影响后面的批次", async () => {
    let n = 0
    const check: CheckPaths = async (paths) => {
      if (n++ === 0) throw new Error("first batch fails")
      return paths.map((p) => `/abs/${p}`)
    }
    const resolve = createPathResolver(check)
    const raws = Array.from({ length: PREVIEW_CHECK_MAX_PATHS + 1 }, (_, i) => `f${i}.ts`)
    const out = await Promise.all(raws.map(resolve))
    expect(out.slice(0, PREVIEW_CHECK_MAX_PATHS).every((p) => p === null)).toBe(true)
    expect(out[PREVIEW_CHECK_MAX_PATHS]).toBe(`/abs/f${PREVIEW_CHECK_MAX_PATHS}.ts`)
  })
})
