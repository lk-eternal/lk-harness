import { describe, expect, it } from "vitest"
import { parsePairInput } from "../src/mobile/api"
import { buildPairPayload, encodePairPayload } from "../src/shared/mobile-pair"

describe("mobile pair input parser", () => {
  it("parses pairing URL with base64url ?pair= query parameter", () => {
    const payload = {
      v: 1,
      name: "LK-WORK-PC",
      pub: "https://ai.example.com/",
      lan: "http://192.168.1.50:19529/",
      token: "tok_secret_123456",
    }
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
    const url = `https://ai.example.com/?pair=${b64}`

    const parsed = parsePairInput(url)
    expect(parsed).toEqual({
      pubUrl: "https://ai.example.com",
      lanUrl: "http://192.168.1.50:19529",
      token: "tok_secret_123456",
      hostName: "LK-WORK-PC",
      preferRoute: "auto",
    })
  })

  it("parses raw JSON pairing string", () => {
    const raw = JSON.stringify({
      pub: "http://1.2.3.4:19529",
      lan: "http://10.0.0.8:19529",
      token: "abc_token",
      name: "MyPC",
    })
    const parsed = parsePairInput(raw)
    expect(parsed).toEqual({
      pubUrl: "http://1.2.3.4:19529",
      lanUrl: "http://10.0.0.8:19529",
      token: "abc_token",
      hostName: "MyPC",
      preferRoute: "auto",
    })
  })

  it("parses raw base64url payload string", () => {
    const b64 = Buffer.from(
      JSON.stringify({ pub: "https://frp.example.com", lan: "", token: "t_999" }),
      "utf8",
    ).toString("base64url")
    const parsed = parsePairInput(b64)
    expect(parsed?.token).toBe("t_999")
    expect(parsed?.pubUrl).toBe("https://frp.example.com")
  })

  it("returns null on invalid input or missing token", () => {
    expect(parsePairInput("")).toBeNull()
    expect(parsePairInput("https://example.com/no-pair")).toBeNull()
    expect(parsePairInput("not-a-valid-token")).toBeNull()
  })
})

describe("desktop pair payload round trip", () => {
  const desktopPairUrl = (name: string, publicUrl: string, lanUrls: string[]) => {
    const payload = buildPairPayload({ name, token: "tok_abc", publicUrl, lanUrls })
    return `${publicUrl || lanUrls[0]}/#pair=${encodePairPayload(payload)}`
  }

  it("keeps the public path prefix and uses the first LAN url", () => {
    const url = desktopPairUrl("PC", "https://example.com/m", ["http://192.168.1.8:19529", "http://10.0.0.2:19529"])
    expect(parsePairInput(url)).toEqual({
      pubUrl: "https://example.com/m",
      lanUrl: "http://192.168.1.8:19529",
      token: "tok_abc",
      hostName: "PC",
      preferRoute: "auto",
    })
  })

  it("leaves pubUrl empty when no public url is configured", () => {
    const parsed = parsePairInput(desktopPairUrl("PC", "", ["http://192.168.1.8:19529"]))
    expect(parsed?.pubUrl).toBe("")
    expect(parsed?.lanUrl).toBe("http://192.168.1.8:19529")
  })

  it("still understands the legacy ?pair= link", () => {
    const payload = buildPairPayload({ name: "PC", token: "tok_abc", publicUrl: "https://example.com/m", lanUrls: [] })
    const parsed = parsePairInput(`https://example.com/m/?pair=${encodePairPayload(payload)}`)
    expect(parsed?.pubUrl).toBe("https://example.com/m")
    expect(parsed?.token).toBe("tok_abc")
  })

  it("never puts the token in the query string of the generated link", () => {
    const url = new URL(desktopPairUrl("PC", "https://example.com/m", ["http://192.168.1.8:19529"]))
    expect(url.search).toBe("")
    expect(url.hash.startsWith("#pair=")).toBe(true)
  })

  it("round-trips non-ASCII host names", () => {
    const parsed = parsePairInput(desktopPairUrl("办公电脑", "https://example.com", []))
    expect(parsed?.hostName).toBe("办公电脑")
    expect(parsed?.lanUrl).toBe("")
  })
})
