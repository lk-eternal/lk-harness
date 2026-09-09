import { describe, it, expect } from "vitest"
import { isSessionDirBindingValid } from "../src/daemon.js"

describe("路由目录绑定校验（防窜台）", () => {
  it("裸 chat 与特殊后缀永远放行", () => {
    expect(isSessionDirBindingValid("ch_a|oc_1", "/x/y")).toBe(true)
    expect(isSessionDirBindingValid("ch_a|oc_1::project_abc", "")).toBe(true)
    expect(isSessionDirBindingValid("ch_a|oc_1::wf_123", "")).toBe(true)
    expect(isSessionDirBindingValid("ch_a|oc_1::temp_x", "")).toBe(true)
  })

  it("后缀目录等于本通道目录放行", () => {
    expect(isSessionDirBindingValid("ch_a|oc_1::/data/a", "/data/a")).toBe(true)
  })

  it("后缀目录是别的通道目录拒绝", () => {
    expect(isSessionDirBindingValid("ch_b|oc_2::/data/a", "/data/b")).toBe(false)
    expect(isSessionDirBindingValid("ch_b|oc_2::/data/a", "")).toBe(false)
  })

  it("非路径垃圾后缀放行（由别处纠正，不在此拒绝）", () => {
    expect(isSessionDirBindingValid("ch_a|oc_1::label", "/data/a")).toBe(true)
  })
})
