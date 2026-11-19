import { describe, expect, it } from "vitest"
import {
  buildGroupEnvelope,
  buildNodeEnvelope,
  envelopeToGroupDef,
  groupDefToBody,
  parseGroupEnvelope,
  parseNodeEnvelope,
} from "../../src/shared/flow-hub-envelope.js"

describe("flow-hub envelope", () => {
  it("roundtrips group envelope", () => {
    const env = buildGroupEnvelope({
      hubId: "g-test-uuid",
      hubRevision: 2,
      author: "??",
      group: {
        id: "develop",
        name: "??",
        workspace: "worktree",
        nodes: [{ hubId: "n1", id: "plan", label: "??", prompt: "???" }],
      },
    })
    const parsed = parseGroupEnvelope(env)
    expect(parsed?.hubId).toBe("g-test-uuid")
    expect(parsed?.group.nodes[0].prompt).toBe("???")
    expect(parsed?.contentHash).toBe(env.contentHash)
  })

  it("roundtrips node envelope", () => {
    const env = buildNodeEnvelope({
      hubId: "n-test",
      hubRevision: 1,
      author: "??",
      node: { hubId: "n-test", id: "mr", label: "MR", prompt: "?MR" },
    })
    const parsed = parseNodeEnvelope(env)
    expect(parsed?.node.label).toBe("MR")
    expect(parsed?.contentHash).toBe(env.contentHash)
  })

  it("parses legacy v1 group export", () => {
    const parsed = parseGroupEnvelope({
      kind: "lk-harness-node-group",
      version: 1,
      group: { id: "qa", name: "??", nodes: [{ id: "check", label: "??" }] },
    })
    expect(parsed?.group.name).toBe("??")
    expect(parsed?.hubId).toBeTruthy()
  })

  it("envelopeToGroupDef preserves hub tracking", () => {
    const env = buildGroupEnvelope({
      hubId: "g1",
      hubRevision: 3,
      author: "??",
      group: { id: "test", name: "???", nodes: [{ hubId: "n1", id: "a", label: "A" }] },
    })
    const def = envelopeToGroupDef(env)
    expect(def.hubId).toBe("g1")
    expect(def.hubRevision).toBe(3)
    expect(def.nodes[0].hubContentHash).toBeTruthy()
  })

  describe("模板说明和建项要填的信息", () => {
    const fields = [
      { label: "活动名称", placeholder: "例如：双十一", required: true },
      { label: "背景", multiline: true },
    ]

    function shared(extra: { description?: string; fields?: unknown } = {}) {
      return buildGroupEnvelope({
        hubId: "g-info",
        hubRevision: 1,
        author: "A",
        group: groupDefToBody({
          id: "ops",
          name: "运营",
          nodes: [{ id: "recap", label: "复盘" }],
          ...extra,
        } as Parameters<typeof groupDefToBody>[0]),
      })
    }

    it("上传、下载、导入后都带着，内容原样还原", () => {
      const env = shared({ description: "  做活动复盘  ", fields })
      const parsed = parseGroupEnvelope(JSON.parse(JSON.stringify(env)))
      expect(parsed?.group.description).toBe("做活动复盘")
      expect(parsed?.group.fields).toEqual(fields)
      const def = envelopeToGroupDef(parsed!)
      expect(def.description).toBe("做活动复盘")
      expect(def.fields).toEqual(fields)
    })

    it("导入得到的是副本，改它不会改到共享内容里的那份", () => {
      const parsed = parseGroupEnvelope(shared({ fields }))!
      const def = envelopeToGroupDef(parsed)
      def.fields![0].label = "改过"
      expect(parsed.group.fields![0].label).toBe("活动名称")
    })

    it("没写这两项时共享内容里没有这两个键", () => {
      const env = shared()
      expect(Object.keys(env.group)).not.toContain("description")
      expect(Object.keys(env.group)).not.toContain("fields")
      const def = envelopeToGroupDef(parseGroupEnvelope(JSON.parse(JSON.stringify(env)))!)
      expect(def).not.toHaveProperty("description")
      expect(def).not.toHaveProperty("fields")
    })

    it("只改说明或只改要填的信息，上传的哈希都会变", () => {
      const base = shared({ description: "a", fields }).contentHash
      expect(shared({ description: "b", fields }).contentHash).not.toBe(base)
      expect(shared({ description: "a", fields: fields.slice(0, 1) }).contentHash).not.toBe(base)
      expect(shared({ fields }).contentHash).not.toBe(base)
    })

    it("读共享文件时清洗：丢掉没名字和重名的项，说明不是文字就当没有", () => {
      const parsed = parseGroupEnvelope({
        kind: "lk-harness-node-group",
        version: 2,
        group: {
          id: "ops",
          name: "运营",
          description: 5,
          fields: [{ label: " 活动名称 " }, { label: "" }, { label: "活动名称" }, { placeholder: "x" }],
          nodes: [{ id: "recap", label: "复盘" }],
        },
      })
      expect(parsed?.group.description).toBeUndefined()
      expect(parsed?.group.fields).toEqual([{ label: "活动名称" }])
    })

    it("旧格式的单组导出文件带着这两项时也保留", () => {
      const parsed = parseGroupEnvelope({
        id: "ops",
        name: "运营",
        description: "做活动复盘",
        fields,
        nodes: [{ id: "recap", label: "复盘" }],
      })
      expect(parsed?.group.description).toBe("做活动复盘")
      expect(parsed?.group.fields).toEqual(fields)
    })
  })
})
