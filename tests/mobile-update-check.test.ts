import { describe, expect, it } from "vitest"
import { pendingUpdate } from "../src/mobile/update-check"
import type { MobileUpdateInfo } from "../src/shared/app-update"

const info = (over: Partial<MobileUpdateInfo> = {}): MobileUpdateInfo => ({
  ok: true,
  latestVersion: "1.1.3",
  apkUrl: "https://example.com/a.apk",
  releaseUrl: "https://example.com/release",
  ...over,
})

describe("pendingUpdate", () => {
  it("有更新版本时给出版本和下载地址", () => {
    expect(pendingUpdate(info(), "1.1.2", "")).toEqual({
      version: "1.1.3",
      apkUrl: "https://example.com/a.apk",
      releaseUrl: "https://example.com/release",
    })
  })

  it("已是最新或更新时不提示", () => {
    expect(pendingUpdate(info(), "1.1.3", "")).toBeNull()
    expect(pendingUpdate(info(), "1.2.0", "")).toBeNull()
  })

  it("用户忽略过的版本不再提示，更新的版本会重新提示", () => {
    expect(pendingUpdate(info(), "1.1.2", "1.1.3")).toBeNull()
    expect(pendingUpdate(info({ latestVersion: "1.1.4" }), "1.1.2", "1.1.3")?.version).toBe("1.1.4")
  })

  it("电脑端没查到、响应缺字段时不提示", () => {
    expect(pendingUpdate(null, "1.1.2", "")).toBeNull()
    expect(pendingUpdate(undefined, "1.1.2", "")).toBeNull()
    expect(pendingUpdate({ ok: false, error: "暂时无法获取最新版本" }, "1.1.2", "")).toBeNull()
    expect(pendingUpdate(info({ latestVersion: undefined }), "1.1.2", "")).toBeNull()
    expect(pendingUpdate(info({ apkUrl: undefined }), "1.1.2", "")).toBeNull()
  })

  it("本机版本没注入（0.0.0）时，任何已发布版本都算更新", () => {
    expect(pendingUpdate(info(), "0.0.0", "")?.version).toBe("1.1.3")
  })

  it("缺少发布页地址时退回 APK 地址", () => {
    expect(pendingUpdate(info({ releaseUrl: undefined }), "1.1.2", "")?.releaseUrl).toBe("https://example.com/a.apk")
  })
})
