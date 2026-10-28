import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  CHANNEL_MODEL_FIELDS,
  bucketOthers,
  clearOptionText,
  clearTargets,
  defaultLabel,
  followingRunningKeys,
  holdBackModelEdits,
  impactLines,
  impactOutcomeLines,
  needsImpactPrompt,
  othersOfChannel,
  stopCount,
  stopOptionText,
  type ChannelModelImpact,
} from "../src/shared/channel-model-impact"
import { othersDefaultChanged, othersDefaultOf, resolveLaunchModel, type ChannelModelFields } from "../src/shared/launch-model"
import {
  listManagedSessions,
  restoreModelDefault,
  type ManagedSession,
  type ManagedSessionsEnv,
  type ManagerChannel,
} from "../src/shared/managed-sessions"
import { ensureSessionEntry } from "../src/shared/session-entry-paths"
import { getSessionRecord, initSessionOverridesStore, resetSessionOverridesStoreForTests } from "../src/shared/session-overrides-store"
import { setSessionOverride } from "../src/shared/session-model-store"

/**
 * 保存通道里「其他人」的默认模型时的影响提示：
 * 「默认到底变没变」「别人的会话各算哪一类」「先清后存、存完再停」这几个顺序和边界。
 * 纯函数直接测；涉及会话存储的用真实实现 + 临时目录，不 mock。
 */

// ── 其他人的默认有没有变 ──────────────────────────────────

const base: ChannelModelFields = {
  agentResourceId: "sdk_main",
  othersAgentResourceId: "llm_others",
  model: "composer-2",
  modelParams: "[]",
  othersModel: "gemini-flash",
  othersModelParams: '[{"id":"thinking","value":"high"}]',
}

describe("othersDefaultOf：其他人实际用的默认", () => {
  it("其他人单独配了供应商和模型：用他们自己的", () => {
    expect(othersDefaultOf(base)).toEqual({
      resourceId: "llm_others",
      model: "gemini-flash",
      modelParams: '[{"id":"thinking","value":"high"}]',
    })
  })

  it("其他人留空：跟随主用户的供应商、模型和参数", () => {
    const c = { ...base, othersAgentResourceId: "", othersModel: "", othersModelParams: "" }
    expect(othersDefaultOf(c)).toEqual({ resourceId: "sdk_main", model: "composer-2", modelParams: "[]" })
  })

  it("只有空白也算留空", () => {
    const c = { ...base, othersAgentResourceId: "  ", othersModel: "   " }
    expect(othersDefaultOf(c)).toMatchObject({ resourceId: "sdk_main", model: "composer-2" })
  })

  it("两端空白不影响取值", () => {
    expect(othersDefaultOf({ ...base, othersModel: " gemini-flash " }).model).toBe("gemini-flash")
  })
})

describe("othersDefaultChanged", () => {
  it("没改任何东西：没变", () => {
    expect(othersDefaultChanged(base, { ...base })).toBe(false)
  })

  it("改了其他人自己的模型：变了", () => {
    expect(othersDefaultChanged(base, { ...base, othersModel: "gpt-x" })).toBe(true)
  })

  it("改了其他人自己的模型参数：变了", () => {
    expect(othersDefaultChanged(base, { ...base, othersModelParams: "[]" })).toBe(true)
  })

  it("改了其他人自己的供应商：变了", () => {
    expect(othersDefaultChanged(base, { ...base, othersAgentResourceId: "llm_other2" })).toBe(true)
  })

  it("其他人留空时改主模型：其他人跟着变，算变了", () => {
    const before = { ...base, othersModel: "", othersModelParams: "" }
    expect(othersDefaultChanged(before, { ...before, model: "composer-3" })).toBe(true)
    expect(othersDefaultChanged(before, { ...before, modelParams: "[1]" })).toBe(true)
  })

  it("其他人留空时改主供应商：其他人跟着变，算变了", () => {
    const before = { ...base, othersAgentResourceId: "" }
    expect(othersDefaultChanged(before, { ...before, agentResourceId: "sdk_new" })).toBe(true)
  })

  it("其他人单独配了的，改主用户的模型 / 供应商不影响他们：没变", () => {
    expect(othersDefaultChanged(base, { ...base, model: "composer-3", modelParams: "[2]", agentResourceId: "sdk_new" })).toBe(false)
  })

  it("把其他人的模型清空（改成跟随主模型）：跟随的结果和原来不同才算变", () => {
    expect(othersDefaultChanged(base, { ...base, othersModel: "" })).toBe(true)
    // 其他人单独配的恰好和主模型一样，清空后结果相同：没变
    const same = { ...base, othersModel: "composer-2", othersModelParams: "[]" }
    expect(othersDefaultChanged(same, { ...same, othersModel: "", othersModelParams: "" })).toBe(false)
  })

  it("只是首尾空白不同：没变", () => {
    expect(othersDefaultChanged(base, { ...base, othersModel: "gemini-flash  ", othersAgentResourceId: " llm_others" })).toBe(false)
    expect(othersDefaultChanged(base, { ...base, othersModelParams: ` ${base.othersModelParams} ` })).toBe(false)
    // 其他人留空、跟随主供应商时，主供应商 id 带空白也是同一个
    const follow = { ...base, othersAgentResourceId: "" }
    expect(othersDefaultChanged(follow, { ...follow, agentResourceId: " sdk_main " })).toBe(false)
  })
})

