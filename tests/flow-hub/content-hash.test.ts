import { describe, expect, it } from "vitest"
import { computeGroupContentHash, computeNodeContentHash } from "../../src/shared/flow-hub-hash.js"

describe("computeNodeContentHash", () => {
  it("same content same hash regardless of key order", () => {
    const a = computeNodeContentHash({ id: "plan", label: "??", prompt: "x" })
    const b = computeNodeContentHash({ label: "??", prompt: "x", id: "plan" })
    expect(a).toBe(b)
  })

  it("prompt change changes hash", () => {
    const a = computeNodeContentHash({ id: "plan", label: "??", prompt: "a" })
    const b = computeNodeContentHash({ id: "plan", label: "??", prompt: "b" })
    expect(a).not.toBe(b)
  })

  it("ignores empty prompt", () => {
    const a = computeNodeContentHash({ id: "plan", label: "??", prompt: "  " })
    const b = computeNodeContentHash({ id: "plan", label: "??" })
    expect(a).toBe(b)
  })
})

describe("computeGroupContentHash", () => {
  it("includes node order", () => {
    const a = computeGroupContentHash({
      name: "??",
      workspace: "worktree",
      nodes: [
        { hubId: "n1", id: "plan", label: "??" },
        { hubId: "n2", id: "build", label: "??" },
      ],
    })
    const b = computeGroupContentHash({
      name: "??",
      workspace: "worktree",
      nodes: [
        { hubId: "n2", id: "build", label: "??" },
        { hubId: "n1", id: "plan", label: "??" },
      ],
    })
    expect(a).not.toBe(b)
  })
})
