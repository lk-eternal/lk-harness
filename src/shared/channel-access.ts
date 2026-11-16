// ── 通道准入：谁、在什么场景能找机器人 ─────────────────────────
// Electron 主进程、Daemon、渲染进程共用，只放纯函数（没有 node / electron 依赖）。
//
// 模型：场景 = 我 / 其他人私聊 / 群聊。哪些场景存在由通道类型决定：
//   飞书：我、其他人私聊、群聊；微信（ClawBot 只能自己用）和应用内对话：只有我。
// 准入只管「其他人私聊」和「群聊」两件事；「我」（主用户私聊、定时任务、项目会话、项目专属群）永远放行。

import type { AllowedGroup, ChannelScene, ChannelType, GroupPolicy, MessageChannel, VisitorTier } from "./channel-types.js"

export const GROUP_POLICIES: readonly GroupPolicy[] = ["off", "allowlist", "all"]

export const GROUP_POLICY_LABELS: Record<GroupPolicy, string> = {
  off: "不允许",
  allowlist: "仅我开通的群",
  all: "所有群",
}

/** 这种通道有哪些场景。微信和应用内对话没有「其他人」，类型缺省按飞书（只有测试里的残缺对象会缺） */
export function channelScenes(type: ChannelType | undefined): ChannelScene[] {
  return type === "wechat" || type === "app" ? ["main"] : ["main", "dm", "group"]
}

/** 这种通道有没有「其他人」（私聊或群聊）这个概念 */
export function hasOthersScenes(type: ChannelType | undefined): boolean {
  return channelScenes(type).length > 1
}

/** 判断准入要用到的通道字段（MessageChannel 和 DaemonChannelConfig 都满足） */
export interface ChannelAccessFields {
  type?: ChannelType
  othersDm?: boolean
  groupPolicy?: GroupPolicy
  /** MessageChannel 存对象，Daemon 拿到的是原始 chat_id 数组，两种都认 */
  allowedGroups?: readonly (string | { chatId: string })[]
  /** 旧总开关：新字段都缺省时才看它（老配置 / 老 Daemon 快照） */
  allowOthers?: boolean
}

export interface ResolvedAccess {
  /** 其他人私聊是否放行 */
  dm: boolean
  groupPolicy: GroupPolicy
  /** 已开通的群（原始 chat_id，去重去空白） */
  groups: string[]
}

export function normalizeGroupPolicy(v: unknown): GroupPolicy | undefined {
  return v === "off" || v === "allowlist" || v === "all" ? v : undefined
}

