// ── 访客档：别人用机器人时，Agent 能碰哪些东西（纯逻辑：主进程各引擎共用，没有 node 依赖）──
//
// 其他人（私聊 / 群聊）的会话默认是「访客」：只能对话、联网查资料、给对方点选项，
// 碰不到本机的文件和命令，也看不到主人装的 MCP 和 Skill。「同我」档不受任何限制（升级前就开放过其他人的通道是这一档）。
// 想让访客多会点什么，在「额外开放」里点名：用户 MCP、Skill，默认一个都不开。
//
// 真正的限制有三处：工具白名单（SDK 的 tools / pi 的 excludeTools）、挂载哪些 MCP、名单里列哪些 Skill。
// 三处都由 resolveVisitorLimits 的结果决定，引擎只照着执行。

import type { MessageChannel } from "./channel-types.js"

/**
 * Cursor SDK 的 `tools` 白名单（SDK 的公共工具名）。只给「不碰本机」的几样：
 * - mcp：MCP 工具族。挂了哪些 MCP 服务器由 mcpAllow 和访客专用的内置端点决定，这里只是让它们能被调用；
 * - webSearch / webFetch / fetch：联网查资料、读网页；
 * - updateTodos / readTodos：任务清单（流式卡片上的进度）。
 * 不给：shell / read / edit / delete / grep / glob / ls（本机文件和命令）、task（子 Agent 有自己的工具集，会绕过这份白名单）、
 * generateImage、switchMode 等。
 */
export const VISITOR_SDK_BASE_TOOLS: readonly string[] = ["mcp", "webSearch", "webFetch", "fetch", "updateTodos", "readTodos"]

/** 开放了 Skill 时追加：AI 要读 Skill 目录里的 SKILL.md 才知道怎么做。注意它没法限制路径，等于能读本机任意文件 */
export const VISITOR_SDK_SKILL_TOOLS: readonly string[] = ["read"]

/** pi 引擎自带的本机工具（读写文件、执行命令、搜索）。pi 没有联网工具，访客在 pi 引擎里只剩对话和 MCP */
export const PI_LOCAL_TOOLS: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]

export interface VisitorLimits {
  /** Cursor SDK 的 tools 白名单 */
  sdkTools: string[]
  /** pi 引擎要关掉的自带工具 */
  piExcludeTools: string[]
  /** 能挂载的用户 MCP 服务器名；空 = 一个都不挂 */
  mcpAllow: string[]
  /** 能出现在 Skill 名单里的 Skill 名；空 = 不给名单 */
  skillAllow: string[]
  /** 访客会话是否能读本机文件（开放了 Skill 的代价）。提示词据此告诉 AI 它能做什么 */
  canRead: boolean
}

type LimitSource = Partial<Pick<MessageChannel, "visitorTier" | "visitorMcp" | "visitorSkills">>

function cleanNames(list: readonly unknown[] | undefined): string[] {
  const out: string[] = []
  for (const v of list ?? []) {
    const s = typeof v === "string" ? v.trim() : ""
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 这个会话要不要受限、受哪些限制。返回 undefined = 不受限（主人自己的会话，或其他人的档位是「同我」）。
 * 通道配置里没写档位时按「访客」算：宁可多限制一点，也不能因为字段缺失把全部权限给了别人
 * （配置读取时已经按存量补好默认值，走到这里还缺只会是残缺对象）。
 */
export function resolveVisitorLimits(
  channel: LimitSource | undefined,
  audience: "main" | "others",
): VisitorLimits | undefined {
  if (audience !== "others") return undefined
  if (channel?.visitorTier === "full") return undefined
  const skillAllow = cleanNames(channel?.visitorSkills)
  const canRead = skillAllow.length > 0
  return {
    sdkTools: [...VISITOR_SDK_BASE_TOOLS, ...(canRead ? VISITOR_SDK_SKILL_TOOLS : [])],
    piExcludeTools: PI_LOCAL_TOOLS.filter((t) => canRead ? t !== "read" : true),
    mcpAllow: cleanNames(channel?.visitorMcp),
    skillAllow,
    canRead,
  }
}

/** 限制的指纹：它变了，已经在跑的访客会话就得重启才会按新限制来 */
export function visitorLimitsKey(limits: VisitorLimits | undefined): string {
  if (!limits) return "full"
  return JSON.stringify([
    [...limits.sdkTools].sort(),
    [...limits.mcpAllow].sort(),
    [...limits.skillAllow].sort(),
  ])
}

/** 同一个通道在两份配置下，访客的限制是否相同（设置保存时据此决定要不要重启访客会话） */
export function sameVisitorLimits(a: LimitSource | undefined, b: LimitSource | undefined): boolean {
  return visitorLimitsKey(resolveVisitorLimits(a, "others")) === visitorLimitsKey(resolveVisitorLimits(b, "others"))
}

/** 用户 MCP 配置按白名单过滤；limits 缺省 = 不过滤 */
export function filterUserMcp<T>(servers: Record<string, T>, limits: Pick<VisitorLimits, "mcpAllow"> | undefined): Record<string, T> {
  if (!limits) return servers
  const allow = new Set(limits.mcpAllow)
  const out: Record<string, T> = {}
  for (const [name, cfg] of Object.entries(servers)) {
    if (allow.has(name)) out[name] = cfg
  }
  return out
}

/** 访客会话提示词里的一段：告诉 AI 它现在是什么身份、能做什么，免得它去调根本没有的工具再报错 */
export function buildVisitorPromptSection(limits: VisitorLimits): string {
  const can = ["回答问题、联网搜索、读网页", "用 send_question 给对方出点选项"]
  if (limits.canRead) can.push("读取被开放的 Skill 的说明文件，并按说明办事（不能执行脚本）")
  if (limits.mcpAllow.length > 0) can.push(`使用被开放的 MCP 工具（${limits.mcpAllow.join("、")}）`)
  const cannot = ["读写本机文件", "执行命令", "发送本机的图片或文件", "使用主人的其他工具和 Skill"]
  if (limits.canRead) cannot.splice(0, 1, "读取与 Skill 无关的本机文件")
  return [
    "# 访客会话（受限）",
    "你现在服务的是被开放使用的其他人，不是这台机器的主人。",
    `你可以：${can.join("；")}。`,
    `你不能：${cannot.join("；")}。`,
    "对方要你做不能做的事时，直接说明这个机器人暂时做不了，不要尝试绕过，也不要透露本机的目录、配置和账号信息。",
  ].join("\n")
}
