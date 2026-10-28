import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fsCjs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  DEFAULT_CLEANUP_DAYS,
  classifySessionKind,
  listManagedSessions,
  manageBlockedReason,
  normalizeCleanupDays,
  planCleanup,
  previewFromMirror,
  readRoutingSnapshot,
  restoreModelDefault,
  type ManagedSession,
  type ManagedSessionsEnv,
  type ManagerChannel,
} from "../src/shared/managed-sessions"
import { ensureSessionEntry, globalRoutingPath, sessionStatePath } from "../src/shared/session-entry-paths"
import {
  getSessionRecord,
  initSessionOverridesStore,
  patchSessionRecord,
  resetSessionOverridesStoreForTests,
  type SessionOverrideRecord,
} from "../src/shared/session-overrides-store"
import { setSessionOverride } from "../src/shared/session-model-store"
import { setSessionResourceOverride } from "../src/shared/session-resource-store"
import { resolveLaunchModel } from "../src/shared/launch-model"

/**
 * 会话管理页后端：清单怎么整理、恢复默认怎么清、批量清理选谁。
 * 用真实文件系统 + 临时目录 + 真实会话存储，不 mock；运行态（谁在跑、排队几条）由测试直接传入。
 */

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const MAIN = "ch_a|ou_main::D:\\ws\\a"
const GUEST_P2P = "ch_a|ou_guest::D:\\ws\\a"
const GROUP = "ch_a|oc_group1::D:\\ws\\a"
const GROUP_DIR2 = "ch_a|oc_group1::D:\\ws\\b"
const PROJECT = "ch_a|oc_group2::project_p1"
const TASK = "task-1"
const TEMP = "temp_abcd1234"

const KNOWN: Record<string, string> = { sdk_main: "主供应商", llm_others: "其他人供应商", llm_other2: "备用供应商" }
const resolveResource = (id: string | undefined) => {
  const rid = id && KNOWN[id] ? id : "sdk_main"
  return { id: rid, name: KNOWN[rid] }
}

