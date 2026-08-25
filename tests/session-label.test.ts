import { describe, expect, it } from "vitest"
import { sessionColorKey, sessionHeaderTemplate } from "../src/shared/session-label.js"

describe("session color stability", () => {
  it("same chat with/without channel prefix maps to one color", () => {
    const a = sessionColorKey("ch_c9fc9ff4|oc_abc::D:\\workspace\\lk-harness")
    const b = sessionColorKey("oc_abc::D:\\workspace\\lk-harness")
    expect(a).toBe(b)
  })

  it("path escaping and casing differences map to one color", () => {
    const a = sessionColorKey("oc_abc::D:\\\\Workspace\\\\Cursor-Claw")
    const b = sessionColorKey("oc_abc::d:\\workspace\\lk-harness")
    expect(a).toBe(b)
  })

  it("project sessions keyed by project id only", () => {
    const a = sessionColorKey("ch_x|oc_abc::project_deadbeef1234")
    const b = sessionColorKey("oc_other::project_deadbeef1234")
    expect(a).toBe(b)
    expect(a).toBe("project:deadbeef1234")
  })

  it("template is deterministic", () => {
    const k = "ch_c9fc9ff4|oc_abc::D:\\workspace\\lk-harness"
    expect(sessionHeaderTemplate(k)).toBe(sessionHeaderTemplate(k))
    expect(sessionHeaderTemplate(k)).toBeTruthy()
  })
})
