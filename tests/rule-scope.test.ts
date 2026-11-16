import { describe, expect, it } from "vitest"
import {
  audiencesToScenes,
  describeRuleScope,
  normalizeRuleAudiences,
  normalizeRuleScope,
  ruleScopeAppliesTo,
  scenesToScope,
  scopeToUniformScenes,
  scopeUnionScenes,
  type RuleScope,
} from "../src/shared/rule-scope"
import { accessDefaultsFor } from "../src/shared/channel-access"

const FS1 = { id: "ch_fs1", type: "feishu" as const }
const FS2 = { id: "ch_fs2", type: "feishu" as const }
const WX = { id: "ch_wx", type: "wechat" as const }
const APP = { id: "ch_app", type: "app" as const }
const ALL = [FS1, FS2, WX, APP]

describe("normalizeRuleAudiences", () => {
  it("私聊 + 群聊 归并成 others；others 吞掉 dm / group", () => {
    expect(normalizeRuleAudiences(["dm", "group"])).toEqual(["others"])
    expect(normalizeRuleAudiences(["others", "dm"])).toEqual(["others"])
    expect(normalizeRuleAudiences(["main", "dm", "group"])).toEqual(["main", "others"])
  })
  it("只选一边时保持原样，去重去脏值", () => {
    expect(normalizeRuleAudiences(["group", "group"])).toEqual(["group"])
    expect(normalizeRuleAudiences(["dm", "bogus", 1, null])).toEqual(["dm"])
    expect(normalizeRuleAudiences(undefined)).toEqual([])
  })
})

describe("ruleScopeAppliesTo：场景感知", () => {
  const dmOnly: RuleScope = { mode: "custom", targets: [{ channelId: "ch_fs1", audiences: ["dm"] }] }
  const groupOnly: RuleScope = { mode: "custom", targets: [{ channelId: "ch_fs1", audiences: ["group"] }] }
  const legacyOthers: RuleScope = { mode: "custom", targets: [{ channelId: "ch_fs1", audiences: ["others"] }] }

  it("缺省 / main 模式只对 main 生效", () => {
    expect(ruleScopeAppliesTo(undefined, "ch_fs1", "main")).toBe(true)
    expect(ruleScopeAppliesTo(undefined, "ch_fs1", "others", "dm")).toBe(false)
    expect(ruleScopeAppliesTo({ mode: "main" }, undefined, "main")).toBe(true)
  })
  it("只选私聊：私聊生效，群聊不生效", () => {
    expect(ruleScopeAppliesTo(dmOnly, "ch_fs1", "others", "dm")).toBe(true)
    expect(ruleScopeAppliesTo(dmOnly, "ch_fs1", "others", "group")).toBe(false)
    expect(ruleScopeAppliesTo(dmOnly, "ch_fs1", "main")).toBe(false)
  })
  it("只选群聊：群聊生效，私聊不生效", () => {
    expect(ruleScopeAppliesTo(groupOnly, "ch_fs1", "others", "group")).toBe(true)
    expect(ruleScopeAppliesTo(groupOnly, "ch_fs1", "others", "dm")).toBe(false)
  })
  it("老数据的 others 两个场景都生效", () => {
    expect(ruleScopeAppliesTo(legacyOthers, "ch_fs1", "others", "dm")).toBe(true)
    expect(ruleScopeAppliesTo(legacyOthers, "ch_fs1", "others", "group")).toBe(true)
    expect(ruleScopeAppliesTo(legacyOthers, "ch_fs1", "others")).toBe(true)
  })
  it("拿不到场景时：只要覆盖了任一其他人场景就算生效（宁多勿漏）", () => {
    expect(ruleScopeAppliesTo(dmOnly, "ch_fs1", "others")).toBe(true)
    expect(ruleScopeAppliesTo(groupOnly, "ch_fs1", "others")).toBe(true)
    expect(ruleScopeAppliesTo({ mode: "custom", targets: [{ channelId: "ch_fs1", audiences: ["main"] }] }, "ch_fs1", "others")).toBe(false)
  })
  it("别的通道不受影响", () => {
    expect(ruleScopeAppliesTo(dmOnly, "ch_fs2", "others", "dm")).toBe(false)
    expect(ruleScopeAppliesTo(dmOnly, undefined, "others", "dm")).toBe(false)
  })
})

