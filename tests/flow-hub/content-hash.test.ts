import { describe, expect, it } from "vitest"
import { computeGroupContentHash, computeNodeContentHash } from "../../src/shared/flow-hub-hash.js"

describe("computeNodeContentHash", () => {
  it("same content same hash regardless of key order", () => {
    const a = computeNodeContentHash({ id: "plan", label: "规划", prompt: "x" })
    const b = computeNodeContentHash({ label: "规划", prompt: "x", id: "plan" })
    expect(a).toBe(b)
  })

  it("prompt change changes hash", () => {
    const a = computeNodeContentHash({ id: "plan", label: "规划", prompt: "a" })
    const b = computeNodeContentHash({ id: "plan", label: "规划", prompt: "b" })
    expect(a).not.toBe(b)
  })

  it("ignores empty prompt", () => {
    const a = computeNodeContentHash({ id: "plan", label: "规划", prompt: "  " })
    const b = computeNodeContentHash({ id: "plan", label: "规划" })
    expect(a).toBe(b)
  })
})

describe("computeGroupContentHash", () => {
  it("includes node order", () => {
    const a = computeGroupContentHash({
      name: "开�?,
      workspace: "worktree",
      nodes: [
        { hubId: "n1", id: "plan", label: "规划" },
        { hubId: "n2", id: "build", label: "实现" },
      ],
    })
    const b = computeGroupContentHash({
      name: "开�?,
      workspace: "worktree",
      nodes: [
        { hubId: "n2", id: "build", label: "实现" },
        { hubId: "n1", id: "plan", label: "规划" },
      ],
    })
    expect(a).not.toBe(b)
  })
})
