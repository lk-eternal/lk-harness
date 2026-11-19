// 建项时「项目接入哪些消息通道、用什么方式」：能选什么、选得对不对。纯逻辑，桌面端对话框、AI（manage_project）、主进程共用。
//
// 规则：
// - 应用内通道的调用者是本机的管理员，可以把项目接到任何通道；飞书 / 微信通道的调用者只能接自己所在的通道
//   （集中部署时，某个通道的主用户不能把项目塞进别的通道）。
// - inline = 该通道的主聊天：应用内通道随时可用；飞书 / 微信要先绑定主用户（否则没有人能在那里用项目）。
// - group = 新建飞书独立群（要有主用户的飞书身份，用来设群主并拉进群）；bind = 绑定已有的飞书群（机器人要已经在群里）。

import type { ChannelType } from "./channel-types.js"
import type { ProjectBindingChoice, ProjectChannelOption } from "./project-app-types.js"
import { parseExistingGroupChatBinding, type ProjectChatMode } from "./project-types.js"

/** 规划需要知道的通道信息（从通道配置里取，不含密钥） */
export interface BindingChannelFacts {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  mainUserEnabled?: boolean
  /** 主用户的私聊 id（不含通道前缀）；空 = 还没绑定主用户 */
  mainUserChatId?: string
  /** 主用户的飞书 open_id（建独立群时设为群主）；没记到是空 */
  mainUserOpenId?: string
}

export const BINDING_MODE_LABEL: Record<ProjectChatMode, string> = {
  inline: "主聊天（不建群）",
  group: "新建独立群",
  bind: "绑定已有群",
}

function hasMainUser(c: BindingChannelFacts): boolean {
  return c.mainUserEnabled !== false && !!c.mainUserChatId?.trim()
}

/**
 * 这个通道上能用哪几种方式，以及暂时不能用的原因。
 * note 只写用户自己能处理的原因（没绑主用户、没记到飞书身份、通道停用）；通道本身固定的限制（微信不能建群）由 modes 体现，不写成文字。
 */
export function channelBindingModes(c: BindingChannelFacts): { modes: ProjectChatMode[]; note?: string } {
  if (!c.enabled) return { modes: [], note: "这个通道已停用" }
  if (c.type === "app") return { modes: ["inline"] }
  if (c.type === "wechat") {
    return hasMainUser(c)
      ? { modes: ["inline"] }
      : { modes: [], note: "这个微信通道还没绑定主用户，没有人能在里面用项目" }
  }
  const modes: ProjectChatMode[] = []
  const notes: string[] = []
  if (hasMainUser(c)) modes.push("inline")
  else notes.push("还没绑定主用户，不能接主聊天")
  if (hasMainUser(c) && c.mainUserOpenId?.trim()) modes.push("group")
  else notes.push("没有记录到主用户的飞书身份（open_id），不能新建独立群（可在设置里重新绑定主用户）")
  modes.push("bind")
  return { modes, ...(notes.length ? { note: notes.join("；") } : {}) }
}

/**
 * 宿主 RPC / 网关里传来的接入点列表 → ProjectBindingChoice[]（只认字符串字段，其余丢掉）。
 * 不在这里判断对错：mode 写错、通道不存在都原样带下去，由 planBindingChoices 给出带原因的报错。
 */
export function parseBindingChoices(raw: unknown): ProjectBindingChoice[] {
  if (!Array.isArray(raw)) return []
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((o) => ({
      channelId: str(o.channelId),
      mode: str(o.mode) as ProjectChatMode,
      ...(str(o.groupChatId) ? { groupChatId: str(o.groupChatId) } : {}),
    }))
}

/** 调用者能把项目接到哪些通道：应用内通道的调用者是全部，其余只有自己所在的 */
export function reachableChannels(channels: readonly BindingChannelFacts[], invokerChannelId?: string): BindingChannelFacts[] {
  const invoker = channels.find((c) => c.id === invokerChannelId)
  if (invoker?.type === "app") return [...channels]
  return invoker ? [invoker] : []
}

