import { createHash } from "node:crypto"
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

  describe("模板说明和建项要填的信息", () => {
    const nodes = [{ hubId: "n1", id: "plan", label: "Plan" }]
    const fields = [{ label: "Name", required: true }]

    it("没写这两项时哈希和加这两项之前的算法一致，已共享的模板不受影响", () => {
      const legacy = createHash("sha256")
        .update('{"name":"Ops","nodes":[{"id":"plan","label":"Plan"}],"workspace":"worktree"}')
        .digest("hex")
      expect(computeGroupContentHash({ name: "Ops", workspace: "worktree", nodes })).toBe(legacy)
      expect(computeGroupContentHash({ name: "Ops", workspace: "worktree", description: "  ", fields: [], nodes })).toBe(legacy)
    })

    it("说明首尾空白不影响哈希，内容变了哈希才变", () => {
      const a = computeGroupContentHash({ name: "Ops", description: "x", nodes })
      expect(computeGroupContentHash({ name: "Ops", description: " x ", nodes })).toBe(a)
      expect(computeGroupContentHash({ name: "Ops", description: "y", nodes })).not.toBe(a)
      expect(computeGroupContentHash({ name: "Ops", nodes })).not.toBe(a)
    })

    it("要填的信息的每个属性和顺序都参与哈希", () => {
      const a = computeGroupContentHash({ name: "Ops", fields, nodes })
      expect(computeGroupContentHash({ name: "Ops", fields: [{ label: "Name" }], nodes })).not.toBe(a)
      expect(computeGroupContentHash({ name: "Ops", fields: [{ label: "Name", required: true, multiline: true }], nodes })).not.toBe(a)
      expect(computeGroupContentHash({ name: "Ops", fields: [{ label: "Name", required: true, placeholder: "p" }], nodes })).not.toBe(a)
      const two = [{ label: "A" }, { label: "B" }]
      expect(computeGroupContentHash({ name: "Ops", fields: two, nodes }))
        .not.toBe(computeGroupContentHash({ name: "Ops", fields: [...two].reverse(), nodes }))
    })
  })
})
