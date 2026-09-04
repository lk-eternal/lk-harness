import { describe, it, expect } from "vitest"
import { selectModelVariants } from "../src/shared/model-utils.js"

const options = [
  { id: "gemini-3.8-flash", params: "", label: "gemini-3.8-flash" },
  { id: "gemini-3.8-flash", params: `[{"id":"reasoning_effort","value":"high"}]`, label: "gemini-3.8-flash-high" },
  { id: "composer-2.5", params: "", label: "composer-2.5" },
]

describe("selectModelVariants", () => {
  it("只返回同 id 的 variants 且保序", () => {
    const got = selectModelVariants(options, "gemini-3.8-flash")
    expect(got.map((o) => o.label)).toEqual(["gemini-3.8-flash", "gemini-3.8-flash-high"])
  })

  it("空 id 返回空", () => {
    expect(selectModelVariants(options, "")).toEqual([])
    expect(selectModelVariants(options, undefined)).toEqual([])
  })

  it("无匹配返回空", () => {
    expect(selectModelVariants(options, "nope")).toEqual([])
  })
})
