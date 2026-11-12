import { describe, expect, it } from "vitest"
import { SILENT_CHECK_INTERVAL_MS, decideSilentUpdate, silentReadyMessage, type SilentUpdateInput } from "../src/shared/silent-update.js"

const base: SilentUpdateInput = { enabled: true, busy: false, current: "1.4.1", remote: "1.4.2", readyVersion: null }
const decide = (extra: Partial<SilentUpdateInput> = {}) => decideSilentUpdate({ ...base, ...extra })

describe("decideSilentUpdate（什么时候在后台下载）", () => {
  it("开着、没在忙、远端更新：下载，带上要下的版本", () => {
    expect(decide()).toEqual({ action: "download", version: "1.4.2" })
  })

  it("没开：不动（其余条件再满足也不下）", () => {
    expect(decide({ enabled: false })).toEqual({ action: "skip", reason: "disabled" })
  })

  it("已经有一轮在查或在下：不再起第二路", () => {
    expect(decide({ busy: true })).toEqual({ action: "skip", reason: "busy" })
  })

  it("远端查不到：这一轮跳过，等下个周期", () => {
    expect(decide({ remote: null })).toEqual({ action: "skip", reason: "no-remote" })
    expect(decide({ remote: "" })).toEqual({ action: "skip", reason: "no-remote" })
  })

  it("远端和当前一样、或比当前还旧（版本源缓存滞后）：没有更新", () => {
    expect(decide({ remote: "1.4.1" })).toEqual({ action: "skip", reason: "up-to-date" })
    expect(decide({ remote: "1.4.0" })).toEqual({ action: "skip", reason: "up-to-date" })
  })

  it("远端版本号解析不了：当没有更新，宁可漏下也不误装", () => {
    expect(decide({ remote: "not-a-version" })).toEqual({ action: "skip", reason: "up-to-date" })
    expect(decide({ current: "dev" })).toEqual({ action: "skip", reason: "up-to-date" })
  })

  it("这一版已经下好了：不重复下", () => {
    expect(decide({ readyVersion: "1.4.2" })).toEqual({ action: "skip", reason: "already-downloaded" })
  })

  it("下好的是更旧的一版、远端又出了新的：重新下，以最新的为准", () => {
    expect(decide({ remote: "1.4.3", readyVersion: "1.4.2" })).toEqual({ action: "download", version: "1.4.3" })
  })

  it("跨次版本和预发布：1.5.0 比 1.4.9 新；正式版比同号预发布新", () => {
    expect(decide({ current: "1.4.9", remote: "1.5.0" })).toEqual({ action: "download", version: "1.5.0" })
    expect(decide({ current: "1.5.0-beta.1", remote: "1.5.0" })).toEqual({ action: "download", version: "1.5.0" })
  })

  it("判断顺序：没开优先于忙，忙优先于查不到", () => {
    expect(decide({ enabled: false, busy: true, remote: null })).toEqual({ action: "skip", reason: "disabled" })
    expect(decide({ busy: true, remote: null })).toEqual({ action: "skip", reason: "busy" })
  })
})

describe("静默更新的常量和文案", () => {
  it("定时复查间隔：几个小时一次，既不是每分钟打 GitHub，也不会一天才查一次", () => {
    expect(SILENT_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
    expect(SILENT_CHECK_INTERVAL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it("下载好的提示：写明版本、退出时自动安装、不出现向导、可以立即安装", () => {
    const m = silentReadyMessage("1.4.2")
    expect(m).toContain("v1.4.2")
    expect(m).toContain("退出应用时会自动安装")
    expect(m).toContain("不会出现安装向导")
    expect(m).toContain("立即安装")
  })
})