/** 建项对话框 / AI 看到的通道清单（含当前所在的通道、各自能用的方式） */
export function projectChannelOptions(channels: readonly BindingChannelFacts[], invokerChannelId?: string): ProjectChannelOption[] {
  return reachableChannels(channels, invokerChannelId).map((c) => {
    const { modes, note } = channelBindingModes(c)
    return { id: c.id, name: c.name, type: c.type, current: c.id === invokerChannelId, modes, ...(note ? { note } : {}) }
  })
}

/** 校验通过的一个接入点（已按通道定好的名字、群聊天键） */
export interface PlannedBinding {
  channel: BindingChannelFacts
  mode: ProjectChatMode
  /** bind：校验过的群聊天键（ch_xxx|oc_yyy）和原始群号 */
  groupChatKey?: string
  groupRawChatId?: string
}

/**
 * 校验调用者选的接入点。必须明确给出至少一个（没有默认值，AI 要去问用户）；
 * 任何一个不合法就整体拒绝，不会一半建一半不建。
 */
export function planBindingChoices(
  choices: readonly ProjectBindingChoice[] | undefined,
  channels: readonly BindingChannelFacts[],
  invokerChannelId?: string,
): { ok: true; items: PlannedBinding[] } | { ok: false; error: string } {
  if (!choices?.length) {
    return { ok: false, error: "还没有选项目接入哪些消息通道：先用 channels 看有哪些通道、各自能用什么方式，问用户选好后再把 bindings 填上" }
  }
  const reachable = reachableChannels(channels, invokerChannelId)
  const items: PlannedBinding[] = []
  const seen = new Set<string>()
  for (const raw of choices) {
    const channelId = String(raw?.channelId ?? "").trim()
    const mode = raw?.mode
    if (!channelId) return { ok: false, error: "bindings 里每一项都要给 channel_id" }
    if (mode !== "inline" && mode !== "group" && mode !== "bind") {
      return { ok: false, error: `bindings 的 mode 只能是 inline / group / bind，收到「${String(mode ?? "")}」` }
    }
    const channel = reachable.find((c) => c.id === channelId)
    if (!channel) {
      const exists = channels.some((c) => c.id === channelId)
      return {
        ok: false,
        error: exists
          ? `不能把项目接到通道 ${channelId}：你在${channels.find((c) => c.id === invokerChannelId)?.name ?? "当前"}通道里，只能接入自己所在的通道（应用内对话里才能选所有通道）`
          : `找不到通道 ${channelId}（用 channels 查看可选的通道）`,
      }
    }
    const { modes, note } = channelBindingModes(channel)
    if (!modes.includes(mode)) {
      const usable = modes.length ? `这个通道能用：${modes.join(" / ")}` : ""
      const reason = [note, usable].filter(Boolean).join("；")
      return { ok: false, error: `通道「${channel.name}」不能用 ${mode}（${BINDING_MODE_LABEL[mode]}）：${reason}` }
    }
    let groupChatKey: string | undefined
    let groupRawChatId: string | undefined
    if (mode === "bind") {
      const parsed = parseExistingGroupChatBinding(String(raw.groupChatId ?? ""), channel.id)
      if ("error" in parsed) return { ok: false, error: `通道「${channel.name}」：${parsed.error}` }
      groupChatKey = parsed.chatKey
      groupRawChatId = parsed.rawChatId
    }
    const key = mode === "bind" ? `bind:${groupChatKey}` : `${mode}:${channel.id}`
    if (seen.has(key)) return { ok: false, error: `通道「${channel.name}」的 ${mode} 选重了` }
    seen.add(key)
    items.push({ channel, mode, ...(groupChatKey ? { groupChatKey, groupRawChatId } : {}) })
  }
  return { ok: true, items }
}
