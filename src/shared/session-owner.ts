import { channelIdFromSessionKey, makeChatKey } from "./channel-types.js"

/** 解析会话归属时只用得到的通道字段 */
export interface OwnerChannel {
  id: string
  mainUserEnabled?: boolean
  mainUserChatId?: string
}

export type ManageChatResolution =
  | { ok: true; chatId: string; channelId: string }
  | { ok: false; error: string }

/**
 * 管理一个会话（激活 / 删除）时，该用哪个通道、哪个主用户聊天的口径。
 *
 * 以前界面发来的只有会话键，主进程一律取「第一个绑了主用户的通道」，
 * 有多个通道时，给第 2 个及以后的通道里的会话点「激活」，会把第一个通道的当前会话指针指到别的通道的会话上；
 * 删除时「主会话不可删」的判断和回落主会话也是按第一个通道算的。
 *
 * 现在按会话自己所属的通道来：
 * - 会话键带通道前缀（`ch_xxx|chat::dir`）：用该前缀的通道，不回退到别的通道；
 * - 旧格式没有前缀：看会话记录里存的聊天键；
 * - 仍然看不出来：只有一个通道绑了主用户时才能确定是它，有多个就报错，不再猜「第一个」。
 *
 * channels 传已启用的通道；recordChatId 是会话记录里存的聊天键（没有就不传）。
 */
export function resolveManageChatId(
  sessionKey: string,
  channels: readonly OwnerChannel[],
  recordChatId?: string,
): ManageChatResolution {
  const mainChatKey = (c: OwnerChannel): string | undefined => {
    const raw = c.mainUserEnabled ? c.mainUserChatId?.trim() : ""
    return raw ? makeChatKey(c.id, raw) : undefined
  }

  const ownerId = channelIdFromSessionKey(sessionKey) ?? (recordChatId ? channelIdFromSessionKey(recordChatId) : undefined)
  if (ownerId) {
    const channel = channels.find((c) => c.id === ownerId)
    if (!channel) return { ok: false, error: "会话所属的通道不存在或已停用" }
    const chatId = mainChatKey(channel)
    if (!chatId) return { ok: false, error: "该会话所属的通道没有绑定主用户" }
    return { ok: true, chatId, channelId: channel.id }
  }

  const bound = channels.filter((c) => mainChatKey(c))
  if (bound.length === 1) {
    return { ok: true, chatId: mainChatKey(bound[0])!, channelId: bound[0].id }
  }
  if (bound.length === 0) return { ok: false, error: "未绑定主用户" }
  return { ok: false, error: "无法确定会话所属的通道" }
}
