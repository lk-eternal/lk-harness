import { describe, expect, it } from "vitest"
import { disambiguatePathLabel, pathLastSegment } from "../src/shared/path-label"

describe("pathLastSegment", () => {
  it("returns last path segment", () => {
    expect(pathLastSegment("D:\\a\\cp-scheduling")).toBe("cp-scheduling")
    expect(pathLastSegment("D:/a/b/cp-scheduling")).toBe("cp-scheduling")
  })
})

describe("disambiguatePathLabel", () => {
  it("keeps short name when unique", () => {
    const peers = ["D:\\ws\\lk-harness", "D:\\ws\\other"]
    expect(disambiguatePathLabel(peers[0], peers)).toBe("lk-harness")
  })

  it("appends parent when last segment collides", () => {
    const a = "D:\\proj\\cp-scheduling-workspace\\cp-scheduling"
    const b = "D:\\proj\\cp-scheduling-bugfix\\cp-scheduling"
    expect(disambiguatePathLabel(a, [a, b])).toBe("cp-scheduling·cp-scheduling-workspace")
    expect(disambiguatePathLabel(b, [a, b])).toBe("cp-scheduling·cp-scheduling-bugfix")
  })

  it("does not treat self as collision", () => {
    const a = "D:\\proj\\cp-scheduling"
    expect(disambiguatePathLabel(a, [a])).toBe("cp-scheduling")
  })
})
