import { describe, expect, it } from "vitest"
import {
  emptyCatalog,
  filterCatalog,
  mergeGroupIntoCatalog,
  mergeNodeIntoCatalog,
  parseCatalog,
} from "../../src/shared/flow-hub-catalog.js"

describe("flow-hub catalog", () => {
  it("upserts group entry", () => {
    const cat = emptyCatalog()
    const entry = {
      hubId: "g1",
      name: "开�?,
      nodeLabels: ["规划"],
      nodeIds: ["plan"],
      author: "张三",
      updatedAt: "2026-08-03",
      contentHash: "abc",
    }
    const next = mergeGroupIntoCatalog(cat, entry)
    expect(next.groups).toHaveLength(1)
    expect(mergeGroupIntoCatalog(next, { ...entry, name: "开�?" }).groups[0].name).toBe("开�?")
  })

  it("filters by author and name", () => {
    const cat = mergeGroupIntoCatalog(emptyCatalog(), {
      hubId: "g1",
      name: "开�?,
      nodeLabels: [],
      nodeIds: [],
      author: "张三",
      updatedAt: "",
      contentHash: "",
    })
    expect(filterCatalog(cat, "张三").groups).toHaveLength(1)
    expect(filterCatalog(cat, "不存�?).groups).toHaveLength(0)
  })

  it("parses valid catalog", () => {
    const raw = { version: 1, updatedAt: "t", groups: [], nodes: [] }
    expect(parseCatalog(raw)?.version).toBe(1)
    expect(parseCatalog({ version: 2 })).toBeNull()
  })

  it("upserts node entry", () => {
    const cat = mergeNodeIntoCatalog(emptyCatalog(), {
      hubId: "n1",
      label: "提缺�?,
      localId: "file-bug",
      author: "张三",
      updatedAt: "",
      contentHash: "h",
    })
    expect(cat.nodes).toHaveLength(1)
  })
})
