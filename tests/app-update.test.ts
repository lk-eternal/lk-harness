import { describe, expect, it } from "vitest"
import { compareVersions, isNewerVersion, parseVersion } from "../src/shared/app-update"

describe("parseVersion", () => {
  it("解析常见写法", () => {
    expect(parseVersion("1.2.3")).toEqual({ nums: [1, 2, 3], pre: null })
    expect(parseVersion("v1.2.3")).toEqual({ nums: [1, 2, 3], pre: null })
    expect(parseVersion(" 1.2.3 ")).toEqual({ nums: [1, 2, 3], pre: null })
    expect(parseVersion("1.2.3-beta.1")).toEqual({ nums: [1, 2, 3], pre: "beta.1" })
    expect(parseVersion("1.2.3+build5")).toEqual({ nums: [1, 2, 3], pre: null })
  })

  it("缺的段按 0 补", () => {
    expect(parseVersion("1.2")).toEqual({ nums: [1, 2, 0], pre: null })
    expect(parseVersion("3")).toEqual({ nums: [3, 0, 0], pre: null })
  })

  it("不是版本号的返回 null", () => {
    for (const bad of ["", "abc", "1.2.3.4", "1..2", "latest", "v", "1.2.x"]) {
      expect(parseVersion(bad), bad).toBeNull()
    }
  })
})

describe("compareVersions", () => {
  it("按数字而不是字符串比较", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0)
    expect(compareVersions("1.1.10", "1.1.9")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0)
    expect(compareVersions("1.1.2", "1.1.3")).toBeLessThan(0)
  })

  it("相同返回 0，缺段与补 0 等价", () => {
    expect(compareVersions("1.1.2", "1.1.2")).toBe(0)
    expect(compareVersions("1.1", "1.1.0")).toBe(0)
    expect(compareVersions("v1.1.2", "1.1.2")).toBe(0)
  })

  it("同号时正式版新于预发布版", () => {
    expect(compareVersions("1.2.0", "1.2.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBeLessThan(0)
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.2.0-beta.1", "1.2.0-beta.1")).toBe(0)
    // 数字段不同时，预发布标记不起作用
    expect(compareVersions("1.3.0-beta.1", "1.2.9")).toBeGreaterThan(0)
  })

  it("任一边不合法返回 null", () => {
    expect(compareVersions("abc", "1.0.0")).toBeNull()
    expect(compareVersions("1.0.0", "")).toBeNull()
  })
})

describe("isNewerVersion", () => {
  it("只有严格更新才为真", () => {
    expect(isNewerVersion("1.1.3", "1.1.2")).toBe(true)
    expect(isNewerVersion("1.1.2", "1.1.2")).toBe(false)
    expect(isNewerVersion("1.1.1", "1.1.2")).toBe(false)
  })

  it("发布了正式版时，当前是同号预发布版也算有更新", () => {
    expect(isNewerVersion("1.2.0", "1.2.0-beta.1")).toBe(true)
  })

  it("版本号不合法时不提示", () => {
    expect(isNewerVersion("", "1.1.2")).toBe(false)
    expect(isNewerVersion("1.1.3", "")).toBe(false)
    expect(isNewerVersion("1.1.3", "dev")).toBe(false)
  })
})
