import { describe, expect, it } from "vitest"
import { createPathResolver, type CheckPaths } from "../src/renderer/components/preview/path-resolver"
import { PREVIEW_CHECK_MAX_PATHS, type PreviewPathCheck } from "../src/shared/preview-types"

const at = (path: string, isDir = false): PreviewPathCheck => ({ path, isDir })

/** 记录每次批量检查的参数；结果由 answer 决定（默认：以 ok/ 开头的是能预览的文件，路径是 /abs/<原路径>） */
function fakeCheck(answer: (raw: string) => string | null = (raw) => (raw.startsWith("ok/") ? `/abs/${raw}` : null)) {
  const calls: string[][] = []
  const check: CheckPaths = async (paths) => {
    calls.push(paths)
    return paths.map((raw) => {
      const found = answer(raw)
      return found === null ? null : at(found)
    })
  }
  return { check, calls }
}

describe("合并请求", () => {
  it("同一时刻的多个请求合并成一次批量检查，结果按各自的路径对上", async () => {
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check)
    const out = await Promise.all([resolve("ok/a.ts"), resolve("no/b.ts"), resolve("ok/c.ts")])
    expect(out).toEqual([at("/abs/ok/a.ts"), null, at("/abs/ok/c.ts")])
    expect(calls).toEqual([["ok/a.ts", "no/b.ts", "ok/c.ts"]])
  })

  it("同一个路径被多处同时问到：只查一次，每个调用方都拿到结果", async () => {
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check)
    const out = await Promise.all([resolve("ok/a.ts"), resolve("ok/a.ts"), resolve("ok/a.ts")])
    expect(out).toEqual([at("/abs/ok/a.ts"), at("/abs/ok/a.ts"), at("/abs/ok/a.ts")])
    expect(calls).toEqual([["ok/a.ts"]])
  })

  it("第一批还在查的时候又来问同一个路径：不重复发起检查", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const calls: string[][] = []
    const check: CheckPaths = async (paths) => { calls.push(paths); await gate; return paths.map((p) => at(`/abs/${p}`)) }
    const resolve = createPathResolver(check)
    const first = resolve("ok/a.ts")
    await Promise.resolve()
    await Promise.resolve()
    const second = resolve("ok/a.ts")
    release()
    expect(await Promise.all([first, second])).toEqual([at("/abs/ok/a.ts"), at("/abs/ok/a.ts")])
    expect(calls).toHaveLength(1)
  })

  it("超过单次上限的分批发出，每批不超上限，结果仍然一一对应", async () => {
    const { check, calls } = fakeCheck(() => "/x")
    const resolve = createPathResolver(check)
    const raws = Array.from({ length: PREVIEW_CHECK_MAX_PATHS * 2 + 5 }, (_, i) => `ok/f${i}.ts`)
    const out = await Promise.all(raws.map(resolve))
    expect(out.every((p) => p?.path === "/x")).toBe(true)
    expect(calls.map((c) => c.length)).toEqual([PREVIEW_CHECK_MAX_PATHS, PREVIEW_CHECK_MAX_PATHS, 5])
    expect(calls.flat()).toEqual(raws)
  })
})

describe("缓存", () => {
  it("确认能预览的一直有效，不再检查", async () => {
    let t = 0
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check, { now: () => t })
    expect(await resolve("ok/a.ts")).toEqual(at("/abs/ok/a.ts"))
    t += 3_600_000
    expect(await resolve("ok/a.ts")).toEqual(at("/abs/ok/a.ts"))
    expect(calls).toHaveLength(1)
  })

  it("文件夹：isDir 原样带给调用方，同样一直有效", async () => {
    let t = 0
    const calls: string[][] = []
    const check: CheckPaths = async (paths) => { calls.push(paths); return paths.map((p) => at(`/abs/${p}`, true)) }
    const resolve = createPathResolver(check, { now: () => t })
    expect(await resolve("src")).toEqual(at("/abs/src", true))
    t += 3_600_000
    expect(await resolve("src")).toEqual(at("/abs/src", true))
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
    expect(await resolve("late.ts")).toEqual(at("/abs/late.ts"))
    expect(calls).toHaveLength(2)
  })
})

