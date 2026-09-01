import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

describe("卡片关闭", () => {
  it("offerDismiss 为 true 时追加关闭按钮", () => {
    const card = LarkSender.buildCard("正文", { title: "标题" }, [
      { label: "操作", value: { kind: "cmd", cmd: "/p" } },
    ], undefined, undefined, undefined, undefined, true) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("✕ 关闭")
    expect(json).toContain('"kind":"dismiss"')
  })

  it("sections 模式同样追加关闭按钮", () => {
    const card = LarkSender.buildCard("ignored", { title: "标题" }, undefined, undefined, undefined, undefined, [
      { text: "段1", buttons: [{ label: "A", value: { kind: "cmd", cmd: "/a" } }] },
      { text: "段2", buttons: [{ label: "B", value: { kind: "cmd", cmd: "/b" } }] },
    ], true) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("✕ 关闭")
  })

  it("无 Agent 菜单的普通卡片不含关闭按钮", () => {
    const card = LarkSender.buildCard("这是一段超过10字的正文内容", { title: "项目 lk-harness", subtitle: "分支 main" }) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).not.toContain("✕ 关闭")
    expect(json).not.toContain('"kind":"dismiss"')
  })

  it("buildDismissedCard 展示已关闭文案", () => {
    const card = LarkSender.buildDismissedCard() as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("菜单已关闭")
    expect(json).not.toContain("✕ 关闭")
  })

  it("无按钮时 offerDismiss 仍追加关闭", () => {
    const card = LarkSender.buildCard("无 按钮正文", { title: "仅标题", subtitle: "副标题" }, undefined, undefined, undefined, undefined, undefined, true) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("✕ 关闭")
    expect(json).toContain('"kind":"dismiss"')
  })

  it("appendDismissButton 遵守20按钮上限", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      label: `btn${i}`,
      value: { kind: "cmd", cmd: `/x ${i}` },
    }))
    const withDismiss = LarkSender.appendDismissButton(many)
    expect(withDismiss).toHaveLength(20)
    expect((withDismiss[19]?.value as { kind?: string }).kind).toBe("dismiss")
  })
})
