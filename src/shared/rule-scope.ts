// ── 规则的生效范围（纯逻辑：主进程存储 / 提示词装配 / 设置页共用，没有 node 依赖）──
//
// 存储模型：mode=main（仅主用户，含以后新建的通道）或 custom + 每个通道的人群列表。
// 设置页把它翻译成「勾选场景」：我 / 其他人私聊 / 群聊，勾了就对所有有这个场景的通道生效；
// 需要按通道区别对待时，再展开「只限某些通道」逐个选。

import { channelScenes } from "./channel-access.js"
import type { ChannelType } from "./channel-types.js"

/**
 * 规则对谁生效：main 我 / dm 其他人私聊 / group 群聊。
 * others 是私聊 + 群聊合起来的老写法（旧规则里的「其他人」），保存时 dm 和 group 都选了会归并成它，
 * 这样老版本读到新数据时「其他人」依然认得。
 */
export type RuleAudience = "main" | "others" | "dm" | "group"

export const RULE_AUDIENCE_ORDER: readonly RuleAudience[] = ["main", "others", "dm", "group"]

export interface RuleTarget {
  channelId: string
  audiences: RuleAudience[]
}

export interface RuleScope {
  mode: "main" | "custom"
  targets?: RuleTarget[]
}

/** 人群列表归一化：去掉不认识的值和重复；others 已含 dm / group；dm 和 group 都选了就是 others */
export function normalizeRuleAudiences(list: readonly unknown[] | undefined): RuleAudience[] {
  const set = new Set<RuleAudience>()
  for (const a of list ?? []) {
    if (a === "main" || a === "others" || a === "dm" || a === "group") set.add(a)
  }
  if (set.has("others")) {
    set.delete("dm")
    set.delete("group")
  } else if (set.has("dm") && set.has("group")) {
    set.delete("dm")
    set.delete("group")
    set.add("others")
  }
  return RULE_AUDIENCE_ORDER.filter((a) => set.has(a))
}

/** scope 归一化：缺省/非法视为仅主用户（存量与老备份的默认值）；
 * 显式 custom 即使 targets 为空也保留，表示"哪儿都不生效，仅存放" */
export function normalizeRuleScope(scope: RuleScope | undefined | null): RuleScope {
  if (!scope || scope.mode !== "custom") return { mode: "main" }
  const targets: RuleTarget[] = []
  for (const t of scope.targets ?? []) {
    const channelId = t?.channelId?.trim()
    if (!channelId) continue
    const audiences = normalizeRuleAudiences(t.audiences)
    if (!audiences.length) continue
    if (!targets.some((x) => x.channelId === channelId)) targets.push({ channelId, audiences })
  }
  return { mode: "custom", targets }
}

/**
 * 规则是否对指定通道×人群生效；channelId 缺失时仅 main 模式生效。
 * 其他人的会话可以再给 scene（私聊 / 群聊）：规则里只选了其中一个就只在那个场景生效。
 * 不给 scene（拿不到聊天类型）时，规则选了任意一个「其他人」场景都算生效——宁可多带一条规则，
 * 也不能让访客的会话漏掉规定对外身份、限制行为的规则。
 */
export function ruleScopeAppliesTo(
  rawScope: RuleScope | undefined | null,
  channelId: string | undefined,
  audience: "main" | "others",
  scene?: "dm" | "group",
): boolean {
  const scope = normalizeRuleScope(rawScope)
  if (scope.mode !== "custom") return audience === "main"
  if (!channelId) return false
  return (scope.targets ?? []).some((t) => {
    if (t.channelId !== channelId) return false
    if (audience === "main") return t.audiences.includes("main")
    if (t.audiences.includes("others")) return true
    if (scene === "dm") return t.audiences.includes("dm")
    if (scene === "group") return t.audiences.includes("group")
    return t.audiences.includes("dm") || t.audiences.includes("group")
  })
}

// ── 设置页：把范围翻译成「勾选的场景」 ───────────────────────

export type RuleScene = "main" | "dm" | "group"