describe("fresh（不采信缓存里的「查不到」）", () => {
  it("缓存期内文件出现了：fresh 重新问并拿到结果，之后普通请求也用这个新结果", async () => {
    let t = 1000
    let exists = false
    const { check, calls } = fakeCheck(() => (exists ? "/abs/late.ts" : null))
    const resolve = createPathResolver(check, { now: () => t, missTtlMs: 5000 })
    expect(await resolve("late.ts")).toBeNull()
    exists = true
    t += 10
    expect(await resolve("late.ts")).toBeNull()
    expect(await resolve("late.ts", { fresh: true })).toEqual(at("/abs/late.ts"))
    expect(await resolve("late.ts")).toEqual(at("/abs/late.ts"))
    expect(calls).toHaveLength(2)
  })

  it("确认能预览的不重查：fresh 也直接用缓存", async () => {
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check)
    expect(await resolve("ok/a.ts")).toEqual(at("/abs/ok/a.ts"))
    expect(await resolve("ok/a.ts", { fresh: true })).toEqual(at("/abs/ok/a.ts"))
    expect(calls).toHaveLength(1)
  })

  it("同一个路径还在查：fresh 不重复发起检查", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const calls: string[][] = []
    const check: CheckPaths = async (paths) => { calls.push(paths); await gate; return paths.map((p) => at(`/abs/${p}`)) }
    const resolve = createPathResolver(check)
    const first = resolve("ok/a.ts")
    await Promise.resolve()
    await Promise.resolve()
    const second = resolve("ok/a.ts", { fresh: true })
    release()
    expect(await Promise.all([first, second])).toEqual([at("/abs/ok/a.ts"), at("/abs/ok/a.ts")])
    expect(calls).toHaveLength(1)
  })

  it("同一时刻多个 fresh 请求同一个查不到的路径：只查一次", async () => {
    const { check, calls } = fakeCheck()
    const resolve = createPathResolver(check)
    expect(await resolve("no/a.ts")).toBeNull()
    expect(await Promise.all([resolve("no/a.ts", { fresh: true }), resolve("no/a.ts", { fresh: true })])).toEqual([null, null])
    expect(calls).toEqual([["no/a.ts"], ["no/a.ts"]])
  })
})

describe("出错", () => {
  it("检查本身抛错：这一批都当查不到，且不缓存，下次还会再问", async () => {
    let fail = true
    const calls: string[][] = []
    const check: CheckPaths = async (paths) => {
      calls.push(paths)
      if (fail) throw new Error("ipc down")
      return paths.map((p) => at(`/abs/${p}`))
    }
    const resolve = createPathResolver(check)
    expect(await Promise.all([resolve("a.ts"), resolve("b.ts")])).toEqual([null, null])
    fail = false
    expect(await resolve("a.ts")).toEqual(at("/abs/a.ts"))
    expect(calls).toHaveLength(2)
  })

  it("返回的数组比输入短：缺的当查不到", async () => {
    const check: CheckPaths = async () => [at("/abs/a.ts")]
    const resolve = createPathResolver(check)
    expect(await Promise.all([resolve("a.ts"), resolve("b.ts")])).toEqual([at("/abs/a.ts"), null])
  })

  it("某一批出错不影响后面的批次", async () => {
    let n = 0
    const check: CheckPaths = async (paths) => {
      if (n++ === 0) throw new Error("first batch fails")
      return paths.map((p) => at(`/abs/${p}`))
    }
    const resolve = createPathResolver(check)
    const raws = Array.from({ length: PREVIEW_CHECK_MAX_PATHS + 1 }, (_, i) => `f${i}.ts`)
    const out = await Promise.all(raws.map(resolve))
    expect(out.slice(0, PREVIEW_CHECK_MAX_PATHS).every((p) => p === null)).toBe(true)
    expect(out[PREVIEW_CHECK_MAX_PATHS]).toEqual(at(`/abs/f${PREVIEW_CHECK_MAX_PATHS}.ts`))
  })
})
