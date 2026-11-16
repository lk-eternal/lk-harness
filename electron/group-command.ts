// ── /group allow | deny | ls：在飞书里开通 / 关闭群 ─────────────────
// 主用户在要开通的群里发 /group allow，这个群就能用机器人；不用回到设置页翻群 ID。
// 依赖全部注入，便于测试；真正的依赖在 daemon-manager 里接。

import { anyOthersEnabled, allowGroupPatch, denyGroupPatch, resolveChannelAccess, GROUP_POLICY_LABELS } from "../src/shared/channel-access"
import { makeChatKey, parseChatKey, type MessageChannel } from "../src/shared/channel-types"

export interface GroupCommandDeps {
  getChannel(id: string): MessageChannel | undefined
  updateChannel(id: string, patch: Partial<MessageChannel>): unknown
  /** 群的显示名（缓存里有就返回，没有就 undefined，名单里只记 chat_id） */
  lookupChatName(chatKey: string): string | undefined
  /** 项目专属群：本来就算「我」的，不进名单 */
  isProjectGroup(chatKey: string): boolean
  /** 名单变了：热推 daemon，清掉被关闭的群的运行会话和积压 */
  onChanged(channelId: string): Promise<void>
}

export interface GroupCommandInput {
  tokens: string[]
  chatId?: string
  chatType?: string
  /** 发指令的人是不是主用户（私聊管理员，或群里验过身份的主用户本人） */
  allowed: boolean
}

export interface GroupCommandResult {
  ok: boolean
  text: string
}

const USAGE = [
  "用法：",
  "· /group allow — 在群里发，开通本群",
  "· /group deny — 在群里发，关闭本群",
  "· /group ls — 查看已开通的群",
].join("\n")

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id
}

/** 一行说明当前群聊 / 私聊的开放情况（/group ls 和状态用） */
export function describeGroupAccess(channel: MessageChannel, nameOf: (chatId: string) => string | undefined): string {
  const access = resolveChannelAccess(channel)
  const lines = [
    `👥 群聊：${GROUP_POLICY_LABELS[access.groupPolicy]}`,
    `💬 其他人私聊：${access.dm ? "开放" : "不开放"}`,
  ]
  const listed = channel.allowedGroups ?? []
  if (access.groupPolicy === "all") {
    if (listed.length) lines.push(`（名单里还留着 ${listed.length} 个群，改回「${GROUP_POLICY_LABELS.allowlist}」后生效）`)
  } else if (listed.length === 0) {
    lines.push(access.groupPolicy === "allowlist" ? "还没有开通任何群：在群里发 /group allow 开通" : "要开通某个群：在群里发 /group allow")
  } else {
    lines.push(`已开通 ${listed.length} 个群：`)
    listed.forEach((g, i) => lines.push(`  ${i + 1}. ${g.name?.trim() || nameOf(g.chatId) || shortId(g.chatId)}`))
  }
  return lines.join("\n")
}

export async function runGroupCommand(input: GroupCommandInput, deps: GroupCommandDeps): Promise<GroupCommandResult> {
  if (!input.allowed) return { ok: false, text: "🔒 该指令仅管理员可用" }

  const { channelId, chatId: rawChatId } = parseChatKey(input.chatId ?? "")
  const channel = channelId ? deps.getChannel(channelId) : undefined
  if (!channel) return { ok: false, text: "❌ 找不到当前通道" }
  if (channel.type !== "feishu") return { ok: false, text: "❌ 这个通道没有群聊：微信（ClawBot）和应用内对话只能自己使用" }

  const sub = (input.tokens[1] ?? "").toLowerCase()
  const inGroup = input.chatType === "group" && !!rawChatId

  if (sub === "ls" || sub === "list" || sub === "") {
    const head = inGroup && sub === ""
      ? `${groupStatusLine(channel, input.chatId!, rawChatId, deps)}\n\n`
      : ""
    const nameOf = (id: string) => deps.lookupChatName(makeChatKey(channel.id, id))
    return { ok: true, text: `${head}${describeGroupAccess(channel, nameOf)}${sub === "" ? `\n\n${USAGE}` : ""}` }
  }

  if (sub !== "allow" && sub !== "deny") return { ok: false, text: `❌ 不认识的子命令「${input.tokens[1]}」\n${USAGE}` }
  if (!inGroup) return { ok: false, text: `❌ 请在要${sub === "allow" ? "开通" : "关闭"}的群里发送 /group ${sub}` }
  if (deps.isProjectGroup(input.chatId!)) return { ok: true, text: "✅ 这是项目专属群，本来就可以使用，不用开通" }

  const name = deps.lookupChatName(input.chatId!)

  if (sub === "allow") {
    const { patch, alreadyAdmitted, policyChanged } = allowGroupPatch(channel, rawChatId, name)
    const next = { ...channel, ...patch }
    deps.updateChannel(channel.id, { ...patch, allowOthers: anyOthersEnabled(next) })
    await deps.onChanged(channel.id)
    if (alreadyAdmitted && !policyChanged) {
      return { ok: true, text: "✅ 本群已经可以使用" }
    }
    return {
      ok: true,
      text: policyChanged
        ? `✅ 已开通本群，群聊策略改为「${GROUP_POLICY_LABELS.allowlist}」。现在群里 @我 就能用了`
        : "✅ 已开通本群。现在群里 @我 就能用了",
    }
  }

  const res = denyGroupPatch(channel, rawChatId)
  if (!res.ok) {
    return res.reason === "policy-all"
      ? { ok: false, text: `❌ 群聊策略是「${GROUP_POLICY_LABELS.all}」，没法单独关闭一个群。请到 设置 → 通道 把群聊改成「${GROUP_POLICY_LABELS.allowlist}」` }
      : { ok: false, text: "❌ 本群本来就没有开通" }
  }
  const next = { ...channel, ...res.patch }
  deps.updateChannel(channel.id, { ...res.patch, allowOthers: anyOthersEnabled(next) })
  await deps.onChanged(channel.id)
  return { ok: true, text: "✅ 已关闭本群，之后群里 @我 不会再有反应" }
}

function groupStatusLine(channel: MessageChannel, chatKey: string, rawChatId: string, deps: GroupCommandDeps): string {
  if (deps.isProjectGroup(chatKey)) return "📦 本群是项目专属群，可以使用"
  const access = resolveChannelAccess(channel)
  if (access.groupPolicy === "all") return "✅ 本群可以使用（群聊策略：所有群）"
  if (access.groupPolicy === "allowlist" && access.groups.includes(rawChatId)) return "✅ 本群已开通"
  return "⛔ 本群未开通：发 /group allow 开通"
}
