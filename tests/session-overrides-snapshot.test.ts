import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  getSessionRecord,
  initSessionOverridesStore,
  patchSessionRecord,
  readOverridesSnapshot,
  resetSessionOverridesStoreForTests,
  withOverridesSnapshot,
  clearSessionRecordFields,
  deleteSessionRecord,
} from "../src/shared/session-overrides-store"
import { sessionStatePath } from "../src/shared/session-entry-paths"

/** withOverridesSnapshot：一次只读磁盘一遍，作用域内读到的是同一份；作用域内写会抛错。真实文件 + 临时目录。 */

const KEY = "ch_a|oc_1::D:\\ws\\a"
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "overrides-snap-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("withOverridesSnapshot", () => {
  it("作用域内读到的是进入时的快照：磁盘上之后的改动读不到（证明没有重复读盘）", () => {
    patchSessionRecord(KEY, { model: "m1" })
    withOverridesSnapshot(() => {
      expect(getSessionRecord(KEY)?.model).toBe("m1")
      // 绕过存储直接改磁盘文件：如果每次都重新读盘，这里会读到 m2
      const p = sessionStatePath(dataDir, KEY)
      const rec = JSON.parse(fs.readFileSync(p, "utf8"))
      fs.writeFileSync(p, JSON.stringify({ ...rec, model: "m2" }))
      expect(getSessionRecord(KEY)?.model).toBe("m1")
      expect(readOverridesSnapshot().sessions[KEY]?.model).toBe("m1")
    })
  })

  it("作用域外恢复读盘，读到最新值", () => {
    patchSessionRecord(KEY, { model: "m1" })
    withOverridesSnapshot(() => {
      const p = sessionStatePath(dataDir, KEY)
      const rec = JSON.parse(fs.readFileSync(p, "utf8"))
      fs.writeFileSync(p, JSON.stringify({ ...rec, model: "m2" }))
    })
    expect(getSessionRecord(KEY)?.model).toBe("m2")
  })

  it("返回 fn 的返回值", () => {
    expect(withOverridesSnapshot(() => 42)).toBe(42)
  })

  it("嵌套调用复用外层快照", () => {
    patchSessionRecord(KEY, { model: "m1" })
    withOverridesSnapshot(() => {
      withOverridesSnapshot(() => {
        const p = sessionStatePath(dataDir, KEY)
        const rec = JSON.parse(fs.readFileSync(p, "utf8"))
        fs.writeFileSync(p, JSON.stringify({ ...rec, model: "m2" }))
      })
      // 内层返回后外层作用域还在：仍是旧快照
      expect(getSessionRecord(KEY)?.model).toBe("m1")
    })
    expect(getSessionRecord(KEY)?.model).toBe("m2")
  })

  it("作用域内写会话记录会抛错（patch / delete / clear），不会悄悄写了读不到", () => {
    patchSessionRecord(KEY, { model: "m1", agentId: "a1" })
    withOverridesSnapshot(() => {
      expect(() => patchSessionRecord(KEY, { model: "m2" })).toThrow(/只读作用域/)
      expect(() => deleteSessionRecord(KEY)).toThrow(/只读作用域/)
      expect(() => clearSessionRecordFields(KEY, ["model"])).toThrow(/只读作用域/)
    })
    // 抛错没有造成任何写入
    expect(getSessionRecord(KEY)).toMatchObject({ model: "m1", agentId: "a1" })
  })

  it("fn 抛错时作用域也会退出（之后能正常写）", () => {
    expect(() => withOverridesSnapshot(() => { throw new Error("boom") })).toThrow("boom")
    patchSessionRecord(KEY, { model: "m3" })
    expect(getSessionRecord(KEY)?.model).toBe("m3")
  })
})
