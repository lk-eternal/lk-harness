import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  getSessionRecord,
  initSessionOverridesStore,
  patchSessionRecord,
  resetSessionOverridesStoreForTests,
} from "../src/shared/session-overrides-store"
import { sessionStatePath } from "../src/shared/session-entry-paths"

/**
 * skillsHash：这个账本里 AI 已经拿到的 Skill 名单的指纹，跟着会话状态落盘。
 * 它决定重启后 Resume 时要不要再发名单，所以得跟其他续聊字段一样可靠地存、取、清。
 */
const KEY = "ch_a|oc_1::D:\\ws\\a"
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hash-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("session 记录里的 skillsHash", () => {
  it("写进去能读出来", () => {
    patchSessionRecord(KEY, { skillsHash: "abc123def456" })
    expect(getSessionRecord(KEY)?.skillsHash).toBe("abc123def456")
  })

  it("记录里只有它一个字段也要保留（不能被当成「空记录」删掉）", () => {
    patchSessionRecord(KEY, { skillsHash: "only-me" })
    expect(fs.existsSync(sessionStatePath(dataDir, KEY))).toBe(true)
    expect(getSessionRecord(KEY)?.skillsHash).toBe("only-me")
  })

  it("改别的字段（模型、续聊信息）不会丢它", () => {
    patchSessionRecord(KEY, { skillsHash: "keep-me" })
    patchSessionRecord(KEY, { model: "m1", rulesHash: "r1" })
    expect(getSessionRecord(KEY)).toMatchObject({ skillsHash: "keep-me", model: "m1", rulesHash: "r1" })
  })

  it("更新：后写的覆盖先写的", () => {
    patchSessionRecord(KEY, { skillsHash: "v1" })
    patchSessionRecord(KEY, { skillsHash: "v2" })
    expect(getSessionRecord(KEY)?.skillsHash).toBe("v2")
  })

  it("置为 undefined 就清掉（会话重新开账本、没有名单要记时，不留旧指纹）", () => {
    patchSessionRecord(KEY, { skillsHash: "stale", model: "m1" })
    patchSessionRecord(KEY, { skillsHash: undefined })
    const rec = getSessionRecord(KEY)
    expect(rec?.skillsHash).toBeUndefined()
    expect(rec?.model).toBe("m1")
  })

  it("它是记录里唯一的内容时被清掉，记录随之删除（和其他字段一致）", () => {
    patchSessionRecord(KEY, { skillsHash: "stale" })
    patchSessionRecord(KEY, { skillsHash: undefined })
    expect(getSessionRecord(KEY)).toBeUndefined()
  })
})
