import { describe, expect, it } from "vitest"
import { MOBILE_PREVIEW_ROUTE, MOBILE_PREVIEW_TOKEN_TTL_MS, mobilePreviewPath, parseMobilePreviewPath } from "../src/shared/mobile-preview"

const TOKEN = "0123456789abcdef01234567"

describe("mobilePreviewPath", () => {
  it("令牌 + 编码后的文件名", () => {
    expect(mobilePreviewPath(TOKEN, "report.docx")).toBe(`/api/mobile/pv/${TOKEN}/report.docx`)
  })

  it("中文、空格、# ? 都编码，不会截断路径", () => {
    const p = mobilePreviewPath(TOKEN, "季度 报告#1?.md")
    expect(p).toBe(`/api/mobile/pv/${TOKEN}/${encodeURIComponent("季度 报告#1?.md")}`)
    expect(p).not.toMatch(/[#? ]/)
  })

  it("生成的路径能被解析回同一个令牌，文件名可还原", () => {
    const parsed = parseMobilePreviewPath(mobilePreviewPath(TOKEN, "季度 报告.md"))
    expect(parsed?.token).toBe(TOKEN)
    expect(decodeURIComponent(parsed!.rest.slice(1))).toBe("季度 报告.md")
  })
})

describe("parseMobilePreviewPath", () => {
  it("取出令牌和令牌之下的路径，路径保持未解码", () => {
    expect(parseMobilePreviewPath(`${MOBILE_PREVIEW_ROUTE}/${TOKEN}/site/a%20b.css`)).toEqual({ token: TOKEN, rest: "/site/a%20b.css" })
  })

  it("只有令牌（没有文件名）：rest 是 /", () => {
    expect(parseMobilePreviewPath(`${MOBILE_PREVIEW_ROUTE}/${TOKEN}`)).toEqual({ token: TOKEN, rest: "/" })
    expect(parseMobilePreviewPath(`${MOBILE_PREVIEW_ROUTE}/${TOKEN}/`)).toEqual({ token: TOKEN, rest: "/" })
  })

  it("越界写法原样交给仓库（仓库负责防越界），这里不去改写", () => {
    expect(parseMobilePreviewPath(`${MOBILE_PREVIEW_ROUTE}/${TOKEN}/../../etc/passwd`)?.rest).toBe("/../../etc/passwd")
    expect(parseMobilePreviewPath(`${MOBILE_PREVIEW_ROUTE}/${TOKEN}/%2e%2e/x`)?.rest).toBe("/%2e%2e/x")
  })

  it("不是预览链接 → undefined", () => {
    expect(parseMobilePreviewPath("/api/mobile/file")).toBeUndefined()
    expect(parseMobilePreviewPath("/api/mobile/pv")).toBeUndefined()
    expect(parseMobilePreviewPath("/api/mobile/pv/")).toBeUndefined()
    expect(parseMobilePreviewPath(`/api/mobile/pvx/${TOKEN}/a`)).toBeUndefined()
    expect(parseMobilePreviewPath(`/x${MOBILE_PREVIEW_ROUTE}/${TOKEN}/a`)).toBeUndefined()
  })

  it("令牌格式不对 → undefined：太短、大写、非十六进制、带点号", () => {
    for (const bad of ["abc", "0123456789abcde", TOKEN.toUpperCase(), "zzzzzzzzzzzzzzzzzzzzzzzz", "..", `${TOKEN}.x`, TOKEN + "0".repeat(41)]) {
      expect(parseMobilePreviewPath(`${MOBILE_PREVIEW_ROUTE}/${bad}/a`), bad).toBeUndefined()
    }
  })
})

describe("有效期", () => {
  it("30 分钟", () => {
    expect(MOBILE_PREVIEW_TOKEN_TTL_MS).toBe(1_800_000)
  })
})
