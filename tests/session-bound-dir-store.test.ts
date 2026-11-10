import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  clearSessionRecordFields,
  getSessionRecord,
  initSessionOverridesStore,
  patchSessionRecord,
  resetSessionOverridesStoreForTests,
} from "../src/shared/session-overrides-store"
import { sessionStatePath } from "../src/shared/session-entry-paths"

/** 会话选的工作目录（boundDir）落盘：只有它一个字段的记录也是有效记录，不会被当成「空记录」删掉 */

const KEY = "ch_a|oc_1::C:\\AppData\\workspaces\\temp_1790070973658"
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-dir-store-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("session record 的 boundDir", () => {
  it("只有 boundDir 的记录也会落盘、读得回来", () => {
    patchSessionRecord(KEY, { boundDir: "D:\\work\\proj" })
    expect(fs.existsSync(sessionStatePath(dataDir, KEY))).toBe(true)
    expect(getSessionRecord(KEY)?.boundDir).toBe("D:\\work\\proj")
  })

  it("和模型等其它字段互不影响：改模型不丢目录，改目录不丢模型", () => {
    patchSessionRecord(KEY, { boundDir: "D:\\work\\proj" })
    patchSessionRecord(KEY, { model: "m1" })
    expect(getSessionRecord(KEY)).toMatchObject({ boundDir: "D:\\work\\proj", model: "m1" })
    patchSessionRecord(KEY, { boundDir: "D:\\work\\other" })
    expect(getSessionRecord(KEY)).toMatchObject({ boundDir: "D:\\work\\other", model: "m1" })
  })

  it("清掉 boundDir 后记录空了就删文件", () => {
    patchSessionRecord(KEY, { boundDir: "D:\\work\\proj" })
    clearSessionRecordFields(KEY, ["boundDir"])
    expect(getSessionRecord(KEY)).toBeUndefined()
    expect(fs.existsSync(sessionStatePath(dataDir, KEY))).toBe(false)
  })
})
