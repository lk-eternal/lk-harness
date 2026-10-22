import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { createFileTicketStore, isPathInside } from "../src/shared/mobile-access"

describe("isPathInside", () => {
  const root = path.resolve("tmp-root", "mobile")

  it("accepts the root itself and nested files", () => {
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, path.join(root, "index.html"))).toBe(true)
    expect(isPathInside(root, path.join(root, "assets", "a.js"))).toBe(true)
  })

  it("rejects a sibling directory that merely shares the prefix", () => {
    expect(isPathInside(root, path.resolve("tmp-root", "mobile-evil", "index.html"))).toBe(false)
  })

  it("rejects parent traversal and unrelated paths", () => {
    expect(isPathInside(root, path.join(root, "..", "secret.txt"))).toBe(false)
    expect(isPathInside(root, path.resolve("tmp-root"))).toBe(false)
  })

  it("accepts file names that start with two dots", () => {
    expect(isPathInside(root, path.join(root, "..hidden"))).toBe(true)
  })
})

describe("createFileTicketStore", () => {
  it("resolves an issued ticket to its file until it expires", () => {
    let t = 1_000
    const store = createFileTicketStore({ ttlMs: 100, now: () => t })
    const ticket = store.issue("/data/report.pdf")
    expect(ticket).toMatch(/^[0-9a-f]{32}$/)
    expect(store.resolve(ticket)).toBe("/data/report.pdf")
    t += 99
    expect(store.resolve(ticket)).toBe("/data/report.pdf")
    t += 1
    expect(store.resolve(ticket)).toBeNull()
  })

  it("rejects unknown tickets", () => {
    const store = createFileTicketStore()
    expect(store.resolve("")).toBeNull()
    expect(store.resolve("deadbeef")).toBeNull()
  })

  it("issues a different ticket every time", () => {
    const store = createFileTicketStore()
    expect(store.issue("/a")).not.toBe(store.issue("/a"))
  })

  it("evicts the oldest ticket when full", () => {
    const store = createFileTicketStore({ maxEntries: 2 })
    const first = store.issue("/1")
    const second = store.issue("/2")
    const third = store.issue("/3")
    expect(store.resolve(first)).toBeNull()
    expect(store.resolve(second)).toBe("/2")
    expect(store.resolve(third)).toBe("/3")
  })
})
