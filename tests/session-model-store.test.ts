import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  initSessionModelStore,
  resetSessionModelStoreForTests,
  pendingKey,
  setSessionOverride,
  getSessionOverride,
  setPendingOverride,
  consumePendingOverride,
  resolveModelForSession,
  pushRecentModel,
  listQuickModels,
  modelEntryKey,
  type ModelEntry,
} from "../src/shared/session-model-store.js"

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-model-"))
  initSessionModelStore(dataDir)
})

afterEach(() => {
  resetSessionModelStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const SESSION = "ch_a|oc_111::D:\\ws\\a"
const CHAT = "ch_a|oc_111"
const WS = "D:\\ws\\a"

describe("pendingKey", () => {
  it("? sessionKey ????", () => {
    expect(pendingKey(CHAT, WS)).toBe(`${CHAT}::${WS}`)
  })
})

describe("resolveModelForSession", () => {
  it("override ??? pending ? fallback", () => {
    setPendingOverride(pendingKey(CHAT, WS), { model: "pending-model", modelParams: "" })
    setSessionOverride(SESSION, { model: "override-model", modelParams: '{"x":1}' })
    const r = resolveModelForSession(SESSION, { model: "fallback", modelParams: "" })
    expect(r).toEqual({ model: "override-model", modelParams: '{"x":1}' })
  })

  it("? override ??? pending ??? override", () => {
    setPendingOverride(pendingKey(CHAT, WS), { model: "p1", modelParams: "[]" })
    const r = resolveModelForSession(SESSION, { model: "fb", modelParams: "" })
    expect(r).toEqual({ model: "p1", modelParams: "[]" })
    expect(getSessionOverride(SESSION)?.model).toBe("p1")
    expect(consumePendingOverride(pendingKey(CHAT, WS))).toBeUndefined()
  })

  it("???? fallback", () => {
    const r = resolveModelForSession(SESSION, { model: "auto", modelParams: "" })
    expect(r).toEqual({ model: "auto", modelParams: "" })
  })

  it("Windows ? sessionKey ????????? override", () => {
    if (process.platform !== "win32") return
    setSessionOverride(SESSION, { model: "grok-x", modelParams: "[]" })
    const alt = SESSION.replace("D:\\", "d:\\")
    expect(alt).not.toBe(SESSION)
    const r = resolveModelForSession(alt, { model: "fb", modelParams: "" })
    expect(r).toEqual({ model: "grok-x", modelParams: "[]" })
  })
})

describe("pushRecentModel / listQuickModels", () => {
  it("??????????????", () => {
    for (let i = 0; i < 10; i++) {
      pushRecentModel({ model: `m${i}`, modelParams: "" }, 8)
    }
    pushRecentModel({ model: "m3", modelParams: "" }, 8)
    const favorites: ModelEntry[] = [
      { model: "fav-a", modelParams: "" },
      { model: "m9", modelParams: "" },
    ]
    const quick = listQuickModels(favorites, 6)
    expect(quick[0].model).toBe("fav-a")
    expect(quick.map((q) => modelEntryKey(q))).toContain(modelEntryKey({ model: "m9", modelParams: "" }))
    expect(quick.length).toBeLessThanOrEqual(6)
    expect(quick.filter((q) => q.model === "m9").length).toBe(1)
  })
})
