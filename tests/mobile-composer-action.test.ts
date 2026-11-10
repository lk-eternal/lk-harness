import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { composerAction } from "../src/mobile/composer-action"
import QueuedStrip from "../src/renderer/components/chat/QueuedStrip"
import type { AppChatUserItem } from "../src/shared/app-chat-types"

describe("手机端输入栏按钮：发送 / 停止", () => {
  it("空闲时一直是发送（有没有内容只影响能不能点）", () => {
    expect(composerAction(false, false)).toBe("send")
    expect(composerAction(false, true)).toBe("send")
  })

  it("Agent 干活、输入框空着：停止", () => {
    expect(composerAction(true, false)).toBe("stop")
  })

  it("Agent 干活、已经写了内容：发送（消息排队），不再被停止按钮顶掉", () => {
    expect(composerAction(true, true)).toBe("send")
  })
})

const queued = (id: string, text: string, images?: string[]): AppChatUserItem => ({
  kind: "user", id, ts: 1, text, queued: true, ...(images ? { images } : {}),
})

function render(items: AppChatUserItem[], touch?: boolean): string {
  return renderToStaticMarkup(createElement(QueuedStrip, {
    items,
    onEdit: vi.fn(async () => true),
    onRemove: vi.fn(async () => undefined),
    onSendNow: vi.fn(async () => "soft" as const),
    ...(touch !== undefined ? { touch } : {}),
  }))
}

describe("暂存区（手机端复用电脑端组件）", () => {
  it("没有排队的消息时什么都不渲染", () => {
    expect(render([], true)).toBe("")
  })

  it("排队的消息列在暂存区里，带条数、编辑、删除和立即发送", () => {
    const html = render([queued("a", "先查日志"), queued("b", "再看监控")], true)
    expect(html).toContain("排队中 · 2 条")
    expect(html).toContain("先查日志")
    expect(html).toContain("再看监控")
    expect(html).toContain("立即发送")
    expect((html.match(/title="编辑"/g) ?? []).length).toBe(2)
    expect((html.match(/title="删除"/g) ?? []).length).toBe(2)
  })

  it("手机端按钮的点按区域放大，电脑端保持原样", () => {
    // 按完整的类名匹配：gap-2、px-2 里也带着 "p-2"
    const hasClass = (html: string, cls: string) => new RegExp(`class="[^"]*(?<![\\w-])${cls.replace(/[.]/g, "\\.")}(?![\\w-])`).test(html)
    const touch = render([queued("a", "x")], true)
    const desktop = render([queued("a", "x")])
    expect(hasClass(touch, "p-2")).toBe(true)
    expect(hasClass(touch, "p-1")).toBe(false)
    expect(touch).toContain("px-3 py-1.5 text-accent")
    expect(hasClass(desktop, "p-1")).toBe(true)
    expect(hasClass(desktop, "p-2")).toBe(false)
    expect(desktop).toContain("px-2 py-0.5 text-accent")
  })
})
