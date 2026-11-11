import { describe, expect, it } from "vitest"
import { openFirstStep } from "../src/renderer/components/panel-default"

describe("openFirstStep：设置页面板第一次读到列表时要不要打开第一项", () => {
  it("列表还没读回来：等着，哪怕此刻列表是空的也不能当成「没有项」", () => {
    expect(openFirstStep({ ready: false, count: 0, occupied: false })).toBe("wait")
    expect(openFirstStep({ ready: false, count: 3, occupied: false })).toBe("wait")
  })

  it("读回来了、有项、右边还空着：打开第一项", () => {
    expect(openFirstStep({ ready: true, count: 1, occupied: false })).toBe("open")
    expect(openFirstStep({ ready: true, count: 5, occupied: false })).toBe("open")
  })

  it("读回来了但列表是空的：不打开，这次机会也用掉（之后长出新项不再自动选）", () => {
    expect(openFirstStep({ ready: true, count: 0, occupied: false })).toBe("skip")
  })

  it("右边已经有东西（选了别的、或正在新建）：不去顶掉它", () => {
    expect(openFirstStep({ ready: true, count: 3, occupied: true })).toBe("skip")
  })
})
