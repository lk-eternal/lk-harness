import { describe, expect, it, vi } from "vitest"
import type { MobileUpdateInfo } from "../src/shared/app-update"
import {
  MAX_AUTO_RETRIES,
  UPDATE_RECHECK_INTERVAL_MS,
  createUpdateController,
  describeUpdateStatus,
  failBackoffMs,
} from "../src/mobile/update-controller"

const MIN = 60_000

const desktopInfo = (version: string): MobileUpdateInfo => ({
  ok: true,
  latestVersion: version,
  apkPath: "/lk-harness-mobile.apk",
  releaseUrl: "https://github.com/x/releases/latest",
  source: "desktop",
})

type Answer = MobileUpdateInfo | Error

function setup(opts: { current?: string; dismissed?: string; baseUrl?: string } = {}) {
  let clock = 1_000_000
  let dismissed = opts.dismissed ?? ""
  let baseUrl = opts.baseUrl ?? "http://192.168.1.5:19529"
  const answers: Answer[] = []
  const timers: { fn: () => void; ms: number; id: number; at: number }[] = []
  let nextTimer = 1
  const fetchInfo = vi.fn(async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]
    if (!a) throw new Error("没准备答案")
    if (a instanceof Error) throw a
    return a
  })
  const openUrl = vi.fn(async (_url: string) => ({ ok: true }) as { ok: true } | { ok: false; reason: string })
  const onError = vi.fn()
  const saveDismissed = vi.fn((v: string) => {
    dismissed = v
  })
  const c = createUpdateController({
    fetchInfo,
    getBaseUrl: () => baseUrl,
    currentVersion: opts.current ?? "1.3.0",
    loadDismissed: () => dismissed,
    saveDismissed,
    openUrl,
    onError,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: nextTimer++, at: clock + ms }
      timers.push(t)
      return t.id
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  return {
    c,
    fetchInfo,
    openUrl,
    onError,
    saveDismissed,
    timers,
    answer: (...a: Answer[]) => {
      answers.length = 0
      answers.push(...a)
    },
    advance: (ms: number) => {
      clock += ms
    },
    /** 让到点的定时器触发一个（模拟浏览器的定时器） */
    fireTimer: async () => {
      const t = timers.shift()
      if (!t) throw new Error("没有待触发的定时器")
      clock = Math.max(clock, t.at)
      t.fn()
      await settle()
    },
    setBaseUrl: (u: string) => {
      baseUrl = u
    },
  }
}

/** 等在途的异步检查落地 */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe("failBackoffMs / describeUpdateStatus", () => {
  it("失败退避：30 秒、2 分钟、8 分钟，最多半小时", () => {
    expect([1, 2, 3, 4, 5, 9].map(failBackoffMs)).toEqual([30_000, 2 * MIN, 8 * MIN, 30 * MIN, 30 * MIN, 30 * MIN])
  })

  it("菜单小字：当前版本 + 最近一次检查的结果", () => {
    expect(describeUpdateStatus({ phase: "idle" }, "1.3.0")).toBe("当前 v1.3.0")
    expect(describeUpdateStatus({ phase: "checking" }, "1.3.0")).toBe("当前 v1.3.0 · 检查中…")
    expect(describeUpdateStatus({ phase: "latest" }, "1.3.0")).toBe("当前 v1.3.0 · 已是最新")
    expect(describeUpdateStatus({ phase: "update", version: "1.4.0" }, "1.3.0")).toBe("当前 v1.3.0 · 有新版本 v1.4.0")
    expect(describeUpdateStatus({ phase: "failed", error: "无法连接" }, "1.3.0")).toBe("当前 v1.3.0 · 检查失败：无法连接")
  })
})

describe("自动检查", () => {
  it("连上电脑端后查一次，有新版本就给出提示条，下载地址接在当前连着的地址后面", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    expect(t.c.getState().status).toEqual({ phase: "checking" })
    await settle()
    expect(t.fetchInfo).toHaveBeenCalledTimes(1)
    expect(t.c.getState().update).toEqual({
      version: "1.4.0",
      apkUrl: "http://192.168.1.5:19529/lk-harness-mobile.apk",
      releaseUrl: "http://192.168.1.5:19529/lk-harness-mobile.apk",
    })
    expect(t.c.getState().status).toEqual({ phase: "update", version: "1.4.0" })
  })

  it("已是最新：没有提示条，状态是 latest", async () => {
    const t = setup({ current: "1.4.0" })
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update).toBeNull()
    expect(t.c.getState().status).toEqual({ phase: "latest" })
  })

  it("间隔内（回到前台、线路变化）不重复问电脑，过了间隔再问", async () => {
    const t = setup()
    t.answer(desktopInfo("1.3.0"))
    t.c.autoCheck()
    await settle()
    t.advance(UPDATE_RECHECK_INTERVAL_MS - 1000)
    t.c.autoCheck()
    await settle()
    expect(t.fetchInfo).toHaveBeenCalledTimes(1)
    t.advance(2000)
    t.c.autoCheck()
    await settle()
    expect(t.fetchInfo).toHaveBeenCalledTimes(2)
  })

  it("App 常驻后台几天后切回前台，能查到这期间电脑升级带来的新版本（以前只在冷启动查一次，这里就看不到）", async () => {
    const t = setup()
    t.answer(desktopInfo("1.3.0"))
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update).toBeNull()
    t.advance(3 * 24 * 60 * MIN)
    t.answer(desktopInfo("1.5.0"))
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update?.version).toBe("1.5.0")
  })

  it("同时触发多次只问一次", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    t.c.autoCheck()
    t.c.autoCheck()
    await settle()
    expect(t.fetchInfo).toHaveBeenCalledTimes(1)
  })

  it("检查完后用的是那一刻手机连着的地址（换了线路也跟着变）", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    t.setBaseUrl("https://lk.example.com")
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update?.apkUrl).toBe("https://lk.example.com/lk-harness-mobile.apk")
  })
})

