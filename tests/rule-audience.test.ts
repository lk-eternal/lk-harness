import { describe, it, expect } from "vitest"
import {
  resolveChannelAudience,
  resolveChannelSessionFlags,
  resolveDaemonSessionFlags,
  resolveChannelResourceId,
} from "../src/shared/channel-types.js"
import {
  normalizeRuleScope,
  ruleAppliesTo,
} from "../src/shared/harness-rule-store.js"

describe("resolveChannelAudience", () => {
  it("p2p 主绑定 chat 归主", () => {
    expect(resolveChannelAudience({
      mainUserEnabled: true, mainUserChatId: "oc_main",
      chatKey: "ch_a|oc_main", chatType: "p2p", sessionKey: "ch_a|oc_main",
    })).toBe("main")
  })
  it("群聊归其他人", () => {
    expect(resolveChannelAudience({
      mainUserEnabled: true, mainUserChatId: "oc_main",
      chatKey: "ch_a|oc_group", chatType: "group", sessionKey: "ch_a|oc_group",
    })).toBe("others")
  })
  it("task/project/temp 归主", () => {
    expect(resolveChannelAudience({ sessionKey: "ch_a|oc_x::project_p1", chatType: "group" })).toBe("main")
    expect(resolveChannelAudience({ chatType: "task", sessionKey: "task_1" })).toBe("main")
    expect(resolveChannelAudience({ chatType: "temp", sessionKey: "temp_abc" })).toBe("main")
  })
})

describe("resolveChannelResourceId", () => {
  it("主用户用主资源", () => {
    expect(resolveChannelResourceId({ agentResourceId: "sdk_1", othersAgentResourceId: "llm_2" }, "main")).toBe("sdk_1")
  })
  it("其他人空值跟随主", () => {
    expect(resolveChannelResourceId({ agentResourceId: "sdk_1", othersAgentResourceId: "" }, "others")).toBe("sdk_1")
    expect(resolveChannelResourceId({ agentResourceId: "sdk_1" }, "others")).toBe("sdk_1")
  })
  it("其他人显式异源", () => {
    expect(resolveChannelResourceId({ agentResourceId: "sdk_1", othersAgentResourceId: "llm_2" }, "others")).toBe("llm_2")
  })
})

describe("resolveChannelSessionFlags", () => {
  it("主用户回退旧通道级字段", () => {
    expect(resolveChannelSessionFlags({ keepSession: false } as never, "main").keepSession).toBe(false)
  })
  it("其他人不回退旧字段，走独立默认值（保留开/长连接关/思考关）", () => {
    const f = resolveChannelSessionFlags({ keepSession: false, persistentPoll: true, showThinking: true } as never, "others")
    expect(f.keepSession).toBe(true)
    expect(f.persistentPoll).toBe(false)
    expect(f.showThinking).toBe(false)
  })
  it("daemon 其他人保活默认关", () => {
    expect(resolveDaemonSessionFlags({ keepAlive: true } as never, "others").keepAlive).toBe(false)
  })
})

describe("ruleAppliesTo", () => {
  it("缺省 scope 仅主用户生效", () => {
    expect(ruleAppliesTo({}, "ch_a", "main")).toBe(true)
    expect(ruleAppliesTo({}, "ch_a", "others")).toBe(false)
  })
  it("custom 按通道×人群多选", () => {
    const scope = normalizeRuleScope({
      mode: "custom",
      targets: [{ channelId: "ch_a", audiences: ["others"] }, { channelId: "ch_b", audiences: ["main", "others"] }],
    })
    expect(ruleAppliesTo({ scope }, "ch_a", "others")).toBe(true)
    expect(ruleAppliesTo({ scope }, "ch_a", "main")).toBe(false)
    expect(ruleAppliesTo({ scope }, "ch_b", "main")).toBe(true)
    expect(ruleAppliesTo({ scope }, "ch_c", "main")).toBe(false)
  })
  it("custom 空 targets 表示哪儿都不生效（仅存放）", () => {
    const scope = normalizeRuleScope({ mode: "custom", targets: [] })
    expect(scope).toEqual({ mode: "custom", targets: [] })
    expect(ruleAppliesTo({ scope }, "ch_a", "main")).toBe(false)
    expect(ruleAppliesTo({ scope }, "ch_a", "others")).toBe(false)
  })
})
