import { describe, expect, it, vi } from "vitest"
import { createMobileUpdateInfoProvider } from "../electron/mobile-update-info"
import { MOBILE_APK_PATH, MOBILE_APK_URL, MOBILE_RELEASES_URL, type MobileUpdateInfo } from "../src/shared/app-update"

function setup(results: Array<{ version: string } | null | Error>) {
  let clock = 1_000_000
  const calls = vi.fn(async () => {
    const r = results.shift()
    if (r instanceof Error) throw r
    return r ?? null
  })
  const get = createMobileUpdateInfoProvider({
    fetchLatest: calls,
    now: () => clock,
    okTtlMs: 60_000,
    failTtlMs: 10_000,
  })
  return { get, calls, advance: (ms: number) => (clock += ms) }
}

describe("createMobileUpdateInfoProvider", () => {
  it("查到版本后返回版本号和固定的下载地址", async () => {
    const { get } = setup([{ version: "1.1.3" }])
    expect(await get()).toEqual({
      ok: true,
      latestVersion: "1.1.3",
      apkUrl: MOBILE_APK_URL,
      releaseUrl: MOBILE_RELEASES_URL,
      source: "github",
    })
  })

  it("缓存期内不重复查外网，过期后再查", async () => {
    const { get, calls, advance } = setup([{ version: "1.1.3" }, { version: "1.1.4" }])
    await get()
    advance(59_000)
    expect((await get()).latestVersion).toBe("1.1.3")
    expect(calls).toHaveBeenCalledTimes(1)
    advance(2_000)
    expect((await get()).latestVersion).toBe("1.1.4")
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it("并发请求合并成一次外网查询", async () => {
    const { get, calls } = setup([{ version: "1.1.3" }])
    const [a, b, c] = await Promise.all([get(), get(), get()])
    expect(calls).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it("查不到时返回 ok=false，且短时间内不反复重试", async () => {
    const { get, calls, advance } = setup([null, { version: "1.1.3" }])
    const first = await get()
    expect(first.ok).toBe(false)
    expect(first.error).toBeTruthy()
    advance(5_000)
    expect((await get()).ok).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
    advance(6_000)
    expect((await get()).latestVersion).toBe("1.1.3")
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it("查询抛错也不会向上抛", async () => {
    const { get } = setup([new Error("network down")])
    expect((await get()).ok).toBe(false)
  })

  it("刷新失败时沿用上次查到的结果", async () => {
    const { get, advance } = setup([{ version: "1.1.3" }, new Error("network down")])
    await get()
    advance(61_000)
    const r = await get()
    expect(r.ok).toBe(true)
    expect(r.latestVersion).toBe("1.1.3")
  })

  it("版本号为空串当作没查到", async () => {
    const { get } = setup([{ version: "  " }])
    expect((await get()).ok).toBe(false)
  })

  it("失败后恢复：不会一直卡在失败状态", async () => {
    const { get, advance } = setup([new Error("x"), { version: "1.1.3" }])
    expect((await get()).ok).toBe(false)
    advance(11_000)
    expect((await get()).ok).toBe(true)
  })
})

describe("createMobileUpdateInfoProvider：电脑端内置了 APK", () => {
  const desktopInfo: MobileUpdateInfo = {
    ok: true,
    latestVersion: "1.3.0",
    apkPath: MOBILE_APK_PATH,
    releaseUrl: MOBILE_RELEASES_URL,
    source: "desktop",
  }

  it("直接用内置 APK 的信息，一次外网都不查（GitHub 不通也不影响）", async () => {
    const fetchLatest = vi.fn(async () => {
      throw new Error("GitHub 不通")
    })
    const get = createMobileUpdateInfoProvider({ fetchLatest, bundledApk: () => desktopInfo })
    expect(await get()).toBe(desktopInfo)
    expect(await get()).toBe(desktopInfo)
    expect(fetchLatest).not.toHaveBeenCalled()
  })

  it("内置信息每次请求都重新取，换了安装包不用重启", async () => {
    let current: MobileUpdateInfo | null = desktopInfo
    const get = createMobileUpdateInfoProvider({
      fetchLatest: async () => null,
      bundledApk: () => current,
    })
    expect((await get()).latestVersion).toBe("1.3.0")
    current = { ...desktopInfo, latestVersion: "1.4.0" }
    expect((await get()).latestVersion).toBe("1.4.0")
  })

  it("没有内置 APK（开发环境、没带 APK 的构建）时退回查 GitHub", async () => {
    const fetchLatest = vi.fn(async () => ({ version: "1.2.9" }))
    const get = createMobileUpdateInfoProvider({ fetchLatest, bundledApk: () => null })
    expect(await get()).toMatchObject({ ok: true, latestVersion: "1.2.9", source: "github", apkUrl: MOBILE_APK_URL })
    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })
})
