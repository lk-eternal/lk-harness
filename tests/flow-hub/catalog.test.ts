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
      name: "??",
      nodeLabels: ["??"],
      nodeIds: ["plan"],
      author: "??",
      updatedAt: "2026-08-03",
      contentHash: "abc",
    }
    const next = mergeGroupIntoCatalog(cat, entry)
    expect(next.groups).toHaveLength(1)
    expect(mergeGroupIntoCatalog(next, { ...entry, name: "??" }).groups[0].name).toBe("??")
  })

  it("filters by author and name", () => {
    const cat = mergeGroupIntoCatalog(emptyCatalog(), {
      hubId: "g1",
      name: "??",
      nodeLabels: [],
      nodeIds: [],
      author: "??",
      updatedAt: "",
      contentHash: "",
    })
    expect(filterCatalog(cat, "??").groups).toHaveLength(1)
    expect(filterCatalog(cat, "???").groups).toHaveLength(0)
  })

  it("parses valid catalog", () => {
    const raw = { version: 1, updatedAt: "t", groups: [], nodes: [] }
    expect(parseCatalog(raw)?.version).toBe(1)
    expect(parseCatalog({ version: 2 })).toBeNull()
  })

  it("upserts node entry", () => {
    const cat = mergeNodeIntoCatalog(emptyCatalog(), {
      hubId: "n1",
      label: "???",
      localId: "file-bug",
      author: "??",
      updatedAt: "",
      contentHash: "h",
    })
    expect(cat.nodes).toHaveLength(1)
  })
})
