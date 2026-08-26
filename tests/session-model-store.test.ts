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
  it("�?sessionKey 形态对�?, () => {
    expect(pendingKey(CHAT, WS)).toBe(`${CHAT}::${WS}`)
  })
})

describe("resolveModelForSession", () => {
  it("override 优先�?pending �?fallback", () => {
    setPendingOverride(pendingKey(CHAT, WS), { model: "pending-model", modelParams: "" })
    setSessionOverride(SESSION, { model: "override-model", modelParams: '{"x":1}' })
    const r = resolveModelForSession(SESSION, { model: "fallback", modelParams: "" })
    expect(r).toEqual({ model: "override-model", modelParams: '{"x":1}' })
  })

  it("�?override 时消�?pending 并落�?override", () => {
    setPendingOverride(pendingKey(CHAT, WS), { model: "p1", modelParams: "[]" })
    const r = resolveModelForSession(SESSION, { model: "fb", modelParams: "" })
    expect(r).toEqual({ model: "p1", modelParams: "[]" })
    expect(getSessionOverride(SESSION)?.model).toBe("p1")
    expect(consumePendingOverride(pendingKey(CHAT, WS))).toBeUndefined()
  })

  it("都无则用 fallback", () => {
    const r = resolveModelForSession(SESSION, { model: "auto", modelParams: "" })
    expect(r).toEqual({ model: "auto", modelParams: "" })
  })

  it("Windows �?sessionKey 大小写不同仍能命�?override", () => {
    if (process.platform !== "win32") return
    setSessionOverride(SESSION, { model: "grok-x", modelParams: "[]" })
    const alt = SESSION.replace("D:\\", "d:\\")
    expect(alt).not.toBe(SESSION)
    const r = resolveModelForSession(alt, { model: "fb", modelParams: "" })
    expect(r).toEqual({ model: "grok-x", modelParams: "[]" })
  })
})

describe("pushRecentModel / listQuickModels", () => {
  it("去重并把最新提到前面，有上�?, () => {
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
    // m9 已在收藏，不�?recent 重复出现
    expect(quick.filter((q) => q.model === "m9").length).toBe(1)
  })
})
