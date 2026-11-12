import { describe, expect, it } from "vitest"
import { pendingUpdate, resolveApkUrl } from "../src/mobile/update-check"
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

describe("电脑端内置 APK（给相对路径）", () => {
  const desktop = (over: Partial<MobileUpdateInfo> = {}): MobileUpdateInfo => ({
    ok: true,
    latestVersion: "1.4.0",
    apkPath: "/lk-harness-mobile.apk",
    // 电脑端按手机来路猜的绝对地址，只给旧版 App 用
    apkUrl: "http://guess.example:1/lk-harness-mobile.apk",
    releaseUrl: "https://github.com/x/releases/latest",
    source: "desktop",
    ...over,
  })

  it("接在手机当前连着的电脑地址后面，不用电脑端猜的绝对地址", () => {
    expect(pendingUpdate(desktop(), "1.3.0", "", "http://192.168.1.5:19529")).toEqual({
      version: "1.4.0",
      apkUrl: "http://192.168.1.5:19529/lk-harness-mobile.apk",
      // 调不起浏览器时让用户手动打开的地址，就是这个下载地址本身（发布页在国内不一定打得开）
      releaseUrl: "http://192.168.1.5:19529/lk-harness-mobile.apk",
    })
  })

  it("电脑地址末尾带斜杠、有路径前缀（反向代理）都能拼对", () => {
    expect(pendingUpdate(desktop(), "1.3.0", "", "https://lk.example.com/harness/")?.apkUrl).toBe(
      "https://lk.example.com/harness/lk-harness-mobile.apk",
    )
  })

  it("没有可用的当前地址时退回电脑端给的绝对地址；两个都没有就不提示", () => {
    expect(pendingUpdate(desktop(), "1.3.0", "")?.apkUrl).toBe("http://guess.example:1/lk-harness-mobile.apk")
    expect(pendingUpdate(desktop({ apkUrl: undefined }), "1.3.0", "")).toBeNull()
  })

  it("相对路径不是以 / 开头就不信；以 // 开头也只是接在电脑地址后面，不会跳到别的主机", () => {
    expect(resolveApkUrl(desktop({ apkPath: "evil.com/x.apk" }), "http://192.168.1.5:19529")).toBe(
      "http://guess.example:1/lk-harness-mobile.apk",
    )
    expect(resolveApkUrl(desktop({ apkPath: "//evil.com/x.apk" }), "http://192.168.1.5:19529")).toBe(
      "http://192.168.1.5:19529//evil.com/x.apk",
    )
  })

  it("版本比较和忽略规则照旧：手机不比电脑旧就不提示", () => {
    expect(pendingUpdate(desktop(), "1.4.0", "", "http://192.168.1.5:19529")).toBeNull()
    expect(pendingUpdate(desktop(), "1.5.0", "", "http://192.168.1.5:19529")).toBeNull()
    expect(pendingUpdate(desktop(), "1.3.0", "1.4.0", "http://192.168.1.5:19529")).toBeNull()
  })
})
