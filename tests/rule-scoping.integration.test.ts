/** 规则按通道×人群生效 + 主/其他资源开关区分：真实持久化目录集成测试。
 * 覆盖 Electron prompt-assembler 与 Daemon 运行时调用的同一批函数与存储。 */
import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  channelIdFromSessionKey,
  chatIdFromSessionKey,
  parseChatKey,
  resolveChannelAudience,
  resolveChannelResourceId,
  resolveChannelSessionFlags,
  resolveDaemonSessionFlags,
  type ChannelAudience,
} from "../src/shared/channel-types.js"
import {
  initHarnessRuleStore,
  listEnabledHarnessRules,
  listHarnessRules,
  saveHarnessRule,
  deleteHarnessRule,
  exportHarnessRulesBundle,
  importHarnessRulesBundle,
  ruleAppliesTo,
} from "../src/shared/harness-rule-store.js"

// ── 测试通道（镜像真实配置）──
const CH = {
  ch_aaa: { id: "ch_aaa", mainUserEnabled: true, mainUserChatId: "oc_main" },
  ch_bbb: { id: "ch_bbb", mainUserEnabled: true, mainUserChatId: "oc_b" },
} as const

let dir = ""
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrules-"))
  initHarnessRuleStore(dir)
})

function seed() {
  saveHarnessRule(null, "legacy", "legacy-body") // 无 scope → 仅主用户
  saveHarnessRule(null, "mainOnly", "m", true, { mode: "main" })
  saveHarnessRule(null, "ch_aaa-main", "m", true, { mode: "custom", targets: [{ channelId: "ch_aaa", audiences: ["main"] }] })
  saveHarnessRule(null, "ch_aaa-others", "m", true, { mode: "custom", targets: [{ channelId: "ch_aaa", audiences: ["others"] }] })
  saveHarnessRule(null, "ch_bbb-both", "m", true, { mode: "custom", targets: [{ channelId: "ch_bbb", audiences: ["main", "others"] }] })
  saveHarnessRule(null, "nowhere", "m", true, { mode: "custom", targets: [] })
  saveHarnessRule(null, "off", "m", false, { mode: "custom", targets: [{ channelId: "ch_aaa", audiences: ["main", "others"] }] })
}

/** 镜像 electron/prompt-assembler resolvePromptRuleScope + 过滤 */
function rulesFor(sessionKey: string, chatType?: string, metaChatId?: string): string[] {
  const chatKey = sessionKey ? chatIdFromSessionKey(sessionKey) : (metaChatId ?? "")
  let channelId = sessionKey ? channelIdFromSessionKey(sessionKey) : undefined
  let ch: { mainUserEnabled?: boolean; mainUserChatId?: string; id?: string } | undefined =
    channelId ? (CH as Record<string, { id: string; mainUserEnabled: boolean; mainUserChatId: string }>)[channelId] : undefined
  if (!ch && metaChatId) {
    const parsed = parseChatKey(metaChatId)
    if (parsed.channelId) {
      ch = (CH as Record<string, { id: string; mainUserEnabled: boolean; mainUserChatId: string }>)[parsed.channelId]
      channelId = parsed.channelId
    }
  }
  const audience: ChannelAudience = resolveChannelAudience({
    mainUserEnabled: ch?.mainUserEnabled,
    mainUserChatId: ch?.mainUserChatId,
    chatKey,
    chatType,
    sessionKey,
  })
  return listEnabledHarnessRules()
    .filter((r) => ruleAppliesTo(r, channelId, audience))
    .map((r) => r.id)
    .sort()
}

/** 镜像 daemon channelAudienceForSession（无 chatType） */
function daemonAudience(sessionKey: string, channelId?: string): ChannelAudience {
  const cfg = channelId ? (CH as Record<string, { id: string; mainUserEnabled: boolean; mainUserChatId: string }>)[channelId] : undefined
  return resolveChannelAudience({
    mainUserEnabled: cfg?.mainUserEnabled,
    mainUserChatId: cfg?.mainUserChatId,
    chatKey: chatIdFromSessionKey(sessionKey),
    sessionKey,
  })
}

describe("规则选择性生效矩阵", () => {
  it("主用户私聊 ch_aaa：legacy + mainOnly + ch_aaa-main", () => {
    seed()
    expect(rulesFor("ch_aaa|oc_main", "p2p")).toEqual(["ch_aaa-main", "legacy", "mainOnly"])
  })
  it("陌生人私聊 ch_aaa：仅 ch_aaa-others", () => {
    seed()
    expect(rulesFor("ch_aaa|oc_x", "p2p")).toEqual(["ch_aaa-others"])
  })
  it("群聊 ch_aaa：仅 ch_aaa-others", () => {
    seed()
    expect(rulesFor("ch_aaa|oc_group", "group")).toEqual(["ch_aaa-others"])
  })
  it("项目会话走主：含 ch_aaa-main，不含 others", () => {
    seed()
    expect(rulesFor("ch_aaa|oc_group::project_p1", "group")).toEqual(["ch_aaa-main", "legacy", "mainOnly"])
  })
  it("task/temp 无通道：仅 main 模式规则", () => {
    seed()
    expect(rulesFor("task_1", "task")).toEqual(["legacy", "mainOnly"])
    expect(rulesFor("temp_abc", "temp")).toEqual(["legacy", "mainOnly"])
  })
  it("主用户私聊 ch_bbb：legacy + mainOnly + ch_bbb-both", () => {
    seed()
    expect(rulesFor("ch_bbb|oc_b", "p2p")).toEqual(["ch_bbb-both", "legacy", "mainOnly"])
  })
  it("nowhere 与禁用规则永不出现", () => {
    seed()
    for (const args of [
      ["ch_aaa|oc_main", "p2p"],
      ["ch_aaa|oc_x", "p2p"],
      ["ch_bbb|oc_b", "p2p"],
    ] as [string, string][]) {
      const got = rulesFor(args[0], args[1])
      expect(got).not.toContain("nowhere")
      expect(got).not.toContain("off")
    }
  })
})