// ── 分类 ────────────────────────────────────────────────

let n = 0
const sess = (over: Partial<ManagedSession> = {}): ManagedSession => ({
  sessionKey: `ch_a|oc_${++n}::D:\\ws`,
  channelId: "ch_a",
  channelName: "飞书服务台",
  chatKey: `ch_a|oc_${n}`,
  chatType: "group",
  audience: "others",
  kind: "workspace",
  name: `群${n}`,
  running: false,
  queued: 0,
  model: "gemini-flash",
  modelParams: "",
  resourceId: "llm_others",
  resourceName: "其他人供应商",
  modelSource: "channel",
  resourceSource: "channel",
  defaultModel: "gemini-flash",
  customized: false,
  manageable: true,
  canRestoreDefault: false,
  ...over,
})
/** 只改了模型（供应商跟着通道） */
const modelOnly = (over: Partial<ManagedSession> = {}) => sess({ modelSource: "session", customized: true, canRestoreDefault: true, ...over })
/** 单独指定了供应商（模型也可能改过） */
const providerOwn = (over: Partial<ManagedSession> = {}) =>
  sess({ resourceSource: "session", modelSource: "session", customized: true, canRestoreDefault: false, ...over })

describe("othersOfChannel", () => {
  it("只要这个通道里、其他人的、可管理的会话", () => {
    const mine = sess()
    const list = [
      mine,
      sess({ channelId: "ch_b" }),
      sess({ audience: "main" }),
      sess({ manageable: false, kind: "project" }),
    ]
    expect(othersOfChannel(list, "ch_a")).toEqual([mine])
  })
})

describe("bucketOthers", () => {
  it("没单独设置 / 只改了模型 / 单独指定供应商，各数各的，运行中的也分开数", () => {
    const list = [
      sess(),
      sess({ running: true }),
      sess({ running: true }),
      modelOnly(),
      modelOnly({ running: true }),
      providerOwn(),
      providerOwn({ running: true }),
      providerOwn({ running: true }),
    ]
    expect(bucketOthers(list, "ch_a")).toEqual({
      total: 8,
      following: { total: 3, running: 2 },
      modelPinned: { total: 2, running: 1 },
      providerPinned: { total: 3, running: 2 },
    })
  })

  it("单独指定了供应商的只算一次（即使模型也改过），三类加起来等于总数", () => {
    const list = [sess(), modelOnly(), providerOwn(), providerOwn({ modelSource: "channel" })]
    const b = bucketOthers(list, "ch_a")
    expect(b.following.total + b.modelPinned.total + b.providerPinned.total).toBe(b.total)
    expect(b.providerPinned.total).toBe(2)
  })

  it("主用户的、不可管理的、别的通道的都不算", () => {
    const list = [
      sess({ audience: "main", running: true }),
      sess({ manageable: false, running: true }),
      sess({ channelId: "ch_b", running: true }),
    ]
    expect(bucketOthers(list, "ch_a")).toEqual({
      total: 0,
      following: { total: 0, running: 0 },
      modelPinned: { total: 0, running: 0 },
      providerPinned: { total: 0, running: 0 },
    })
  })
})