describe("scenesToScope / scopeToUniformScenes：设置页勾选 ↔ 存储", () => {
  it("只勾「我」存成 mode=main（含以后新建的通道）", () => {
    expect(scenesToScope(["main"], ALL)).toEqual({ mode: "main" })
    expect(scopeToUniformScenes({ mode: "main" }, ALL)).toEqual(["main"])
  })
  it("勾私聊：只落在有私聊的通道（飞书），微信 / 应用内不出现", () => {
    const scope = scenesToScope(["dm"], ALL)
    expect(scope).toEqual({
      mode: "custom",
      targets: [
        { channelId: "ch_fs1", audiences: ["dm"] },
        { channelId: "ch_fs2", audiences: ["dm"] },
      ],
    })
    expect(scopeToUniformScenes(scope, ALL)).toEqual(["dm"])
  })
  it("我 + 私聊 + 群聊：飞书存 main + others，微信 / 应用内只存 main", () => {
    const scope = scenesToScope(["main", "dm", "group"], ALL)
    expect(scope.targets).toEqual([
      { channelId: "ch_fs1", audiences: ["main", "others"] },
      { channelId: "ch_fs2", audiences: ["main", "others"] },
      { channelId: "ch_wx", audiences: ["main"] },
      { channelId: "ch_app", audiences: ["main"] },
    ])
    expect(scopeToUniformScenes(scope, ALL)).toEqual(["main", "dm", "group"])
  })
  it("勾选全部取消：存成 custom 空目标（哪儿都不生效），仍可用统一设置表达", () => {
    const scope = scenesToScope([], ALL)
    expect(scope).toEqual({ mode: "custom", targets: [] })
    expect(scopeToUniformScenes(scope, ALL)).toEqual([])
  })
  it("按通道区别对待过的范围无法统一表达", () => {
    const scope: RuleScope = {
      mode: "custom",
      targets: [
        { channelId: "ch_fs1", audiences: ["main", "dm"] },
        { channelId: "ch_fs2", audiences: ["main"] },
      ],
    }
    expect(scopeToUniformScenes(scope, ALL)).toBeNull()
    expect(describeRuleScope(scope, ALL)).toBe("按通道自定义")
  })
  it("老数据：只有飞书选了 others、其他通道没选 → 视为统一的「私聊 + 群聊」", () => {
    const scope: RuleScope = {
      mode: "custom",
      targets: [
        { channelId: "ch_fs1", audiences: ["others"] },
        { channelId: "ch_fs2", audiences: ["others"] },
      ],
    }
    expect(scopeToUniformScenes(scope, ALL)).toEqual(["dm", "group"])
  })
  it("来回转换稳定：统一设置 → 存储 → 统一设置", () => {
    const combos: Array<Array<"main" | "dm" | "group">> = [["main"], ["dm"], ["group"], ["main", "dm"], ["main", "group"], ["dm", "group"], ["main", "dm", "group"]]
    for (const scenes of combos) {
      const back = scopeToUniformScenes(scenesToScope(scenes, ALL), ALL)
      expect(back, scenes.join("+")).toEqual(scenes)
    }
  })
  it("只有微信 / 应用内通道时，勾私聊不会生成任何目标", () => {
    expect(scenesToScope(["dm", "group"], [WX, APP])).toEqual({ mode: "custom", targets: [] })
  })
})