export const RULE_SCENES: readonly RuleScene[] = ["main", "dm", "group"]

export const RULE_SCENE_LABELS: Record<RuleScene, string> = {
  main: "我",
  dm: "其他人私聊",
  group: "群聊",
}

export interface ScopeChannel {
  id: string
  type?: ChannelType
}

/** 一个通道的人群列表展开成场景（others = 私聊 + 群聊） */
export function audiencesToScenes(audiences: readonly RuleAudience[]): RuleScene[] {
  const set = new Set<RuleScene>()
  for (const a of audiences) {
    if (a === "main") set.add("main")
    else if (a === "dm") set.add("dm")
    else if (a === "group") set.add("group")
    else if (a === "others") { set.add("dm"); set.add("group") }
  }
  return RULE_SCENES.filter((s) => set.has(s))
}

/** 这个通道里，规则实际覆盖的场景（只算该通道有的场景：微信 / 应用内没有私聊和群聊） */
export function channelScopeScenes(scope: RuleScope, channel: ScopeChannel): RuleScene[] {
  const own = channelScenes(channel.type)
  if (scope.mode !== "custom") return own.filter((s) => s === "main")
  const target = (scope.targets ?? []).find((t) => t.channelId === channel.id)
  return audiencesToScenes(target?.audiences ?? []).filter((s) => own.includes(s))
}

/**
 * 范围能不能用「勾选的场景」统一表达：每个通道覆盖的场景，都等于「勾选的场景 ∩ 该通道有的场景」。
 * 能就返回勾选的场景（可以是空：哪儿都不生效）；不能（按通道区别对待过）返回 null。
 */
export function scopeToUniformScenes(rawScope: RuleScope | undefined | null, channels: readonly ScopeChannel[]): RuleScene[] | null {
  const scope = normalizeRuleScope(rawScope)
  if (scope.mode !== "custom") return ["main"]
  const union = new Set<RuleScene>()
  for (const c of channels) for (const s of channelScopeScenes(scope, c)) union.add(s)
  for (const c of channels) {
    const expected = channelScenes(c.type).filter((s) => union.has(s))
    const actual = channelScopeScenes(scope, c)
    if (expected.length !== actual.length || expected.some((s) => !actual.includes(s))) return null
  }
  return RULE_SCENES.filter((s) => union.has(s))
}

/** 所有通道里规则覆盖到的场景的并集（「改回统一设置」时用它当起点，尽量不丢已有的选择） */
export function scopeUnionScenes(rawScope: RuleScope | undefined | null, channels: readonly ScopeChannel[]): RuleScene[] {
  const scope = normalizeRuleScope(rawScope)
  const union = new Set<RuleScene>()
  for (const c of channels) for (const s of channelScopeScenes(scope, c)) union.add(s)
  return RULE_SCENES.filter((s) => union.has(s))
}

/**
 * 勾选的场景 → 存储的范围。只勾「我」存成 mode=main（含以后新建的通道）；
 * 其余对每个通道展开成它有的场景。
 */
export function scenesToScope(scenes: readonly RuleScene[], channels: readonly ScopeChannel[]): RuleScope {
  const set = new Set(scenes)
  if (set.size === 1 && set.has("main")) return { mode: "main" }
  const targets: RuleTarget[] = []
  for (const c of channels) {
    const audiences = normalizeRuleAudiences(channelScenes(c.type).filter((s) => set.has(s)))
    if (audiences.length) targets.push({ channelId: c.id, audiences })
  }
  return { mode: "custom", targets }
}

/** 规则列表里的一行小字：统一设置显示场景，按通道区别对待过显示「按通道自定义」 */
export function describeRuleScope(rawScope: RuleScope | undefined | null, channels: readonly ScopeChannel[]): string {
  const scenes = scopeToUniformScenes(rawScope, channels)
  if (!scenes) return "按通道自定义"
  if (scenes.length === 0) return "不生效"
  if (scenes.length === 1 && scenes[0] === "main") return "仅我"
  return scenes.map((s) => RULE_SCENE_LABELS[s]).join(" · ")
}
