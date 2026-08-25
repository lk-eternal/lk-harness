import { describe, expect, it } from "vitest"
import {
  buildGroupEnvelope,
  buildNodeEnvelope,
  envelopeToGroupDef,
  parseGroupEnvelope,
  parseNodeEnvelope,
} from "../../src/shared/flow-hub-envelope.js"

describe("flow-hub envelope", () => {
  it("roundtrips group envelope", () => {
    const env = buildGroupEnvelope({
      hubId: "g-test-uuid",
      hubRevision: 2,
      author: "张三",
      group: {
        id: "develop",
        name: "开发",
        workspace: "worktree",
        nodes: [{ hubId: "n1", id: "plan", label: "规划", prompt: "做规划" }],
      },
    })
    const parsed = parseGroupEnvelope(env)
    expect(parsed?.hubId).toBe("g-test-uuid")
    expect(parsed?.group.nodes[0].prompt).toBe("做规划")
    expect(parsed?.contentHash).toBe(env.contentHash)
  })

  it("roundtrips node envelope", () => {
    const env = buildNodeEnvelope({
      hubId: "n-test",
      hubRevision: 1,
      author: "李四",
      node: { hubId: "n-test", id: "mr", label: "MR", prompt: "建 MR" },
    })
    const parsed = parseNodeEnvelope(env)
    expect(parsed?.node.label).toBe("MR")
    expect(parsed?.contentHash).toBe(env.contentHash)
  })

  it("parses legacy v1 group export", () => {
    const parsed = parseGroupEnvelope({
      kind: "lk-harness-node-group",
      version: 1,
      group: { id: "qa", name: "质检", nodes: [{ id: "check", label: "检查" }] },
    })
    expect(parsed?.group.name).toBe("质检")
    expect(parsed?.hubId).toBeTruthy()
  })

  it("envelopeToGroupDef preserves hub tracking", () => {
    const env = buildGroupEnvelope({
      hubId: "g1",
      hubRevision: 3,
      author: "王五",
      group: { id: "test", name: "测试组", nodes: [{ hubId: "n1", id: "a", label: "A" }] },
    })
    const def = envelopeToGroupDef(env)
    expect(def.hubId).toBe("g1")
    expect(def.hubRevision).toBe(3)
    expect(def.nodes[0].hubContentHash).toBeTruthy()
  })
})
