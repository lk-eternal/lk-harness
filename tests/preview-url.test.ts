import { describe, expect, it } from "vitest"
import { hostLabel, isHttpUrl, normalizeAddressInput } from "../src/shared/preview-url"

const ok = (url: string) => ({ ok: true, url })

describe("isHttpUrl", () => {
  it("只认带主机的 http(s)", () => {
    expect(isHttpUrl("http://a.com")).toBe(true)
    expect(isHttpUrl("HTTPS://a.com/x?y#z")).toBe(true)
    for (const v of ["ftp://a.com", "file:///etc/passwd", "javascript:alert(1)", "http://", "https:///x", "a.com", "", undefined, null]) {
      expect(isHttpUrl(v), String(v)).toBe(false)
    }
  })
})

describe("normalizeAddressInput", () => {
  it("带 http(s):// 的原样用（去掉首尾空白）", () => {
    expect(normalizeAddressInput("  https://example.com/a?b=1#c ")).toEqual(ok("https://example.com/a?b=1#c"))
    expect(normalizeAddressInput("http://example.com")).toEqual(ok("http://example.com"))
  })

  it("域名没写协议：补 https", () => {
    expect(normalizeAddressInput("example.com")).toEqual(ok("https://example.com"))
    expect(normalizeAddressInput("docs.example.com/guide?a=1")).toEqual(ok("https://docs.example.com/guide?a=1"))
    expect(normalizeAddressInput("example.com:8443/x")).toEqual(ok("https://example.com:8443/x"))
  })

  it("本机和内网地址没写协议：补 http", () => {
    expect(normalizeAddressInput("localhost:3000")).toEqual(ok("http://localhost:3000"))
    expect(normalizeAddressInput("localhost")).toEqual(ok("http://localhost"))
    expect(normalizeAddressInput("127.0.0.1:8080/api")).toEqual(ok("http://127.0.0.1:8080/api"))
    expect(normalizeAddressInput("192.168.1.5")).toEqual(ok("http://192.168.1.5"))
    expect(normalizeAddressInput("nas.local/files")).toEqual(ok("http://nas.local/files"))
    expect(normalizeAddressInput("[::1]:3000")).toEqual(ok("http://[::1]:3000"))
  })

  it("不是 http(s) 的协议一律拒绝：内置浏览器只开网页", () => {
    for (const v of [
      "file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
      "ftp://a.com", "chrome://settings", "lkfile://abc/x", "about:blank", "vbscript:x", "mailto:a@b.com",
    ]) {
      const r = normalizeAddressInput(v)
      expect(r.ok, v).toBe(false)
    }
  })

  it("不像网址的输入拒绝，不替用户猜成搜索", () => {
    expect(normalizeAddressInput("hello").ok).toBe(false)
    expect(normalizeAddressInput("how to cook").ok).toBe(false)
    expect(normalizeAddressInput("").ok).toBe(false)
    expect(normalizeAddressInput("   ").ok).toBe(false)
    expect(normalizeAddressInput("//evil.com").ok).toBe(false)
  })

  it("中间有空格的拒绝（避免把半句话当网址）", () => {
    expect(normalizeAddressInput("example.com foo").ok).toBe(false)
  })

  it("返回的错误信息是给用户看的字符串", () => {
    const r = normalizeAddressInput("javascript:alert(1)")
    expect(r).toEqual({ ok: false, error: "只支持打开 http / https 网址" })
  })
})

describe("hostLabel", () => {
  it("取主机名并去掉 www.", () => {
    expect(hostLabel("https://www.example.com/a/b")).toBe("example.com")
    expect(hostLabel("http://localhost:3000/x")).toBe("localhost")
  })
  it("解析不了就原样返回", () => {
    expect(hostLabel("not a url")).toBe("not a url")
  })
})