describe("clearTargets：清除时要动的会话", () => {
  it("只有「只改了模型」的其他人的会话", () => {
    const target = modelOnly()
    const list = [
      target,
      sess(),
      providerOwn(),
      modelOnly({ audience: "main" }),
      modelOnly({ manageable: false, canRestoreDefault: false }),
      modelOnly({ channelId: "ch_b" }),
    ]
    expect(clearTargets(list, "ch_a")).toEqual([target])
  })

  it("和 bucketOthers 数出来的「单独改过模型」是同一批", () => {
    const list = [sess(), modelOnly(), modelOnly({ running: true }), providerOwn()]
    expect(clearTargets(list, "ch_a")).toHaveLength(bucketOthers(list, "ch_a").modelPinned.total)
  })
})

describe("followingRunningKeys：保存后要停的会话", () => {
  it("只有跟随默认、正在运行的其他人的会话", () => {
    const hit = sess({ running: true })
    const list = [
      hit,
      sess({ running: false }),
      modelOnly({ running: true }),
      providerOwn({ running: true }),
      sess({ running: true, audience: "main" }),
      sess({ running: true, manageable: false }),
      sess({ running: true, channelId: "ch_b" }),
    ]
    expect(followingRunningKeys(list, "ch_a")).toEqual([hit.sessionKey])
  })
})

// ── 要不要问 / 问什么 ─────────────────────────────────────

const impact = (over: Partial<ChannelModelImpact> = {}): ChannelModelImpact => ({
  changed: true,
  oldDefault: { resourceId: "llm_others", resourceName: "其他人供应商", model: "gemini-flash", modelParams: "" },
  newDefault: { resourceId: "llm_others", resourceName: "其他人供应商", model: "gpt-x", modelParams: "" },
  providerChanged: false,
  total: 0,
  following: { total: 0, running: 0 },
  modelPinned: { total: 0, running: 0 },
  providerPinned: { total: 0, running: 0 },
  ...over,
})

describe("needsImpactPrompt", () => {
  it("默认没变：不问，哪怕有很多会话", () => {
    expect(needsImpactPrompt(impact({ changed: false, total: 5, following: { total: 3, running: 2 }, modelPinned: { total: 2, running: 0 } }))).toBe(false)
  })

  it("变了但没有会话：不问", () => {
    expect(needsImpactPrompt(impact())).toBe(false)
  })

  it("变了，只有没在运行的跟随会话：不问（下一条消息自动用新的，没有需要用户决定的）", () => {
    expect(needsImpactPrompt(impact({ total: 3, following: { total: 3, running: 0 } }))).toBe(false)
  })

  it("变了，有运行中的跟随会话：问（可以停掉）", () => {
    expect(needsImpactPrompt(impact({ total: 3, following: { total: 3, running: 1 } }))).toBe(true)
  })

  it("变了，有单独改过模型的：问（可以清除）", () => {
    expect(needsImpactPrompt(impact({ total: 1, modelPinned: { total: 1, running: 0 } }))).toBe(true)
  })

  it("变了，只有单独指定供应商的：不问（那是有意的选择，也没有可做的）", () => {
    expect(needsImpactPrompt(impact({ total: 2, providerPinned: { total: 2, running: 2 } }))).toBe(false)
  })
})

describe("提示文案", () => {
  it("defaultLabel：没配供应商 / 模型留空时用占位词", () => {
    expect(defaultLabel({ resourceName: "其他人供应商", model: "gpt-x" })).toBe("其他人供应商 / gpt-x")
    expect(defaultLabel({ resourceName: "", model: "" })).toBe("未配置供应商 / 自动")
  })

  it("stopCount：勾了清除，被清掉设置的运行中会话也要停", () => {
    const i = impact({ following: { total: 4, running: 2 }, modelPinned: { total: 3, running: 1 } })
    expect(stopCount(i, false)).toBe(2)
    expect(stopCount(i, true)).toBe(3)
  })

  it("选项文案带上实际个数", () => {
    const i = impact({ following: { total: 4, running: 2 }, modelPinned: { total: 3, running: 1 } })
    expect(stopOptionText(i, false)).toContain("2 个")
    expect(stopOptionText(i, true)).toContain("3 个")
    expect(clearOptionText(i)).toContain("3 个")
  })

  it("impactLines：第一行是新旧默认，没有的类别不出现", () => {
    const lines = impactLines(impact({ total: 1, following: { total: 1, running: 0 } }))
    expect(lines[0]).toBe("其他人的默认模型：其他人供应商 / gemini-flash → 其他人供应商 / gpt-x")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("没单独设置过的会话 1 个")
    expect(lines[1]).not.toContain("正在运行")
  })

  it("impactLines：运行中的、单独设置过的、供应商变了，各有一行说明", () => {
    const lines = impactLines(
      impact({
        providerChanged: true,
        total: 6,
        following: { total: 3, running: 2 },
        modelPinned: { total: 2, running: 0 },
        providerPinned: { total: 1, running: 0 },
      }),
    ).join("\n")
    expect(lines).toContain("其中 2 个正在运行")
    expect(lines).toContain("单独改过模型的会话 2 个")
    expect(lines).toContain("单独指定了供应商的会话 1 个")
    expect(lines).toContain("供应商也变了")
    // 上下文能不能延续没法保证，措辞不能说死
    expect(lines).toContain("可能不会延续")
  })
})

