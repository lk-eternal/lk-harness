import { describe, it, expect } from "vitest"
import {
  hostnameBypassed,
  parseNoProxyEntries,
  shouldBypassProxy,
  ensureWechatBypass,
  proxyUrlFromEnv,
} from "../src/wechat/proxy.js"

const envWith = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

describe("wechat proxy", () => {
  it("后缀命中微信主域与CDN子域", () => {
    expect(hostnameBypassed("ilinkai.weixin.qq.com", ["weixin.qq.com"])).toBe(true)
    expect(hostnameBypassed("novac2c.cdn.weixin.qq.com", ["weixin.qq.com"])).toBe(true)
    expect(hostnameBypassed("open.feishu.cn", ["weixin.qq.com"])).toBe(false)
  })
  it("显式NO_PROXY严格生效", () => {
    const env = envWith({ HTTPS_PROXY: "http://127.0.0.1:1080", NO_PROXY: "localhost,127.0.0.1,feishu.cn" })
    expect(shouldBypassProxy("https://ilinkai.weixin.qq.com/ilink/bot/getupdates", env)).toBe(false)
    expect(shouldBypassProxy("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", env)).toBe(true)
  })
  it("未配NO_PROXY时内建默认直连微信", () => {
    const env = envWith({ HTTPS_PROXY: "http://127.0.0.1:1080" })
    expect(shouldBypassProxy("https://ilinkai.weixin.qq.com/ilink/bot/getupdates", env)).toBe(true)
    expect(shouldBypassProxy("https://example.com/api", env)).toBe(false)
  })
  it("无代理时一律直连", () => {
    expect(shouldBypassProxy("https://ilinkai.weixin.qq.com/x", envWith({}))).toBe(true)
    expect(proxyUrlFromEnv(envWith({}))).toBe("")
  })
  it("默认家族名单幂等补微信后缀，自定义不动", () => {
    expect(ensureWechatBypass("localhost,127.0.0.1,feishu.cn")).toBe("localhost,127.0.0.1,feishu.cn,weixin.qq.com")
    expect(ensureWechatBypass("localhost,127.0.0.1,feishu.cn,weixin.qq.com")).toBe("localhost,127.0.0.1,feishu.cn,weixin.qq.com")
    expect(ensureWechatBypass("localhost,example.com")).toBe("localhost,example.com")
  })
})
