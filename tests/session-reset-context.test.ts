import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const h = vi.hoisted(() => ({ userData: "", resetCalls: [] as string[] }))

vi.mock("electron", () => ({ app: { getPath: () => h.userData } }))
vi.mock("../electron/agent-engine/factory", () => ({
  getAgentEngine: () => { throw new Error("unused") },
  getAllAgentEngines: () => [{ resetSessionContext: (k: string) => { h.resetCalls.push(k) } }],
  agentEngineKind: () => "llm",
}))

import { resetAllSessionContext } from "../electron/agent-engine/control"
import {
  appendMirrorTurns,
  initCarryoverStore,
  peekCarryover,
  readMirrorTurns,
  resetCarryoverStoreForTests,
  stashCarryover,
} from "../electron/carryover"
import { sessionEntryDir } from "../src/shared/session-entry-paths"

describe("resetAllSessionContext", () => {
  beforeEach(() => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "claw-reset-"))
    h.resetCalls = []
    initCarryoverStore(h.userData)
  })
  afterEach(() => {
    resetCarryoverStoreForTests()
    fs.rmSync(h.userData, { recursive: true, force: true })
  })

  it("引擎、镜像、待搬运块都清掉：/reset 后新会话不再带上切供应商搬来的旧历史", () => {
    appendMirrorTurns("sk", [{ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" }])
    stashCarryover("sk", {
      turns: 2,
      fromLabel: "A",
      toLabel: "B",
      history: [{ role: "user", text: "旧问题" }, { role: "assistant", text: "旧回答" }],
    })

    resetAllSessionContext("sk")

    expect(h.resetCalls).toEqual(["sk"])
    expect(readMirrorTurns("sk")).toEqual([])
    expect(peekCarryover("sk")).toBeUndefined()
  })

  it("只清本会话，别的会话的待搬运块不受影响", () => {
    stashCarryover("sk", { turns: 1, fromLabel: "A", toLabel: "B", history: [{ role: "user", text: "a" }] })
    stashCarryover("other", { turns: 1, fromLabel: "A", toLabel: "B", history: [{ role: "user", text: "b" }] })

    resetAllSessionContext("sk")

    expect(peekCarryover("other")?.turns).toBe(1)
  })

  it("会话目录已被删掉时：不会把目录建回来", () => {
    const key = "ch_a|oc_gone::D:\\ws\\a"
    resetAllSessionContext(key)
    expect(fs.existsSync(sessionEntryDir(h.userData, key))).toBe(false)
  })
})
