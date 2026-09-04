import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  initSessionThinkingStore,
  resetSessionThinkingStoreForTests,
  setSessionThinking,
  getSessionThinking,
  clearSessionThinking,
  resolveThinkingLevel,
  defaultThinkingLevel,
  THINKING_LEVELS,
} from "../src/shared/session-thinking-store.js"

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-thinking-"))
  initSessionThinkingStore(dataDir)
})

afterEach(() => {
  resetSessionThinkingStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const SESSION = "ch_a|oc_111::D:\\ws\\a"

describe("session-thinking-store", () => {
  it("缺省返回 undefined，档位列表含 off", () => {
    expect(getSessionThinking(SESSION)).toBeUndefined()
    expect(THINKING_LEVELS[0]).toBe("off")
    expect(THINKING_LEVELS).toHaveLength(7)
  })

  it("写读删按会话隔离", () => {
    setSessionThinking(SESSION, "high")
    expect(getSessionThinking(SESSION)).toBe("high")
    clearSessionThinking(SESSION)
    expect(getSessionThinking(SESSION)).toBeUndefined()
  })

  it("默认档：模型 reasoning 开才 medium", () => {
    expect(defaultThinkingLevel(true)).toBe("medium")
    expect(defaultThinkingLevel(false)).toBe("off")
    expect(defaultThinkingLevel(undefined)).toBe("off")
  })

  it("effort 取值映射保序恒带 off", async () => {
    const { mapEffortLevels } = await import("../src/shared/session-thinking-store.js")
    expect(mapEffortLevels(["high", "low", "medium"])).toEqual(["off", "low", "medium", "high"])
    expect(mapEffortLevels(["none", "low"])).toEqual(["off", "low"])
    expect(mapEffortLevels([])).toBeUndefined()
    expect(mapEffortLevels(undefined)).toBeUndefined()
    expect(mapEffortLevels(["bogus"])).toBeUndefined()
  })

  it("覆盖优先于模型默认", () => {
    expect(resolveThinkingLevel(SESSION, true)).toBe("medium")
    setSessionThinking(SESSION, "off")
    expect(resolveThinkingLevel(SESSION, true)).toBe("off")
    setSessionThinking(SESSION, "xhigh")
    expect(resolveThinkingLevel(SESSION, false)).toBe("xhigh")
  })
})
