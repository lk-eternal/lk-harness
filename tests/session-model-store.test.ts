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
  recordModelUse,
  seedNewSessionModel,
  getRecentModels,
  listQuickModels,
  modelEntryKey,
  type ModelEntry,
} from "../src/shared/session-model-store.js"
import { sessionStateDir } from "../src/shared/data-paths.js"
import {
  STATE_FILE,
  globalLastModelsPath,
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

describe("新会话默认模型 = 通道里我上一次用的模型", () => {
  const CH = "ch_app1"
  const MAIN_CHAT = `${CH}|app_main`
  const used = `${MAIN_CHAT}::D:\\ws\\temp_100`
  const fresh = `${MAIN_CHAT}::D:\\ws\\temp_200`

  /** 通道默认模型：没有任何使用记录时新会话落到它 */
  const channelDefault = { model: "auto", modelParams: "", resourceId: "sdk1" }

  it("用上模型（Agent 启动或手动换模）：同时记入最近使用和该通道上次用的模型，落在 _global 下", () => {
    recordModelUse(used, { model: "claude-x", modelParams: "[]", resourceId: "sdk1" })
    expect(getRecentModels()[0]).toMatchObject({ model: "claude-x", resourceId: "sdk1" })
    const file = JSON.parse(fs.readFileSync(globalLastModelsPath(dataDir), "utf8")) as Record<string, { model: string }>
    expect(file[CH]?.model).toBe("claude-x")
  })

  it("新会话拿到上次用的模型，并且界面显示（override）和 Agent 启动（resolve）读到同一个", () => {
    recordModelUse(used, { model: "claude-x", modelParams: "[1]", resourceId: "sdk1" })

    const seeded = seedNewSessionModel(fresh, CH, "sdk1")
    expect(seeded).toEqual({ model: "claude-x", modelParams: "[1]", resourceId: "sdk1" })

    // 界面：会话树 / 草稿会话读的是 getSessionOverride
    expect(getSessionOverride(fresh)).toEqual({ model: "claude-x", modelParams: "[1]", resourceId: "sdk1" })
    // 启动：launchAgent 用 resolveModelForSession，供应商取启动时实际生效的那个
    expect(resolveModelForSession(fresh, channelDefault)).toEqual({ model: "claude-x", modelParams: "[1]", resourceId: "sdk1" })
  })

  it("之后又用了别的模型：下一个新会话跟着变，已经建好的会话不变", () => {
    recordModelUse(used, { model: "m-old", modelParams: "", resourceId: "sdk1" })
    const first = `${MAIN_CHAT}::D:\\ws\\temp_201`
    seedNewSessionModel(first, CH, "sdk1")

    recordModelUse(used, { model: "m-new", modelParams: "", resourceId: "sdk1" })
    const second = `${MAIN_CHAT}::D:\\ws\\temp_202`
    seedNewSessionModel(second, CH, "sdk1")

    expect(getSessionOverride(first)?.model).toBe("m-old")
    expect(getSessionOverride(second)?.model).toBe("m-new")
  })

  it("已有的会话不受影响：没有自己模型的老会话仍用通道默认，不会因为别处用了新模型而被改", () => {
    const oldSession = `${MAIN_CHAT}::D:\\ws\\proj`
    recordModelUse(used, { model: "claude-x", modelParams: "", resourceId: "sdk1" })
    expect(resolveModelForSession(oldSession, channelDefault).model).toBe("auto")
    expect(getSessionOverride(oldSession)).toBeUndefined()
  })

  it("通道从没用过任何模型：不写覆盖，新会话用通道默认", () => {
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
    expect(getSessionOverride(fresh)).toBeUndefined()
    expect(resolveModelForSession(fresh, channelDefault).model).toBe("auto")
  })

  it("上次用的模型属于别的供应商（之后换过供应商）：不写，退回通道默认；写了也不会在启动时生效", () => {
    recordModelUse(used, { model: "llm-model", modelParams: "", resourceId: "llm_old" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
    expect(getSessionOverride(fresh)).toBeUndefined()
    expect(resolveModelForSession(fresh, channelDefault).model).toBe("auto")
  })

  it("上次的记录没有供应商（老数据）：无法确认归属，不写", () => {
    recordModelUse(used, { model: "legacy", modelParams: "" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
  })

  it("会话已经有自己的模型：不覆盖", () => {
    recordModelUse(used, { model: "claude-x", modelParams: "", resourceId: "sdk1" })
    setSessionOverride(fresh, { model: "picked", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
    expect(getSessionOverride(fresh)?.model).toBe("picked")
  })

  it("拿不到启动时的供应商（空）：不写", () => {
    recordModelUse(used, { model: "claude-x", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "  ")).toBeUndefined()
  })

  it("通道之间互不影响", () => {
    recordModelUse(`ch_other|app_main::D:\\ws\\x`, { model: "other-model", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
  })

  it("只有「我自己」的会话算：其他人、定时任务、裸会话用的模型不决定我的新会话", () => {
    // 飞书里其他人的会话
    recordModelUse(`${CH}|oc_someone::D:\\ws\\o`, { model: "others-model", modelParams: "", resourceId: "sdk1" })
    // 没有通道前缀的裸 task / temp 会话
    recordModelUse("task_abc123", { model: "task-model", modelParams: "", resourceId: "sdk1" })
    recordModelUse("temp_999", { model: "temp-model", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()

    // 但它们依然进「最近使用」列表（模型选择器里的行为不变）
    expect(getRecentModels().map((r) => r.model)).toEqual(expect.arrayContaining(["others-model", "task-model", "temp-model"]))
  })

  it("应用通道的项目会话也是「我自己」在用，计入", () => {
    recordModelUse(`${MAIN_CHAT}::project_p1`, { model: "proj-model", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")?.model).toBe("proj-model")
  })

  it("记录文件损坏：当作没有记录，不抛错", () => {
    recordModelUse(used, { model: "claude-x", modelParams: "", resourceId: "sdk1" })
    fs.writeFileSync(globalLastModelsPath(dataDir), "{ not json", "utf8")
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
    // 之后正常记录还能把它写好
    recordModelUse(used, { model: "again", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")?.model).toBe("again")
  })

  it("空模型名不记录", () => {
    recordModelUse(used, { model: "  ", modelParams: "", resourceId: "sdk1" })
    expect(seedNewSessionModel(fresh, CH, "sdk1")).toBeUndefined()
  })
})