describe("impactOutcomeLines：保存完成后的结果说明", () => {
  it("什么都没做 / 没出问题：不用弹窗", () => {
    expect(impactOutcomeLines({})).toEqual([])
    expect(impactOutcomeLines({ clear: { ok: true, cleared: 0, failed: [] }, stop: { ok: true, stopped: 0, failed: [] } })).toEqual([])
  })

  it("清除、停止成功：各一行带个数", () => {
    const lines = impactOutcomeLines({ clear: { ok: true, cleared: 3, failed: [] }, stop: { ok: true, stopped: 2, failed: [] } })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("已清除 3 个")
    expect(lines[1]).toContain("已停止 2 个")
  })

  it("部分失败：写出失败个数和原因（相同原因只写一次），并说明失败的怎么样", () => {
    const lines = impactOutcomeLines({
      clear: {
        ok: false,
        cleared: 1,
        failed: [
          { sessionKey: "a", error: "磁盘写入失败" },
          { sessionKey: "b", error: "磁盘写入失败" },
        ],
      },
      stop: { ok: false, stopped: 0, failed: [{ sessionKey: "c", error: "停不掉" }] },
    })
    expect(lines[0]).toContain("已清除 1 个，2 个失败（磁盘写入失败）")
    expect(lines[0]).toContain("仍沿用自己设置的模型")
    expect(lines[1]).toContain("已停止 0 个，1 个失败（停不掉）")
    expect(lines[1]).toContain("等它们自己结束")
  })

  it("只要失败清单里有东西就要说，不管 ok 写的是什么", () => {
    const lines = impactOutcomeLines({ stop: { ok: true, stopped: 1, failed: [{ sessionKey: "a", error: "超时" }] } })
    expect(lines[0]).toContain("已停止 1 个，1 个失败（超时）")
    const clear = impactOutcomeLines({ clear: { ok: true, cleared: 1, failed: [{ sessionKey: "a", error: "写入失败" }] } })
    expect(clear[0]).toContain("已清除 1 个，1 个失败（写入失败）")
  })

  it("整步失败（抛了异常、没有逐个结果）：写出原因，不能静默", () => {
    const lines = impactOutcomeLines({ clear: { ok: false, error: "通道不存在", cleared: 0, failed: [] } })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("通道不存在")
  })

  it("影响预览失败：说明保存已完成，以及运行中的会话要等结束", () => {
    const lines = impactOutcomeLines({ previewError: "daemon 没响应" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("daemon 没响应")
    expect(lines[0]).toContain("已保存")
  })
})

// ── 其他途径落库时不带模型改动 ─────────────────────────────

describe("holdBackModelEdits", () => {
  const saved = { name: "服务台", enabled: true, ...base }

  it("字段表和 ChannelModelFields 一致（以后加了模型字段，这里编译就会提醒）", () => {
    const all: Record<keyof ChannelModelFields, true> = {
      agentResourceId: true,
      othersAgentResourceId: true,
      model: true,
      modelParams: true,
      othersModel: true,
      othersModelParams: true,
    }
    expect([...CHANNEL_MODEL_FIELDS].sort()).toEqual(Object.keys(all).sort())
  })

  it("非模型字段的改动照常带上，模型字段取已保存的值", () => {
    const draft = { ...saved, name: "新名字", enabled: false, model: "composer-3", othersModel: "gpt-x", othersAgentResourceId: "llm_other2" }
    expect(holdBackModelEdits(draft, saved)).toEqual({ ...saved, name: "新名字", enabled: false })
  })

  it("每个模型字段单独改动都被挡住，其他人的默认不会因此变化", () => {
    for (const f of CHANNEL_MODEL_FIELDS) {
      const draft = { ...saved, [f]: "changed" }
      const held = holdBackModelEdits(draft, saved)
      expect(held[f], f).toBe(saved[f])
      expect(othersDefaultChanged(saved, held), f).toBe(false)
    }
  })

  it("模型字段没改：原样返回（含空白等细节不被改动）", () => {
    const draft = { ...saved, name: "x", othersModel: "  gemini-flash " }
    const s2 = { ...saved, othersModel: "  gemini-flash " }
    expect(holdBackModelEdits(draft, s2)).toEqual(draft)
  })

  it("不改传入的对象", () => {
    const draft = { ...saved, model: "composer-3" }
    holdBackModelEdits(draft, saved)
    expect(draft.model).toBe("composer-3")
  })
})

// ── 先清后存、存完再停（真实会话存储） ─────────────────────

const GROUP = "ch_a|oc_group1::D:\\ws\\a"
const GUEST = "ch_a|ou_guest::D:\\ws\\a"
const GROUP_OWN_PROVIDER = "ch_a|oc_group3::D:\\ws\\a"
const MAIN = "ch_a|ou_main::D:\\ws\\a"
const PROJECT = "ch_a|oc_group2::project_p1"
const OTHER_CH = "ch_b|oc_x::D:\\ws\\a"

const KNOWN: Record<string, string> = { sdk_main: "主供应商", llm_others: "其他人供应商", llm_other2: "备用供应商", llm_third: "第三供应商" }
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
const CH_B: ManagerChannel = { ...CH_A, id: "ch_b", name: "另一个通道", mainUserChatId: "ou_b" }

const ROUTING = {
  chatType: {
    "ch_a|ou_main": "p2p",
    "ch_a|ou_guest": "p2p",
    "ch_a|oc_group1": "group",
    "ch_a|oc_group2": "group",
    "ch_a|oc_group3": "group",
    "ch_b|oc_x": "group",
  },
}

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-impact-"))
  initSessionOverridesStore(dataDir)
})
afterEach(() => {
  resetSessionOverridesStoreForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function list(channels: ManagerChannel[], runningKeys: string[] = []): ManagedSession[] {
  const env: ManagedSessionsEnv = {
    userDataDir: dataDir,
    now: Date.UTC(2026, 9, 28, 12, 0, 0),
    channels,
    resolveResource,
    runningKeys,
    queuedByKey: new Map(),
    routing: ROUTING,
    taskIds: new Set(),
    chatName: () => undefined,
  }
  return listManagedSessions(env).sessions
}
const find = (sessions: ManagedSession[], key: string): ManagedSession => {
  const hit = sessions.find((s) => s.sessionKey === key)
  if (!hit) throw new Error(`清单里没有 ${key}`)
  return hit
}
const effective = (key: string, channel: ManagerChannel) =>
  resolveLaunchModel({ sessionKey: key, channel, audience: "others", resolveResource })

/** 模拟「保存前清除」：和主进程的 clearOthersModelOverrides 一样，用旧通道配置、对 clearTargets 逐个恢复默认 */
function clearBeforeSave(oldChannel: ManagerChannel): number {
  let cleared = 0
  for (const s of clearTargets(list([oldChannel, CH_B]), oldChannel.id)) {
    const r = restoreModelDefault({ sessionKey: s.sessionKey, channel: oldChannel, audience: s.audience, resolveResource })
    if (r.ok) cleared++
  }
  return cleared
}

function seed(): void {
  for (const k of [GROUP, GUEST, GROUP_OWN_PROVIDER, MAIN, PROJECT, OTHER_CH]) ensureSessionEntry(dataDir, k)
  // 其他人：群聊里有人 /m 换过模型（换模型会顺带存下当时的供应商 = 通道默认）
  setSessionOverride(GROUP, { model: "gpt-x", resourceId: "llm_others" })
  // 其他人：私聊没设置过
  // 其他人：群聊里单独指定了供应商
  setSessionOverride(GROUP_OWN_PROVIDER, { model: "gpt-own", resourceId: "llm_other2" })
  // 主用户、项目、别的通道：也各有自己的设置
  setSessionOverride(MAIN, { model: "main-model", resourceId: "sdk_main" })
  setSessionOverride(PROJECT, { model: "project-model", resourceId: "llm_others" })
  setSessionOverride(OTHER_CH, { model: "other-channel-model", resourceId: "llm_others" })
}

describe("先清后存：单独改过模型的会话在其他人换供应商 / 模型后能跟上", () => {
  const next: ManagerChannel = { ...CH_A, othersAgentResourceId: "llm_third", othersModel: "new-model" }

  it("不先清：换模型时顺带存的旧供应商，在通道换供应商后变成隐形的供应商覆盖，会话停在旧供应商（所以必须先清）", () => {
    seed()
    const after = find(list([next, CH_B]), GROUP)
    expect(after).toMatchObject({ resourceId: "llm_others", resourceSource: "session", model: "gpt-x" })
  })

  it("先用旧配置清掉，再存新配置：会话用新供应商和新模型", () => {
    seed()
    expect(clearBeforeSave(CH_A)).toBe(1)
    const after = find(list([next, CH_B]), GROUP)
    expect(after).toMatchObject({
      resourceId: "llm_third",
      resourceSource: "channel",
      model: "new-model",
      modelSource: "channel",
      customized: false,
    })
    expect(effective(GROUP, next)).toMatchObject({ resourceId: "llm_third", model: "new-model" })
  })

  it("单独指定了供应商的不动；主用户的、项目的、别的通道的设置原样保留", () => {
    seed()
    const before = (k: string) => JSON.stringify(getSessionRecord(k))
    const snapshots = [GROUP_OWN_PROVIDER, MAIN, PROJECT, OTHER_CH].map((k) => [k, before(k)] as const)
    expect(clearBeforeSave(CH_A)).toBe(1)
    for (const [k, snap] of snapshots) expect(before(k), k).toBe(snap)
    // 单独指定了供应商的，换默认后依然用自己指定的
    expect(find(list([next, CH_B]), GROUP_OWN_PROVIDER)).toMatchObject({ resourceId: "llm_other2", model: "gpt-own", resourceSource: "session" })
  })

  it("要清的就是预览时数出来的「单独改过模型」那一批", () => {
    seed()
    const sessions = list([CH_A, CH_B])
    expect(bucketOthers(sessions, "ch_a").modelPinned.total).toBe(1)
    expect(clearBeforeSave(CH_A)).toBe(bucketOthers(sessions, "ch_a").modelPinned.total)
    // 清完再看：没有可清的了
    expect(clearTargets(list([next, CH_B]), "ch_a")).toEqual([])
  })
})

describe("存完再停：运行中的会话", () => {
  const next: ManagerChannel = { ...CH_A, othersModel: "new-model" }

  it("清除之前，只改了模型的运行中会话不在要停的里面；清除之后它们和跟随的一样要停", () => {
    seed()
    setSessionOverride(GUEST, { model: "guest-model", resourceId: "llm_others" })
    const running = [GROUP, GUEST, MAIN, OTHER_CH]
    // 保存前：GROUP、GUEST 都是只改了模型的，不会因为默认变化而变，不算「跟随」
    expect(followingRunningKeys(list([CH_A, CH_B], running), "ch_a")).toEqual([])
    // 先清，再存，再算：GROUP、GUEST 现在跟随新默认，是按旧模型拉起的、要停
    clearBeforeSave(CH_A)
    expect(followingRunningKeys(list([next, CH_B], running), "ch_a").sort()).toEqual([GROUP, GUEST].sort())
  })

  it("没勾清除：只停原本就跟随默认的，单独改过的继续用自己的模型，不停", () => {
    seed() // GUEST 没设置过
    const running = [GROUP, GUEST, GROUP_OWN_PROVIDER, MAIN, PROJECT, OTHER_CH]
    expect(followingRunningKeys(list([next, CH_B], running), "ch_a")).toEqual([GUEST])
  })

  it("主用户的、项目的、别的通道的运行中会话永远不在里面", () => {
    seed()
    const running = [MAIN, PROJECT, OTHER_CH]
    expect(followingRunningKeys(list([next, CH_B], running), "ch_a")).toEqual([])
  })
})
