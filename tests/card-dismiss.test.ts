import { describe, it, expect } from "vitest"
import { LarkSender } from "../src/shared/lark-core.js"

describe("指令卡关闭", () => {
  it("有按钮的指令卡（offerDismiss）自动追加关闭按钮", () => {
    const card = LarkSender.buildCard("正文", { title: "测试" }, [
      { label: "操作", value: { kind: "cmd", cmd: "/p" } },
    ], undefined, undefined, undefined, undefined, true) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("✕ 关闭")
    expect(json).toContain('"kind":"dismiss"')
  })

  it("sections 指令卡在最后一段追加关闭", () => {
    const card = LarkSender.buildCard("ignored", { title: "状态" }, undefined, undefined, undefined, undefined, [
      { text: "段1", buttons: [{ label: "A", value: { kind: "cmd", cmd: "/a" } }] },
      { text: "段2", buttons: [{ label: "B", value: { kind: "cmd", cmd: "/b" } }] },
    ], true) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("✕ 关闭")
  })

  it("普通 Agent 回复卡（默认）不追加关闭按钮", () => {
    const card = LarkSender.buildCard("拼音小班课有效课节不足20节查询…", { title: "📂 lk-harness", subtitle: "🌿 main" }) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).not.toContain("✕ 关闭")
    expect(json).not.toContain('"kind":"dismiss"')
  })

  it("已关闭卡片不再追加按钮", () => {
    const card = LarkSender.buildDismissedCard() as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("菜单已关闭")
    expect(json).not.toContain("✕ 关闭")
  })

  it("无按钮的指令卡（offerDismiss）也有关闭按钮", () => {
    const card = LarkSender.buildCard("⏰ 定时任务一览", { title: "定时任务", subtitle: "列表" }, undefined, undefined, undefined, undefined, undefined, true) as { body: { elements: unknown[] } }
    const json = JSON.stringify(card)
    expect(json).toContain("✕ 关闭")
    expect(json).toContain('"kind":"dismiss"')
  })

  it("超过预算时保留关闭按钮", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      label: `btn${i}`,
      value: { kind: "cmd", cmd: `/x ${i}` },
    }))
    const withDismiss = LarkSender.appendDismissButton(many)
    expect(withDismiss).toHaveLength(20)
    expect((withDismiss[19]?.value as { kind?: string }).kind).toBe("dismiss")
  })
})
