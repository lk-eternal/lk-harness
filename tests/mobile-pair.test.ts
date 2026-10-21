import { describe, expect, it } from "vitest"
import { parsePairInput } from "../src/mobile/api"

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