const CH_A: ManagerChannel = {
  id: "ch_a",
  name: "飞书服务台",
  type: "feishu",
  enabled: true,
  agentResourceId: "sdk_main",
  othersAgentResourceId: "llm_others",
  model: "composer-2",
  modelParams: "[]",
  othersModel: "gemini-flash",
  othersModelParams: "",
  mainUserEnabled: true,
  mainUserChatId: "ou_main",
}
const CH_APP: ManagerChannel = { ...CH_A, id: "ch_app", name: "应用内", type: "app", mainUserChatId: "app_main" }

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-sessions-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** 建一个会话目录；mirror = 逐回合镜像的行 + 修改时间，stateMtime = 状态文件修改时间 */
function addSession(
  key: string,
  opts: {
    mirror?: { lines: object[]; mtime: number }
    state?: Partial<SessionOverrideRecord>
    stateMtime?: number
  } = {},
): string {
  const dir = ensureSessionEntry(dataDir, key)
  if (opts.mirror) {
    const f = path.join(dir, "mirror.jsonl")
    fs.writeFileSync(f, opts.mirror.lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    fs.utimesSync(f, new Date(opts.mirror.mtime), new Date(opts.mirror.mtime))
  }
  if (opts.state) patchSessionRecord(key, opts.state)
  if (opts.stateMtime !== undefined) {
    const p = sessionStatePath(dataDir, key)
    fs.utimesSync(p, new Date(opts.stateMtime), new Date(opts.stateMtime))
  }
  return dir
}

function writeRouting(routing: { chatType?: Record<string, string>; sessionToChat?: Record<string, string> }): void {
  const p = globalRoutingPath(dataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(routing))
}

const ROUTING = {
  chatType: { "ch_a|ou_main": "p2p", "ch_a|ou_guest": "p2p", "ch_a|oc_group1": "group", "ch_a|oc_group2": "group" },
}

function env(over: Partial<ManagedSessionsEnv> = {}): ManagedSessionsEnv {
  return {
    userDataDir: dataDir,
    now: NOW,
    channels: [CH_A, CH_APP],
    resolveResource,
    runningKeys: [],
    queuedByKey: new Map(),
    routing: ROUTING,
    taskIds: new Set([TASK]),
    chatName: () => undefined,
    ...over,
  }
}

function listed(over: Partial<ManagedSessionsEnv> = {}): ManagedSession[] {
  return listManagedSessions(env(over)).sessions
}
const byKey = (list: ManagedSession[], key: string): ManagedSession => {
  const hit = list.find((s) => s.sessionKey === key)
  if (!hit) throw new Error(`清单里没有 ${key}`)
  return hit
}

const mirrorAt = (mtime: number, texts: string[] = ["你好"]) => ({
  mtime,
  lines: texts.flatMap((t) => [{ role: "user", text: t, at: mtime }, { role: "assistant", text: `答：${t}`, at: mtime }]),
})

describe("classifySessionKind / manageBlockedReason", () => {
  it("任务 > 项目 > 临时 > 带目录 > 只有聊天键", () => {
    expect(classifySessionKind("task-1", true)).toBe("task")
    expect(classifySessionKind(PROJECT, false)).toBe("project")
    expect(classifySessionKind(TEMP, false)).toBe("temp")
    expect(classifySessionKind(GROUP, false)).toBe("workspace")
    expect(classifySessionKind("ch_a|oc_group1", false)).toBe("chat")
  })

  it("只有其他人的普通会话可管；主用户的 / 项目 / 任务 / 临时各有说法", () => {
    expect(manageBlockedReason("workspace", "others")).toBeUndefined()
    expect(manageBlockedReason("chat", "others")).toBeUndefined()
    expect(manageBlockedReason("workspace", "main")).toMatch(/主用户/)
    expect(manageBlockedReason("project", "others")).toMatch(/项目/)
    expect(manageBlockedReason("task", "others")).toMatch(/定时任务/)
    expect(manageBlockedReason("temp", "others")).toMatch(/临时/)
  })
})

describe("listManagedSessions：整理磁盘上存着的会话", () => {
  it("别人的群 / 私聊、主用户的会话分清人群，类型取自路由表", () => {
    addSession(MAIN)
    addSession(GUEST_P2P)
    addSession(GROUP)
    const list = listed()
    expect(byKey(list, MAIN)).toMatchObject({ audience: "main", chatType: "p2p", manageable: false, kind: "workspace", channelId: "ch_a", channelName: "飞书服务台" })
    expect(byKey(list, GUEST_P2P)).toMatchObject({ audience: "others", chatType: "p2p", manageable: true, chatKey: "ch_a|ou_guest" })
    expect(byKey(list, GROUP)).toMatchObject({ audience: "others", chatType: "group", manageable: true, workspaceDir: "D:\\ws\\a" })
  })

  it("主用户在群里说话：群会话仍按其他人（群聊用其他人模型）", () => {
    // 路由表里这个聊天是群，即便聊天 id 恰好是主用户绑定的 id
    const key = "ch_a|ou_main2::D:\\ws\\a"
    addSession(key)
    const list = listed({
      channels: [{ ...CH_A, mainUserChatId: "ou_main2" }],
      routing: { chatType: { "ch_a|ou_main2": "group" } },
    })
    expect(byKey(list, key)).toMatchObject({ audience: "others", chatType: "group" })
  })

  it("路由表里没有这个聊天的类型：类型未知，人群只按聊天 id 是否等于主用户绑定的判", () => {
    addSession(MAIN)
    addSession(GUEST_P2P)
    const list = listed({ routing: {} })
    expect(byKey(list, MAIN)).toMatchObject({ chatType: "unknown", audience: "main" })
    expect(byKey(list, GUEST_P2P)).toMatchObject({ chatType: "unknown", audience: "others" })
  })

  it("定时任务把结果发到群里：会话绑的聊天是群，仍归主用户（系统会话），不能因为聊天是群就当成别人的", () => {
    addSession(TASK, { state: { chatId: "ch_a|oc_group1" } })
    expect(byKey(listed(), TASK)).toMatchObject({ kind: "task", audience: "main", chatType: "group", manageable: false })
  })

  it("项目 / 定时任务 / 临时会话：归主用户，不可管，各自给出原因", () => {
    addSession(PROJECT)
    addSession(TASK, { state: { chatId: "ch_a|ou_main" } })
    addSession(TEMP, { state: { chatId: "ch_a|ou_main" } })
    const list = listed()
    expect(byKey(list, PROJECT)).toMatchObject({ kind: "project", audience: "main", manageable: false })
    expect(byKey(list, TASK)).toMatchObject({ kind: "task", audience: "main", manageable: false, channelId: "ch_a", chatKey: "ch_a|ou_main" })
    expect(byKey(list, TEMP)).toMatchObject({ kind: "temp", audience: "main", manageable: false, channelId: "ch_a" })
    for (const k of [PROJECT, TASK, TEMP]) expect(byKey(list, k).blockedReason).toBeTruthy()
  })

  it("路由表登记过但磁盘上没有目录的会话（/c 能看到的）也列出，没有活动时间", () => {
    addSession(GROUP)
    const list = listed({ routing: { ...ROUTING, sessionToChat: { [GUEST_P2P]: "ch_a|ou_guest" } } })
    expect(byKey(list, GUEST_P2P)).toMatchObject({ lastActiveAt: undefined, manageable: true })
    // 没有活动时间的排在最后
    expect(list.map((s) => s.sessionKey)).toEqual([GROUP, GUEST_P2P])
  })

  it("路由表里键没规范化（双反斜杠）也和磁盘上的会话合并成一条", () => {
    addSession(GROUP)
    const list = listed({ routing: { ...ROUTING, sessionToChat: { "ch_a|oc_group1::D:\\\\ws\\\\a": "ch_a|oc_group1" } } })
    expect(list.filter((s) => s.sessionKey === GROUP)).toHaveLength(1)
    expect(list).toHaveLength(1)
  })

  it("所属通道解析不出的（通道已删 / 老格式）不列，只计数；应用内对话通道的不列也不计数", () => {
    addSession(GROUP)
    addSession("ch_gone|oc_x::D:\\ws\\a")
    addSession("legacy-no-prefix")
    addSession("ch_app|app_main::D:\\ws\\a")
    const { sessions, skipped } = listManagedSessions(env())
    expect(sessions.map((s) => s.sessionKey)).toEqual([GROUP])
    expect(skipped).toBe(2)
  })

  it("没有 session-key.txt 的目录忽略", () => {
    addSession(GROUP)
    fs.mkdirSync(path.join(dataDir, "sessions", "deadbeefdeadbeef"), { recursive: true })
    expect(listed()).toHaveLength(1)
  })

  it("运行中 / 排队数按规范化后的键对上", () => {
    addSession(GROUP)
    addSession(GUEST_P2P)
    const list = listed({
      runningKeys: ["ch_a|oc_group1::D:\\\\ws\\\\a"],
      queuedByKey: new Map([[GUEST_P2P, 3]]),
    })
    expect(byKey(list, GROUP)).toMatchObject({ running: true, queued: 0 })
    expect(byKey(list, GUEST_P2P)).toMatchObject({ running: false, queued: 3 })
  })

  it("名字：查得到用查到的，查不到按群 / 私聊 + 尾号（id 很长只取最后 6 位）", () => {
    const longGroup = "ch_a|oc_0123456789abcdef::D:\\ws\\a"
    addSession(GROUP)
    addSession(GUEST_P2P)
    addSession(longGroup)
    const list = listed({
      routing: { chatType: { ...ROUTING.chatType, "ch_a|oc_0123456789abcdef": "group" } },
      chatName: (k) => (k === GROUP ? "客服一群" : undefined),
    })
    expect(byKey(list, GROUP).name).toBe("客服一群")
    expect(byKey(list, GUEST_P2P).name).toBe("私聊 ou_guest")
    expect(byKey(list, longGroup).name).toBe("群 abcdef")
  })

  it("按最近活动倒序（会话多、时间乱序，不靠目录名巧合排对）", () => {
    // 年龄（天）故意打乱：目录名是键的哈希，目录顺序和时间顺序没有关系
    const ages = [9, 2, 14, 5, 1, 30, 7, 3]
    const keys = ages.map((_, i) => `ch_a|oc_s${i}::D:\\ws\\a`)
    ages.forEach((age, i) => addSession(keys[i], { mirror: mirrorAt(NOW - age * DAY) }))
    const expected = keys
      .map((k, i) => ({ k, age: ages[i] }))
      .sort((a, b) => a.age - b.age)
      .map((x) => x.k)
    expect(listed().map((s) => s.sessionKey)).toEqual(expected)
  })

  it("同样没有活动时间的按键名排，顺序稳定", () => {
    addSession(GUEST_P2P)
    addSession(GROUP)
    addSession(GROUP_DIR2)
    const sorted = [GUEST_P2P, GROUP, GROUP_DIR2].sort((a, b) => a.localeCompare(b))
    // 没有镜像、没有状态文件：活动时间取目录自己的修改时间，把它们统一成同一时间再比
    const t = new Date(NOW - DAY)
    for (const k of [GUEST_P2P, GROUP, GROUP_DIR2]) {
      const dir = path.dirname(sessionStatePath(dataDir, k))
      fs.utimesSync(dir, t, t)
    }
    expect(listed().map((s) => s.sessionKey)).toEqual(sorted)
  })
})

describe("listManagedSessions：最近活动时间与预览", () => {
  it("活动时间取逐回合镜像的修改时间，而不是会话状态文件（改模型 / 续聊元数据会刷新状态文件）", () => {
    addSession(GROUP, { mirror: mirrorAt(NOW - 10 * DAY), state: { agentId: "a1" }, stateMtime: NOW - 1 * DAY })
    expect(byKey(listed(), GROUP).lastActiveAt).toBe(NOW - 10 * DAY)
  })

  it("没有镜像时退回状态文件的修改时间", () => {
    addSession(GROUP, { state: { agentId: "a1" }, stateMtime: NOW - 5 * DAY })
    expect(byKey(listed(), GROUP).lastActiveAt).toBe(NOW - 5 * DAY)
  })

  it("别人的私聊带预览：最后一条用户消息，压成一行并截断到 60 字", () => {
    const long = "我想问一下" + "很长的问题".repeat(30)
    addSession(GUEST_P2P, { mirror: mirrorAt(NOW - DAY, ["第一句\n换行", long]) })
    const s = byKey(listed(), GUEST_P2P)
    expect(s.preview?.endsWith("…")).toBe(true)
    expect(s.preview?.startsWith("我想问一下很长的问题")).toBe(true)
    expect(s.preview!.length).toBe(61)
  })

  it("群会话和主用户的会话不读预览", () => {
    addSession(GROUP, { mirror: mirrorAt(NOW - DAY) })
    addSession(MAIN, { mirror: mirrorAt(NOW - DAY) })
    const list = listed()
    expect(byKey(list, GROUP).preview).toBeUndefined()
    expect(byKey(list, MAIN).preview).toBeUndefined()
  })

  it("没有镜像：没有预览", () => {
    addSession(GUEST_P2P)
    expect(byKey(listed(), GUEST_P2P).preview).toBeUndefined()
  })
})

describe("previewFromMirror", () => {
  it("取最后一条用户消息，跳过助手轮和坏行", () => {
    const raw = [
      JSON.stringify({ role: "user", text: "旧的" }),
      JSON.stringify({ role: "user", text: "最新的用户消息" }),
      JSON.stringify({ role: "assistant", text: "助手回复" }),
      "{坏行",
      "",
    ].join("\n")
    expect(previewFromMirror(raw)).toBe("最新的用户消息")
  })

  it("换行和连续空白压成一个空格", () => {
    expect(previewFromMirror(JSON.stringify({ role: "user", text: "  第一行\n\n第二行\t\t  第三行  " }))).toBe("第一行 第二行 第三行")
  })

  it("没有用户消息 / 空白消息返回空", () => {
    expect(previewFromMirror("")).toBeUndefined()
    expect(previewFromMirror(JSON.stringify({ role: "assistant", text: "x" }))).toBeUndefined()
    expect(previewFromMirror(JSON.stringify({ role: "user", text: "  \n " }))).toBeUndefined()
  })

  it("恰好等于上限不加省略号，超一个字才截断", () => {
    const exact = "字".repeat(60)
    expect(previewFromMirror(JSON.stringify({ role: "user", text: exact }))).toBe(exact)
    expect(previewFromMirror(JSON.stringify({ role: "user", text: exact + "多" }))).toBe(exact + "…")
  })
})

describe("listManagedSessions：有效模型（和真实拉起同一个函数）", () => {
  it("别人的会话没有任何设置：其他人供应商 + 其他人模型，不算自己改过", () => {
    addSession(GROUP)
    expect(byKey(listed(), GROUP)).toMatchObject({
      model: "gemini-flash",
      resourceId: "llm_others",
      resourceName: "其他人供应商",
      modelSource: "channel",
      resourceSource: "channel",
      customized: false,
      canRestoreDefault: false,
      defaultModel: "gemini-flash",
    })
  })

  it("主用户的会话取主模型和主供应商，defaultModel 也是主模型", () => {
    addSession(MAIN)
    expect(byKey(listed(), MAIN)).toMatchObject({ model: "composer-2", resourceId: "sdk_main", defaultModel: "composer-2" })
  })

  it("只改了模型：来源是会话、可恢复默认、算自己改过", () => {
    addSession(GROUP)
    setSessionOverride(GROUP, { model: "gpt-x", modelParams: "[1]", resourceId: "llm_others" })
    expect(byKey(listed(), GROUP)).toMatchObject({
      model: "gpt-x",
      modelParams: "[1]",
      modelSource: "session",
      resourceSource: "channel",
      customized: true,
      canRestoreDefault: true,
      defaultModel: "gemini-flash",
    })
  })

  it("单独指定了供应商：算自己改过，但不能一键恢复默认", () => {
    addSession(GROUP)
    setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_other2" })
    expect(byKey(listed(), GROUP)).toMatchObject({
      resourceId: "llm_other2",
      resourceSource: "session",
      modelSource: "session",
      customized: true,
      canRestoreDefault: false,
    })
  })

  it("只设了推理档：也算自己改过（批量清理要保留）", () => {
    addSession(GROUP, { state: { thinkingLevel: "high" } })
    expect(byKey(listed(), GROUP)).toMatchObject({ customized: true, canRestoreDefault: false, modelSource: "channel" })
  })

  it("不可管的会话（主用户的）即使只改了模型也不给恢复默认", () => {
    addSession(MAIN)
    setSessionOverride(MAIN, { model: "gpt-x", resourceId: "sdk_main" })
    expect(byKey(listed(), MAIN)).toMatchObject({ customized: true, canRestoreDefault: false })
  })

  it("通道默认模型改了，没设置过的会话立刻跟着变（清单里显示的是下次拉起实际用的）", () => {
    addSession(GROUP)
    const list = listed({ channels: [{ ...CH_A, othersModel: "new-default" }] })
    expect(byKey(list, GROUP)).toMatchObject({ model: "new-default", defaultModel: "new-default" })
  })

  it("每个会话的有效模型与单独调用 resolveLaunchModel 的结果一致", () => {
    addSession(GROUP)
    addSession(GUEST_P2P)
    setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_others" })
    setSessionResourceOverride(GUEST_P2P, "llm_other2")
    const list = listed()
    for (const s of list) {
      const direct = resolveLaunchModel({ sessionKey: s.sessionKey, channel: CH_A, audience: s.audience, resolveResource })
      expect({ model: s.model, rid: s.resourceId }).toEqual({ model: direct.model, rid: direct.resolvedResourceId })
    }
  })

  it("会话很多时只读一遍会话存储，不是每个会话读一遍（N×N 会让页面卡住）", () => {
    const N = 40
    for (let i = 0; i < N; i++) addSession(`ch_a|oc_g${i}::D:\\ws\\a`, { state: { agentId: `a${i}` } })
    // ESM 命名空间不可改：换掉 CJS 的 fs 对象上的函数，再同步回 ESM 导出
    const cjsFs = fsCjs as unknown as { readFileSync: (...a: unknown[]) => unknown }
    const original = cjsFs.readFileSync
    let stateReads = 0
    cjsFs.readFileSync = (...args: unknown[]) => {
      if (String(args[0]).endsWith("state.json")) stateReads++
      return original.apply(fsCjs, args)
    }
    syncBuiltinESMExports()
    try {
      listed()
    } finally {
      cjsFs.readFileSync = original
      syncBuiltinESMExports()
    }
    // 读一遍快照 = N 次；没共用快照的话每个会话的每次查询都读 N 次，会是 N×N
    expect(stateReads).toBeGreaterThanOrEqual(N)
    expect(stateReads).toBeLessThanOrEqual(N * 2)
  })
})

describe("readRoutingSnapshot", () => {
  it("读 daemon 落盘的路由表；没有文件 / 坏文件返回空", () => {
    expect(readRoutingSnapshot(dataDir)).toEqual({})
    writeRouting({ chatType: { a: "p2p" }, sessionToChat: { k: "a" } })
    expect(readRoutingSnapshot(dataDir)).toEqual({ chatType: { a: "p2p" }, sessionToChat: { k: "a" } })
    fs.writeFileSync(globalRoutingPath(dataDir), "{坏")
    expect(readRoutingSnapshot(dataDir)).toEqual({})
  })
})

// ── 恢复默认 ──────────────────────────────────────────────

describe("restoreModelDefault", () => {
  const restore = (key: string, channel: ManagerChannel = CH_A, audience: "main" | "others" = "others") =>
    restoreModelDefault({ sessionKey: key, channel, audience, resolveResource })
  const effective = (key: string, channel: ManagerChannel = CH_A) =>
    resolveLaunchModel({ sessionKey: key, channel, audience: "others", resolveResource })

  it("清掉会话自己存的模型，回到通道里其他人的默认，来源变回通道", () => {
    addSession(GROUP)
    setSessionOverride(GROUP, { model: "gpt-x", modelParams: "[1]", resourceId: "llm_others" })
    expect(restore(GROUP)).toEqual({ ok: true, clearedKeys: [GROUP] })
    expect(effective(GROUP)).toMatchObject({ model: "gemini-flash", modelSource: "channel", resourceSource: "channel" })
  })

  it("换模型时顺带存的、等于通道默认的供应商也一起清掉：以后通道改了供应商，不会变成隐形的供应商覆盖", () => {
    addSession(GROUP)
    setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_others" })
    restore(GROUP)
    expect(getSessionRecord(GROUP)?.resourceId).toBeUndefined()
    // 通道改了其他人供应商：会话跟着走
    const moved = { ...CH_A, othersAgentResourceId: "llm_other2" }
    expect(effective(GROUP, moved)).toMatchObject({ resourceId: "llm_other2", resourceSource: "channel" })
  })

  it("会话状态里其他的字段（续聊元数据、工作目录、推理档）不动", () => {
    addSession(GROUP, { state: { agentId: "agent-1", workspaceDir: "D:\\ws\\a", thinkingLevel: "high", chatId: "ch_a|oc_group1" } })
    setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_others" })
    restore(GROUP)
    const rec = getSessionRecord(GROUP)
    expect(rec).toMatchObject({ agentId: "agent-1", workspaceDir: "D:\\ws\\a", thinkingLevel: "high", chatId: "ch_a|oc_group1" })
    expect(rec?.model).toBeUndefined()
    expect(rec?.modelParams).toBeUndefined()
  })

  it("单独指定了供应商：拒绝，什么都不改", () => {
    addSession(GROUP)
    setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_other2" })
    const r = restore(GROUP)
    expect(r.ok).toBe(false)
    expect(getSessionRecord(GROUP)).toMatchObject({ model: "gpt-x", resourceId: "llm_other2" })
  })

  it("本来就没设置过模型：拒绝", () => {
    addSession(GROUP)
    const r = restore(GROUP)
    expect(r).toMatchObject({ ok: false })
  })

  it("模型记在所属聊天上（同一聊天下的会话共用）：自己名下没有时清聊天上的", () => {
    addSession(GROUP)
    addSession(GROUP_DIR2)
    setSessionOverride("ch_a|oc_group1", { model: "chat-level", resourceId: "llm_others" })
    expect(effective(GROUP)).toMatchObject({ model: "chat-level", modelSource: "session" })
    const r = restore(GROUP)
    expect(r).toEqual({ ok: true, clearedKeys: ["ch_a|oc_group1"] })
    expect(effective(GROUP)).toMatchObject({ model: "gemini-flash", modelSource: "channel" })
    // 这是同一聊天下共用的设置：另一个目录的会话也一并回到默认
    expect(effective(GROUP_DIR2)).toMatchObject({ model: "gemini-flash", modelSource: "channel" })
  })

  it("自己名下和聊天上都有：两处都清", () => {
    addSession(GROUP)
    setSessionOverride(GROUP, { model: "own", resourceId: "llm_others" })
    setSessionOverride("ch_a|oc_group1", { model: "chat-level", resourceId: "llm_others" })
    const r = restore(GROUP)
    expect(r).toEqual({ ok: true, clearedKeys: [GROUP, "ch_a|oc_group1"] })
    expect(effective(GROUP)).toMatchObject({ model: "gemini-flash", modelSource: "channel" })
  })

  it("别的聊天、别的会话的设置不受影响", () => {
    addSession(GROUP)
    addSession(GUEST_P2P)
    setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_others" })
    setSessionOverride(GUEST_P2P, { model: "keep-me", resourceId: "llm_others" })
    restore(GROUP)
    expect(getSessionRecord(GUEST_P2P)?.model).toBe("keep-me")
  })
})

// ── 批量清理 ──────────────────────────────────────────────

describe("normalizeCleanupDays", () => {
  it("合法值取整保留；非数字 / 小于 1 / 空用默认 14 天；封顶 10 年", () => {
    expect(normalizeCleanupDays(7)).toBe(7)
    expect(normalizeCleanupDays("30")).toBe(30)
    expect(normalizeCleanupDays(2.9)).toBe(2)
    expect(normalizeCleanupDays(1)).toBe(1)
    expect(normalizeCleanupDays(0)).toBe(DEFAULT_CLEANUP_DAYS)
    expect(normalizeCleanupDays(-3)).toBe(DEFAULT_CLEANUP_DAYS)
    expect(normalizeCleanupDays(NaN)).toBe(DEFAULT_CLEANUP_DAYS)
    expect(normalizeCleanupDays(undefined)).toBe(DEFAULT_CLEANUP_DAYS)
    expect(normalizeCleanupDays("abc")).toBe(DEFAULT_CLEANUP_DAYS)
    expect(normalizeCleanupDays(1e9)).toBe(3650)
    expect(DEFAULT_CLEANUP_DAYS).toBe(14)
  })
})

describe("planCleanup", () => {
  function s(over: Partial<ManagedSession>): ManagedSession {
    return {
      sessionKey: "k", channelId: "ch_a", channelName: "n", chatKey: "c", chatType: "group", audience: "others", kind: "workspace",
      name: "n", running: false, queued: 0, lastActiveAt: NOW - 30 * DAY, model: "m", modelParams: "", resourceId: "r", resourceName: "r",
      modelSource: "channel", resourceSource: "channel", defaultModel: "m", customized: false, manageable: true, canRestoreDefault: false,
      ...over,
    }
  }
  const plan = (sessions: ManagedSession[], opts: { olderThanDays?: unknown; channelId?: string } = {}) =>
    planCleanup(sessions, { now: NOW, ...opts })
  const keys = (p: ReturnType<typeof plan>) => p.candidates.map((c) => c.sessionKey)

  it("默认 14 天：超过的选中，不到的保留", () => {
    const p = plan([s({ sessionKey: "old", lastActiveAt: NOW - 15 * DAY }), s({ sessionKey: "new", lastActiveAt: NOW - 13 * DAY })])
    expect(p.olderThanDays).toBe(14)
    expect(keys(p)).toEqual(["old"])
    expect(p.excluded.recent).toBe(1)
  })

  it("恰好满 14 天算久未活动（边界含）；差一毫秒不算", () => {
    expect(keys(plan([s({ sessionKey: "edge", lastActiveAt: NOW - 14 * DAY })]))).toEqual(["edge"])
    expect(keys(plan([s({ sessionKey: "almost", lastActiveAt: NOW - 14 * DAY + 1 })]))).toEqual([])
  })

  it("自定义天数；不合法的天数退回 14", () => {
    const list = [s({ sessionKey: "d10", lastActiveAt: NOW - 10 * DAY }), s({ sessionKey: "d40", lastActiveAt: NOW - 40 * DAY })]
    expect(keys(plan(list, { olderThanDays: 7 }))).toEqual(["d10", "d40"])
    expect(keys(plan(list, { olderThanDays: 30 }))).toEqual(["d40"])
    expect(plan(list, { olderThanDays: -1 }).olderThanDays).toBe(14)
  })

  it("不选：不可管的 / 正在运行 / 有排队消息 / 自己改过设置 / 没有活动时间，各自计数", () => {
    const p = plan([
      s({ sessionKey: "main", manageable: false, audience: "main" }),
      s({ sessionKey: "run", running: true }),
      s({ sessionKey: "queued", queued: 2 }),
      s({ sessionKey: "custom", customized: true }),
      s({ sessionKey: "noact", lastActiveAt: undefined }),
      s({ sessionKey: "ok" }),
    ])
    expect(keys(p)).toEqual(["ok"])
    expect(p.excluded).toEqual({ notManageable: 1, running: 1, queued: 1, customized: 1, noActivityTime: 1, recent: 0 })
  })

  it("一个会话只记第一条原因（又在运行又太新，只算运行）", () => {
    const p = plan([s({ sessionKey: "x", running: true, lastActiveAt: NOW - DAY })])
    expect(p.excluded).toMatchObject({ running: 1, recent: 0 })
  })

  it("可以只清某个通道，其他通道的不计入", () => {
    const p = plan(
      [s({ sessionKey: "a", channelId: "ch_a" }), s({ sessionKey: "b", channelId: "ch_b" }), s({ sessionKey: "b-run", channelId: "ch_b", running: true })],
      { channelId: "ch_b" },
    )
    expect(keys(p)).toEqual(["b"])
    expect(p.excluded.running).toBe(1)
  })

  it("真实清单跑一遍：只选其他人的、够久的、没设置过的", () => {
    addSession(GROUP, { mirror: mirrorAt(NOW - 20 * DAY) }) // 选中
    addSession(GROUP_DIR2, { mirror: mirrorAt(NOW - 20 * DAY) })
    setSessionOverride(GROUP_DIR2, { model: "gpt-x", resourceId: "llm_others" }) // 改过模型：保留
    addSession(GUEST_P2P, { mirror: mirrorAt(NOW - 2 * DAY) }) // 太新：保留
    addSession(MAIN, { mirror: mirrorAt(NOW - 60 * DAY) }) // 主用户：保留
    addSession(PROJECT, { mirror: mirrorAt(NOW - 60 * DAY) }) // 项目：保留
    const p = planCleanup(listed(), { now: NOW })
    expect(keys(p)).toEqual([GROUP])
    expect(p.excluded).toEqual({ notManageable: 2, running: 0, queued: 0, customized: 1, noActivityTime: 0, recent: 1 })
  })
})
