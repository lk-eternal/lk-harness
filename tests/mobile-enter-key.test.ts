import { describe, expect, it } from "vitest"
import { shouldSendOnEnter, type EnterKeyEvent } from "../src/mobile/enter-key"

const key = (over: Partial<EnterKeyEvent> = {}): EnterKeyEvent => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...over,
})

describe("shouldSendOnEnter：手机软键盘回车换行，实体键盘回车发送", () => {
  it("触屏设备上回车不发送（让输入框正常换行）", () => {
    expect(shouldSendOnEnter(key(), true)).toBe(false)
  })

  it("有键盘的设备上回车发送", () => {
    expect(shouldSendOnEnter(key(), false)).toBe(true)
  })

  it("有键盘的设备上 Shift+回车换行", () => {
    expect(shouldSendOnEnter(key({ shiftKey: true }), false)).toBe(false)
  })

  it("Ctrl+回车、⌘+回车在任何设备上都发送（手机外接键盘的快捷路径）", () => {
    expect(shouldSendOnEnter(key({ ctrlKey: true }), true)).toBe(true)
    expect(shouldSendOnEnter(key({ metaKey: true }), true)).toBe(true)
    expect(shouldSendOnEnter(key({ ctrlKey: true }), false)).toBe(true)
    expect(shouldSendOnEnter(key({ metaKey: true }), false)).toBe(true)
  })

  it("输入法组字时的回车是确认候选，不发送，哪怕按着 Ctrl", () => {
    expect(shouldSendOnEnter(key({ isComposing: true }), false)).toBe(false)
    expect(shouldSendOnEnter(key({ isComposing: true }), true)).toBe(false)
    expect(shouldSendOnEnter(key({ isComposing: true, ctrlKey: true }), false)).toBe(false)
  })

  it("不是回车键一律不发送", () => {
    expect(shouldSendOnEnter(key({ key: "a" }), false)).toBe(false)
    expect(shouldSendOnEnter(key({ key: "a", ctrlKey: true }), false)).toBe(false)
    expect(shouldSendOnEnter(key({ key: "Tab" }), false)).toBe(false)
  })
})