function groupIds(list: ChannelAccessFields["allowedGroups"]): string[] {
  const out: string[] = []
  for (const g of list ?? []) {
    const id = (typeof g === "string" ? g : g?.chatId)?.trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 通道当前的准入配置。新字段优先；缺省时按旧 allowOthers 推（true = 私聊开 + 所有群，保持升级前的行为）。
 * 微信、应用内对话没有「其他人」，不管配置里写了什么都是全关。
 */
export function resolveChannelAccess(c: ChannelAccessFields | undefined): ResolvedAccess {
  if (!c || !hasOthersScenes(c.type)) return { dm: false, groupPolicy: "off", groups: [] }
  const legacy = c.allowOthers === true
  return {
    dm: c.othersDm ?? legacy,
    groupPolicy: normalizeGroupPolicy(c.groupPolicy) ?? (legacy ? "all" : "off"),
    groups: groupIds(c.allowedGroups),
  }
}

/** 通道配置里和「其他人」有关的全部字段，补齐默认值之后的样子 */
export interface ChannelAccessDefaults {
  /** 派生值：私聊或群聊任一开着。只为降级回旧版本时大致可用，新代码不要读它做判断 */
  allowOthers: boolean
  othersDm: boolean
  groupPolicy: GroupPolicy
  allowedGroups: AllowedGroup[]
  visitorTier: VisitorTier
  visitorMcp: string[]
  visitorSkills: string[]
}

export type ChannelAccessInput = Pick<MessageChannel, "type"> & Partial<Pick<MessageChannel,
  "allowOthers" | "othersDm" | "groupPolicy" | "allowedGroups" | "visitorTier" | "visitorMcp" | "visitorSkills">>

/**
 * 给（可能是旧版本留下的）通道配置补齐「其他人」相关字段：
 * - 旧 allowOthers=true（通道上没写就看全局那个）：其他人私聊开 + 所有群 + 能力档位「同我」——升级后行为一模一样；
 * - 旧 allowOthers=false：全关，之后新开放的其他人默认是「访客」；
 * - 微信、应用内对话没有「其他人」，一律全关。
 * config-store（读配置）和设置页（读到的是没补过的原始配置）共用，两边看到的值才一致。
 */
export function accessDefaultsFor(c: ChannelAccessInput, globalAllowOthers?: boolean): ChannelAccessDefaults {
  const legacyAllow = c.allowOthers ?? globalAllowOthers ?? false
  const access = resolveChannelAccess({ ...c, allowOthers: legacyAllow })
  return {
    allowOthers: access.dm || access.groupPolicy !== "off",
    othersDm: access.dm,
    groupPolicy: access.groupPolicy,
    allowedGroups: c.allowedGroups ?? [],
    visitorTier: c.visitorTier ?? (legacyAllow && hasOthersScenes(c.type) ? "full" : "visitor"),
    visitorMcp: c.visitorMcp ?? [],
    visitorSkills: c.visitorSkills ?? [],
  }
}

/** 两份通道配置的准入是否一样（群名单不看顺序）。设置保存时据此决定要不要清理已不被允许的会话 */
export function sameChannelAccess(a: ChannelAccessFields | undefined, b: ChannelAccessFields | undefined): boolean {
  const x = resolveChannelAccess(a)
  const y = resolveChannelAccess(b)
  return x.dm === y.dm
    && x.groupPolicy === y.groupPolicy
    && x.groups.length === y.groups.length
    && x.groups.every((g) => y.groups.includes(g))
}

/** 有没有对任何「其他人」开放（私聊或群聊） */
export function anyOthersEnabled(c: ChannelAccessFields | undefined): boolean {
  const a = resolveChannelAccess(c)
  return a.dm || a.groupPolicy !== "off"
}

export type AdmitDenyReason = "unsupported" | "dm-off" | "group-off" | "group-not-allowed"

export type AdmitResult = { ok: true } | { ok: false; reason: AdmitDenyReason }

/**
 * 这个场景的聊天能不能进来。
 * - main 永远放行；
 * - 微信 / 应用内没有其他场景：一律拒绝（unsupported）；
 * - dm：看「其他人私聊」开关；
 * - group：项目专属群（ownedGroup）算「我」的，永远放行；其余看群聊策略，allowlist 要在已开通名单里。
 */
export function admitChat(
  c: ChannelAccessFields | undefined,
  scene: ChannelScene,
  rawChatId?: string,
  opts?: { ownedGroup?: boolean },
): AdmitResult {
  if (scene === "main") return { ok: true }
  if (!c || !hasOthersScenes(c.type)) return { ok: false, reason: "unsupported" }
  const access = resolveChannelAccess(c)
  if (scene === "dm") return access.dm ? { ok: true } : { ok: false, reason: "dm-off" }
  if (opts?.ownedGroup) return { ok: true }
  if (access.groupPolicy === "off") return { ok: false, reason: "group-off" }
  if (access.groupPolicy === "all") return { ok: true }
  const id = rawChatId?.trim()
  return id && access.groups.includes(id) ? { ok: true } : { ok: false, reason: "group-not-allowed" }
}

/** 日志里写的拒绝原因 */
export function denyReasonText(reason: AdmitDenyReason): string {
  switch (reason) {
    case "unsupported": return "该通道没有「其他人」场景"
    case "dm-off": return "未开放其他人私聊"
    case "group-off": return "群聊策略为不允许"
    case "group-not-allowed": return "该群未开通"
  }
}

// ── /group allow | deny：改群名单 ──

/** 改群名单要用的通道字段（MessageChannel 满足：名单里是对象，带群名） */
export type GroupListSource = Omit<ChannelAccessFields, "allowedGroups"> & { allowedGroups?: readonly AllowedGroup[] }

export interface GroupPatch {
  groupPolicy: GroupPolicy
  allowedGroups: AllowedGroup[]
}

/**
 * 开通一个群。策略是「不允许」时顺带改成「仅我开通的群」（在群里发 allow 的意图就是让这个群能用）；
 * 策略已是「所有群」时群本来就能用，仍记进名单（以后改回「仅我开通的群」时保留）。
 */
export function allowGroupPatch(
  c: GroupListSource,
  chatId: string,
  name?: string,
  now: number = Date.now(),
): { patch: GroupPatch; alreadyAdmitted: boolean; policyChanged: boolean } {
  const access = resolveChannelAccess(c)
  const id = chatId.trim()
  const list = (c.allowedGroups ?? []).filter((g) => g?.chatId?.trim())
  const alreadyListed = list.some((g) => g.chatId.trim() === id)
  const next = alreadyListed
    ? list.map((g) => (g.chatId.trim() === id && name?.trim() ? { ...g, name: name.trim() } : g))
    : [...list, { chatId: id, ...(name?.trim() ? { name: name.trim() } : {}), addedAt: now }]
  const policy: GroupPolicy = access.groupPolicy === "off" ? "allowlist" : access.groupPolicy
  return {
    patch: { groupPolicy: policy, allowedGroups: next },
    alreadyAdmitted: access.groupPolicy === "all" || (access.groupPolicy === "allowlist" && alreadyListed),
    policyChanged: policy !== access.groupPolicy,
  }
}

export type DenyGroupResult =
  | { ok: true; patch: GroupPatch }
  | { ok: false; reason: "policy-all" | "not-listed" }

/** 关掉一个群：策略是「所有群」时没法单独关一个（要去设置里改策略）；不在名单里的没什么可关 */
export function denyGroupPatch(
  c: GroupListSource,
  chatId: string,
): DenyGroupResult {
  const access = resolveChannelAccess(c)
  if (access.groupPolicy === "all") return { ok: false, reason: "policy-all" }
  const id = chatId.trim()
  const list = (c.allowedGroups ?? []).filter((g) => g?.chatId?.trim())
  if (!list.some((g) => g.chatId.trim() === id)) return { ok: false, reason: "not-listed" }
  return { ok: true, patch: { groupPolicy: access.groupPolicy, allowedGroups: list.filter((g) => g.chatId.trim() !== id) } }
}

// ── 被拒绝的人：固定回复限频 ──

export const DENY_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 这个人此刻要不要再收一次「未开放」的回复：同一个 key 在窗口内只回一次。
 * sent 由调用方持有（Daemon 的内存表）；返回 true 时已把这一次记进去。
 * 顺带清理过期项，表不会一直涨。
 */
export function shouldSendDenyNotice(
  sent: Map<string, number>,
  key: string,
  now: number,
  windowMs: number = DENY_NOTICE_WINDOW_MS,
): boolean {
  if (sent.size > 500) {
    for (const [k, at] of sent) if (now - at >= windowMs) sent.delete(k)
  }
  const last = sent.get(key)
  if (last !== undefined && now - last < windowMs) return false
  sent.set(key, now)
  return true
}