describe("失败后的重试", () => {
  it("失败时静默（不弹错误），状态记为 failed，并安排 30 秒后重试；重试成功后恢复正常", async () => {
    const t = setup()
    t.answer({ ok: false, error: "电脑端没有及时响应" }, desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().status).toEqual({ phase: "failed", error: "电脑端没有及时响应" })
    expect(t.c.getState().update).toBeNull()
    expect(t.onError).not.toHaveBeenCalled()
    expect(t.timers).toHaveLength(1)
    expect(t.timers[0].ms).toBe(30_000)

    await t.fireTimer()
    expect(t.fetchInfo).toHaveBeenCalledTimes(2)
    expect(t.c.getState().update?.version).toBe("1.4.0")
    expect(t.timers).toHaveLength(0)
  })

  it("连续失败按 30 秒、2 分钟、8 分钟退避，三次重试用完就不再自动重试", async () => {
    const t = setup()
    t.answer({ ok: false, error: "x" })
    t.c.autoCheck()
    await settle()
    const delays: number[] = [t.timers[0].ms]
    for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
      await t.fireTimer()
      if (t.timers[0]) delays.push(t.timers[0].ms)
    }
    expect(delays).toEqual([30_000, 2 * MIN, 8 * MIN])
    expect(t.fetchInfo).toHaveBeenCalledTimes(1 + MAX_AUTO_RETRIES)
    expect(t.timers).toHaveLength(0)
  })

  it("用完自动重试之后，下次回到前台（过了退避期）还会再试", async () => {
    const t = setup()
    t.answer({ ok: false, error: "x" })
    t.c.autoCheck()
    await settle()
    for (let i = 0; i < MAX_AUTO_RETRIES; i++) await t.fireTimer()
    expect(t.timers).toHaveLength(0)
    t.answer(desktopInfo("1.4.0"))
    t.advance(30 * MIN)
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update?.version).toBe("1.4.0")
  })

  it("退避期内回到前台不会连着狂问，过了退避期才再问", async () => {
    const t = setup()
    t.answer({ ok: false, error: "x" }, desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    t.advance(10_000)
    t.c.autoCheck()
    await settle()
    expect(t.fetchInfo).toHaveBeenCalledTimes(1)
    t.advance(25_000)
    t.c.autoCheck()
    await settle()
    expect(t.fetchInfo).toHaveBeenCalledTimes(2)
  })

  it("请求直接抛错（断网）也按失败处理，不会往外抛", async () => {
    const t = setup()
    t.answer(new Error("network down"))
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().status).toEqual({ phase: "failed", error: "无法连接到电脑端，请检查网络" })
  })

  it("电脑端没给错误原因时也有一句话", async () => {
    const t = setup()
    t.answer({ ok: false })
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().status.phase).toBe("failed")
    expect((t.c.getState().status as { error: string }).error).toBeTruthy()
  })

  it("等重试的时候别的检查（回到前台、手动）先成功了，就把还没到点的重试取消掉，不再多问一次", async () => {
    const t = setup()
    t.answer({ ok: false, error: "x" }, desktopInfo("1.3.0"))
    t.c.autoCheck()
    await settle()
    expect(t.timers).toHaveLength(1)
    t.advance(31_000)
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().status).toEqual({ phase: "latest" })
    expect(t.timers).toHaveLength(0)
  })

  it("stop() 取消还没触发的重试", async () => {
    const t = setup()
    t.answer({ ok: false, error: "x" })
    t.c.autoCheck()
    await settle()
    expect(t.timers).toHaveLength(1)
    t.c.stop()
    expect(t.timers).toHaveLength(0)
  })
})

