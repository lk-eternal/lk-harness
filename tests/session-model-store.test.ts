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
  clearSessionOverride,
  resolveModelForSession,
  pushRecentModel,
  listQuickModels,
  modelEntryKey,
  type ModelEntry,
} from "../src/shared/session-model-store.js"
import { sessionStateDir } from "../src/shared/data-paths.js"
import {
  STATE_FILE,
  globalRecentPath,
  sessionEntryDir,
} from "../src/shared/session-entry-paths.js"

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
  it("与 sessionKey 同形", () => {
    expect(pendingKey(CHAT, WS)).toBe(`${CHAT}::${WS}`)
  })
})

describe("resolveModelForSession", () => {
  it("override 优先于 fallback", () => {
    setSessionOverride(SESSION, { model: "override-model", modelParams: '{"x":1}' })
    const r = resolveModelForSession(SESSION, { model: "fallback", modelParams: "" })
    expect(r).toEqual({ model: "override-model", modelParams: '{"x":1}' })
  })

  it("无 override 时用 fallback", () => {
    const r = resolveModelForSession(SESSION, { model: "auto", modelParams: "" })
    expect(r).toEqual({ model: "auto", modelParams: "" })
  })

  it("Windows 下 sessionKey 大小写不同仍能读到 override", () => {
    if (process.platform !== "win32") return
    setSessionOverride(SESSION, { model: "grok-x", modelParams: "[]" })
    const alt = SESSION.replace("D:\\", "d:\\")
    expect(alt).not.toBe(SESSION)
    const r = resolveModelForSession(alt, { model: "fb", modelParams: "" })
    expect(r).toEqual({ model: "grok-x", modelParams: "[]" })
  })
})

describe("会话 state.json + global recent", () => {
  it("模型写入 state.json，recent 写入 _global/recent.json", () => {
    setSessionOverride(SESSION, { model: "m1", modelParams: "" })
    pushRecentModel({ model: "m2", modelParams: "" })
    const state = JSON.parse(
      fs.readFileSync(path.join(sessionEntryDir(dataDir, SESSION), STATE_FILE), "utf8"),
    ) as { model?: string }
    const recent = JSON.parse(fs.readFileSync(globalRecentPath(dataDir), "utf8")) as { model: string }[]
    expect(state.model).toBe("m1")
    expect(recent[0]?.model).toBe("m2")
  })
})

describe("pushRecentModel / listQuickModels", () => {
  it("最近列表去重且条数封顶", () => {
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

describe("resourceId（供应商+模型整体）", () => {
  it("同模型不同供应商是两条", () => {
    pushRecentModel({ model: "m", modelParams: "", resourceId: "r1" })
    pushRecentModel({ model: "m", modelParams: "", resourceId: "r2" })
    const quick = listQuickModels([], 6)
    expect(quick.filter((q) => q.model === "m").length).toBe(2)
  })

  it("有绑定条目时未绑定老条目不再补位", () => {
    pushRecentModel({ model: "m", modelParams: "" })
    pushRecentModel({ model: "m", modelParams: "", resourceId: "r1" })
    const quick = listQuickModels([{ model: "m", modelParams: "" }], 6)
    expect(quick.filter((q) => q.model === "m" && !(q as { resourceId?: string }).resourceId).length).toBe(0)
    expect(quick.some((q) => (q as { resourceId?: string }).resourceId === "r1")).toBe(true)
  })

  it("override 不带供应商时保留旧绑定", () => {
    setSessionOverride(SESSION, { model: "m", modelParams: "", resourceId: "r1" })
    setSessionOverride(SESSION, { model: "m", modelParams: "" })
    expect(getSessionOverride(SESSION)?.resourceId).toBe("r1")
  })

  it("新会话回退父chat覆盖：群里/m后项目会话直接生效", () => {
    const chat = "ch_a|oc_111"
    const project = `${chat}::project_p1`
    setSessionOverride(chat, { model: "spark", modelParams: "", resourceId: "r9" })
    expect(getSessionOverride(project, "r9")?.model).toBe("spark")
    expect(getSessionOverride(project, "r9")?.resourceId).toBe("r9")
    expect(resolveModelForSession(project, { model: "gemini", modelParams: "", resourceId: "r9" }).model).toBe("spark")
  })

  it("override 供应商与当前 resource 不一致时不生效", () => {
    setSessionOverride(SESSION, { model: "muse-spark-1.3-contributor", modelParams: "", resourceId: "llm_old" })
    const r = resolveModelForSession(SESSION, { model: "composer-2.5", modelParams: "", resourceId: "sdk_cur" })
    expect(r).toEqual({ model: "composer-2.5", modelParams: "", resourceId: "sdk_cur" })
  })

  it("无 resourceId 绑定的 override 在已知 resource 下不生效", () => {
    setSessionOverride(SESSION, { model: "legacy-m", modelParams: "" })
    const r = resolveModelForSession(SESSION, { model: "composer-2.5", modelParams: "", resourceId: "sdk_cur" })
    expect(r.model).toBe("composer-2.5")
  })

  it("会话级覆盖优先于父chat，清掉后回落", () => {
    const chat = "ch_a|oc_111"
    const project = `${chat}::project_p1`
    setSessionOverride(chat, { model: "spark", modelParams: "" })
    setSessionOverride(project, { model: "gemini", modelParams: "" })
    expect(getSessionOverride(project)?.model).toBe("gemini")
    clearSessionOverride(project)
    expect(getSessionOverride(project)?.model).toBe("spark")
  })
})
