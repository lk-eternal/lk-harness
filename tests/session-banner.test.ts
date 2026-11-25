import { describe, expect, it } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

/**
 * 飞书会话横幅：灰字一行加细线，没有底色。send 消息卡和流式卡共用同一个构造函数。
 */

type El = { tag: string; content?: string }
const grey = (s: string) => `<font color='grey'>${s}</font>`

describe("buildSessionBannerElements", () => {
  it("目录加分支放得下：一行，标题加粗，后面跟一条细线", () => {
    expect(LarkSender.buildSessionBannerElements({ title: "📂 lk-harness", subtitle: "🌿 main" })).toEqual([
      { tag: "markdown", element_id: "session_bar", content: grey("**📂 lk-harness** · 🌿 main"), text_size: "notation" },
      { tag: "hr" },
    ])
  })

  it("标题加副标题太宽：分两行，每行各自灰字", () => {
    const els = LarkSender.buildSessionBannerElements({ title: "📦 一个相当长的项目名称在这里", subtitle: "🌿 feature/very-long-branch-name" })
    expect(els[0].content).toBe(`${grey("**📦 一个相当长的项目名称在这里**")}\n${grey("🌿 feature/very-long-branch-name")}`)
  })

  it("没有分支：只有标题一行", () => {
    expect(LarkSender.buildSessionBannerElements("⏰ 周报编写")[0].content).toBe(grey("**⏰ 周报编写**"))
  })
})

describe("横幅在卡片里的位置", () => {
  it("send 消息卡：横幅和细线在最前面，不带底色样式，也不再多插一条分隔线", () => {
    const card = LarkSender.buildCard("问题？", { title: "📂 lk-harness", subtitle: "🌿 main" }, [
      { label: "是", value: { kind: "x" } },
    ]) as { config: Record<string, unknown>; body: { elements: El[] } }
    const els = card.body.elements
    expect(els[0]).toMatchObject({ tag: "markdown", content: grey("**📂 lk-harness** · 🌿 main") })
    expect(els[1]).toEqual({ tag: "hr" })
    expect(els[2]).toMatchObject({ tag: "markdown", content: "问题？" })
    expect(els.filter((e) => e.tag === "hr")).toHaveLength(1)
    expect(card.config.style).toBeUndefined()
    expect(JSON.stringify(card)).not.toContain("background_style")
  })

  it("send 消息卡：没有标题就没有横幅", () => {
    const card = LarkSender.buildCard("正文") as { body: { elements: El[] } }
    expect(card.body.elements.map((e) => e.tag)).toEqual(["markdown"])
  })

  it("流式卡：横幅和细线是第一批元素，不带底色样式", () => {
    const card = LarkSender.buildStreamingCardJson({
      status: "streaming",
      sessionTitle: { title: "📦 订单中心", subtitle: "🌿 feature/refund" },
      segments: [{ type: "reply", text: "你好" }],
    }) as { config: Record<string, unknown>; body: { elements: El[] } }
    expect(card.body.elements[0]).toMatchObject({ tag: "markdown", content: grey("**📦 订单中心** · 🌿 feature/refund") })
    expect(card.body.elements[1]).toEqual({ tag: "hr" })
    expect(card.config.style).toBeUndefined()
    expect(JSON.stringify(card)).not.toContain("background_style")
  })
})
