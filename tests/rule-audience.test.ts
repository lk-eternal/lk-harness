import { describe, it, expect } from "vitest"
import {
  resolveChannelAudience,
  resolveChannelSessionFlags,
  resolveDaemonSessionFlags,
  resolveChannelResourceId,
} from "../src/shared/channel-types.js"
import {
  normalizeRuleAudiences,
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

describe("规则的「其他人私聊 / 群聊」场景", () => {
  const scopeOf = (...audiences: ("main" | "others" | "dm" | "group")[]) =>
    normalizeRuleScope({ mode: "custom", targets: [{ channelId: "ch_a", audiences }] })

  it("normalizeRuleAudiences：others 已含私聊和群聊；私聊 + 群聊合起来就是 others（老版本也认得）", () => {
    expect(normalizeRuleAudiences(["dm", "group"])).toEqual(["others"])
    expect(normalizeRuleAudiences(["others", "dm"])).toEqual(["others"])
    expect(normalizeRuleAudiences(["main", "group", "dm"])).toEqual(["main", "others"])
    expect(normalizeRuleAudiences(["group"])).toEqual(["group"])
    expect(normalizeRuleAudiences(["dm", "dm", "main"])).toEqual(["main", "dm"])
    expect(normalizeRuleAudiences(["bogus", 3, null] as unknown[])).toEqual([])
    expect(normalizeRuleAudiences(undefined)).toEqual([])
  })

  it("只选「群聊」：群里生效，其他人私聊不生效", () => {
    const scope = scopeOf("group")
    expect(ruleAppliesTo({ scope }, "ch_a", "others", "group")).toBe(true)
    expect(ruleAppliesTo({ scope }, "ch_a", "others", "dm")).toBe(false)
    expect(ruleAppliesTo({ scope }, "ch_a", "main")).toBe(false)
  })

  it("只选「其他人私聊」：私聊生效，群里不生效", () => {
    const scope = scopeOf("dm")
    expect(ruleAppliesTo({ scope }, "ch_a", "others", "dm")).toBe(true)
    expect(ruleAppliesTo({ scope }, "ch_a", "others", "group")).toBe(false)
  })

  it("老的「其他人」(others)：私聊群聊都生效，行为和升级前一样", () => {
    const scope = scopeOf("others")
    expect(ruleAppliesTo({ scope }, "ch_a", "others")).toBe(true)
    expect(ruleAppliesTo({ scope }, "ch_a", "others", "dm")).toBe(true)
    expect(ruleAppliesTo({ scope }, "ch_a", "others", "group")).toBe(true)
  })

  it("拿不到聊天类型（scene 未知）：规则只要覆盖任一「其他人」场景就带上，宁多勿漏", () => {
    expect(ruleAppliesTo({ scope: scopeOf("group") }, "ch_a", "others")).toBe(true)
    expect(ruleAppliesTo({ scope: scopeOf("dm") }, "ch_a", "others")).toBe(true)
    expect(ruleAppliesTo({ scope: scopeOf("main") }, "ch_a", "others")).toBe(false)
  })

  it("「我」不受场景影响：只选 dm/group 的规则不会漏到主用户身上，选了 main 的照常生效", () => {
    expect(ruleAppliesTo({ scope: scopeOf("group", "dm") }, "ch_a", "main")).toBe(false)
    expect(ruleAppliesTo({ scope: scopeOf("main", "group") }, "ch_a", "main")).toBe(true)
    expect(ruleAppliesTo({ scope: scopeOf("main", "group") }, "ch_a", "others", "group")).toBe(true)
    expect(ruleAppliesTo({ scope: scopeOf("main", "group") }, "ch_a", "others", "dm")).toBe(false)
  })

  it("scope 里的 dm / group 经过归一化保存后不丢", () => {
    expect(normalizeRuleScope({ mode: "custom", targets: [{ channelId: "ch_a", audiences: ["group", "main"] }] }).targets)
      .toEqual([{ channelId: "ch_a", audiences: ["main", "group"] }])
  })
})