describe("scopeUnionScenes / describeRuleScope", () => {
  it("并集：所有通道里覆盖到的场景", () => {
    const scope: RuleScope = {
      mode: "custom",
      targets: [
        { channelId: "ch_fs1", audiences: ["main", "dm"] },
        { channelId: "ch_fs2", audiences: ["group"] },
        { channelId: "ch_wx", audiences: ["main"] },
      ],
    }
    expect(scopeUnionScenes(scope, ALL)).toEqual(["main", "dm", "group"])
    expect(scopeUnionScenes({ mode: "main" }, ALL)).toEqual(["main"])
  })
  it("规则列表小字", () => {
    expect(describeRuleScope(undefined, ALL)).toBe("仅我")
    expect(describeRuleScope({ mode: "custom", targets: [] }, ALL)).toBe("不生效")
    expect(describeRuleScope(scenesToScope(["main", "dm"], ALL), ALL)).toBe("我 · 其他人私聊")
    expect(describeRuleScope(scenesToScope(["group"], ALL), ALL)).toBe("群聊")
  })
  it("audiencesToScenes：others 展开成私聊 + 群聊", () => {
    expect(audiencesToScenes(["main", "others"])).toEqual(["main", "dm", "group"])
    expect(audiencesToScenes(["group"])).toEqual(["group"])
  })
  it("normalizeRuleScope：未知模式视为仅我", () => {
    expect(normalizeRuleScope({ mode: "weird" } as unknown as RuleScope)).toEqual({ mode: "main" })
    expect(normalizeRuleScope(null)).toEqual({ mode: "main" })
  })
})

describe("accessDefaultsFor：存量迁移与默认值", () => {
  it("旧 allowOthers=true：私聊开 + 所有群 + 同我（升级后行为不变）", () => {
    const d = accessDefaultsFor({ type: "feishu", allowOthers: true })
    expect(d).toMatchObject({ allowOthers: true, othersDm: true, groupPolicy: "all", visitorTier: "full" })
  })
  it("旧 allowOthers=false / 全新通道：全关，之后开放的默认是访客", () => {
    const d = accessDefaultsFor({ type: "feishu" })
    expect(d).toMatchObject({ allowOthers: false, othersDm: false, groupPolicy: "off", visitorTier: "visitor", allowedGroups: [], visitorMcp: [], visitorSkills: [] })
  })
  it("通道上没写就看全局开关", () => {
    expect(accessDefaultsFor({ type: "feishu" }, true)).toMatchObject({ othersDm: true, groupPolicy: "all", visitorTier: "full" })
    expect(accessDefaultsFor({ type: "feishu", allowOthers: false }, true)).toMatchObject({ othersDm: false, groupPolicy: "off" })
  })
  it("微信 / 应用内：无论旧配置写了什么都是全关", () => {
    for (const type of ["wechat", "app"] as const) {
      const d = accessDefaultsFor({ type, allowOthers: true })
      expect(d).toMatchObject({ allowOthers: false, othersDm: false, groupPolicy: "off", visitorTier: "visitor" })
    }
  })
  it("已经写了新字段的通道不会被覆盖", () => {
    const d = accessDefaultsFor({
      type: "feishu",
      allowOthers: true, // 旧字段是 true，但新字段明确说私聊关、仅开通的群
      othersDm: false,
      groupPolicy: "allowlist",
      allowedGroups: [{ chatId: "oc_a" }],
      visitorTier: "visitor",
      visitorMcp: ["m1"],
      visitorSkills: ["s1"],
    })
    expect(d).toMatchObject({
      allowOthers: true, // 派生值：群聊开着
      othersDm: false,
      groupPolicy: "allowlist",
      visitorTier: "visitor",
      visitorMcp: ["m1"],
      visitorSkills: ["s1"],
    })
    expect(d.allowedGroups).toEqual([{ chatId: "oc_a" }])
  })
  it("派生的 allowOthers：私聊和群聊都关时为 false", () => {
    expect(accessDefaultsFor({ type: "feishu", othersDm: false, groupPolicy: "off" }).allowOthers).toBe(false)
    expect(accessDefaultsFor({ type: "feishu", othersDm: true, groupPolicy: "off" }).allowOthers).toBe(true)
  })
})