describe("手动检查", () => {
  it("不受间隔限制，返回结果；查到新版本返回 update", async () => {
    const t = setup()
    t.answer(desktopInfo("1.3.0"), desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    expect(await t.c.checkNow()).toBe("update")
    expect(t.fetchInfo).toHaveBeenCalledTimes(2)
    expect(t.c.getState().update?.version).toBe("1.4.0")
  })

  it("已是最新返回 latest，失败返回 failed 且状态里有原因", async () => {
    const t = setup({ current: "1.4.0" })
    t.answer(desktopInfo("1.4.0"), { ok: false, error: "电脑端没有及时响应" })
    expect(await t.c.checkNow()).toBe("latest")
    expect(await t.c.checkNow()).toBe("failed")
    expect(t.c.getState().status).toEqual({ phase: "failed", error: "电脑端没有及时响应" })
  })

  it("不看「忽略」：用户忽略过的版本，手动检查仍会把提示条拿出来", async () => {
    const t = setup({ dismissed: "1.4.0" })
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    // 自动检查遵守忽略，但菜单状态照实说有新版本
    expect(t.c.getState().update).toBeNull()
    expect(t.c.getState().status).toEqual({ phase: "update", version: "1.4.0" })
    expect(await t.c.checkNow()).toBe("update")
    expect(t.c.getState().update?.version).toBe("1.4.0")
  })

  it("手动查出来、正显示着的提示条，不会被之后一次自动检查悄悄收掉", async () => {
    const t = setup({ dismissed: "1.4.0" })
    t.answer(desktopInfo("1.4.0"))
    await t.c.checkNow()
    expect(t.c.getState().update?.version).toBe("1.4.0")
    t.advance(UPDATE_RECHECK_INTERVAL_MS + 1000)
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update?.version).toBe("1.4.0")
  })

  it("自动检查在途时点手动检查：等它完成后再查一次（要的是不看忽略的结果）", async () => {
    const t = setup({ dismissed: "1.4.0" })
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    const manual = t.c.checkNow()
    expect(await manual).toBe("update")
    expect(t.fetchInfo).toHaveBeenCalledTimes(2)
    expect(t.c.getState().update?.version).toBe("1.4.0")
  })
})

describe("忽略与下载", () => {
  it("忽略：记下这个版本、收起提示条；之后的自动检查不再弹，更新的版本出来才重新弹", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    t.c.dismiss()
    expect(t.saveDismissed).toHaveBeenCalledWith("1.4.0")
    expect(t.c.getState().update).toBeNull()

    t.advance(UPDATE_RECHECK_INTERVAL_MS + 1000)
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update).toBeNull()

    t.advance(UPDATE_RECHECK_INTERVAL_MS + 1000)
    t.answer(desktopInfo("1.5.0"))
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update?.version).toBe("1.5.0")
  })

  it("没有提示条时忽略什么都不做", () => {
    const t = setup()
    t.c.dismiss()
    expect(t.saveDismissed).not.toHaveBeenCalled()
  })

  it("下载更新：把下载地址交给系统浏览器", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    await t.c.startUpdate()
    expect(t.openUrl).toHaveBeenCalledWith("http://192.168.1.5:19529/lk-harness-mobile.apk")
    expect(t.onError).not.toHaveBeenCalled()
  })

  it("调不起系统浏览器：报出原因和可以手动打开的地址", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    t.c.autoCheck()
    await settle()
    t.openUrl.mockResolvedValueOnce({ ok: false, reason: "系统浏览器无响应" })
    await t.c.startUpdate()
    expect(t.onError).toHaveBeenCalledWith(
      "无法调起系统浏览器（系统浏览器无响应），请手动打开下载：http://192.168.1.5:19529/lk-harness-mobile.apk",
    )
  })

  it("没有可下载的更新时点下载什么都不做", async () => {
    const t = setup()
    await t.c.startUpdate()
    expect(t.openUrl).not.toHaveBeenCalled()
  })
})

describe("旧版电脑端 / GitHub 来源", () => {
  it("来源是 GitHub 时照旧用绝对地址，手动打开的地址是发布页", async () => {
    const t = setup()
    t.answer({
      ok: true,
      latestVersion: "1.4.0",
      apkUrl: "https://github.com/x/releases/latest/download/lk-harness-mobile.apk",
      releaseUrl: "https://github.com/x/releases/latest",
    })
    t.c.autoCheck()
    await settle()
    expect(t.c.getState().update).toEqual({
      version: "1.4.0",
      apkUrl: "https://github.com/x/releases/latest/download/lk-harness-mobile.apk",
      releaseUrl: "https://github.com/x/releases/latest",
    })
  })
})

describe("订阅", () => {
  it("状态变化时通知，取消订阅后不再通知；没变化时 getState 返回同一个对象", async () => {
    const t = setup()
    t.answer(desktopInfo("1.4.0"))
    const listener = vi.fn()
    const off = t.c.subscribe(listener)
    const before = t.c.getState()
    expect(t.c.getState()).toBe(before)
    t.c.autoCheck()
    await settle()
    expect(listener).toHaveBeenCalled()
    expect(t.c.getState()).not.toBe(before)
    off()
    listener.mockClear()
    await t.c.checkNow()
    expect(listener).not.toHaveBeenCalled()
  })
})