describe("daemon 侧人群判定（无 chatType）与主侧一致", () => {
  it("p2p 主绑定 / 群聊 / 项目", () => {
    expect(daemonAudience("ch_aaa|oc_main::D:\\ws", "ch_aaa")).toBe("main")
    expect(daemonAudience("ch_aaa|oc_group", "ch_aaa")).toBe("others")
    expect(daemonAudience("ch_aaa|oc_group::project_p1", "ch_aaa")).toBe("main")
    expect(daemonAudience("temp_abc")).toBe("main")
  })
  it("他人群体的保活/思考取 others 默认（关）", () => {
    const f = resolveDaemonSessionFlags({ keepAlive: true, showThinking: true }, "others")
    expect(f.keepAlive).toBe(false)
    expect(f.showThinking).toBe(false)
  })
})

describe("资源与开关按人群", () => {
  const legacy = { agentResourceId: "sdk_1", keepSession: false, persistentPoll: true, showThinking: true }
  it("主：回退旧通道级字段", () => {
    expect(resolveChannelResourceId(legacy, "main")).toBe("sdk_1")
    const f = resolveChannelSessionFlags(legacy as never, "main")
    expect(f.keepSession).toBe(false)
    expect(f.persistentPoll).toBe(true) // 返回原始值；keep&&poll 合成在调用方（发射层/下发层） 
    expect(f.showThinking).toBe(true)
  })
  it("其他：不回退旧字段，跟随/独立默认", () => {
    expect(resolveChannelResourceId({ ...legacy, othersAgentResourceId: "" }, "others")).toBe("sdk_1")
    expect(resolveChannelResourceId({ ...legacy, othersAgentResourceId: "llm_9" }, "others")).toBe("llm_9")
    const f = resolveChannelSessionFlags(legacy as never, "others")
    expect([f.keepSession, f.persistentPoll, f.showThinking]).toEqual([true, false, false])
  })
})

describe("scope 持久化与 bundle 往返", () => {
  it("manifest 只存 custom；缺省读回为 main", () => {
    seed()
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "harness-rules", "manifest.json"), "utf-8"))
    expect(Object.keys(manifest.scopes ?? {}).sort()).toEqual(["ch_aaa-main", "ch_aaa-others", "ch_bbb-both", "nowhere", "off"])
    const back = Object.fromEntries(listHarnessRules().map((r) => [r.id, r.scope?.mode]))
    expect(back["legacy"]).toBe("main")
    expect(back["mainOnly"]).toBe("main")
    expect(back["ch_aaa-main"]).toBe("custom")
  })
  it("改名搬运 scope；删除清理 scope", () => {
    seed()
    const saved = saveHarnessRule("ch_aaa-main", "ch_aaa-main2", "m", true)
    expect(saved?.scope).toEqual({ mode: "custom", targets: [{ channelId: "ch_aaa", audiences: ["main"] }] })
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "harness-rules", "manifest.json"), "utf-8"))
    expect(manifest.scopes["ch_aaa-main"]).toBeUndefined()
    expect(deleteHarnessRule("ch_aaa-main2")).toBe(true)
    const manifest2 = JSON.parse(fs.readFileSync(path.join(dir, "harness-rules", "manifest.json"), "utf-8"))
    expect(manifest2.scopes["ch_aaa-main2"]).toBeUndefined()
  })
  it("bundle 导出导入保留 scope；老 bundle 无 scope 按主用户", () => {
    seed()
    const bundle = exportHarnessRulesBundle()!
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lrules2-"))
    initHarnessRuleStore(dir2)
    importHarnessRulesBundle(bundle)
    const back = Object.fromEntries(listHarnessRules().map((r) => [r.id, r.scope]))
    expect(back["ch_bbb-both"]).toEqual({ mode: "custom", targets: [{ channelId: "ch_bbb", audiences: ["main", "others"] }] })
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "lrules3-"))
    initHarnessRuleStore(dir3)
    importHarnessRulesBundle({ order: ["old"], files: { old: { content: "x", enabled: true } } })
    expect(listHarnessRules()[0].scope).toEqual({ mode: "main" })
  })
})
