import { chatIdFromSessionKey } from "../src/shared/channel-types"

let chatNameResolver: ((chatId: string) => string | undefined) | null = null
let chatNameFallback: ((chatId: string) => string | undefined) | null = null

export function setChatNameResolver(fn: (chatId: string) => string | undefined): void {
  chatNameResolver = fn
}

export function setChatNameFallback(fn: (chatId: string) => string | undefined): void {
  chatNameFallback = fn
}

/** 广播时实时解析会话名：优先用会话自带名，否则按 chatId / senderOpenId 查缓存，最后走兜底名 */
export function resolveSessionChatName(sessionKey: string, chatName?: string, senderOpenId?: string): string | undefined {
  if (chatName) return chatName
  const chatId = chatIdFromSessionKey(sessionKey)
  return chatNameResolver?.(chatId)
    || (senderOpenId ? chatNameResolver?.(senderOpenId) : undefined)
    || chatNameFallback?.(chatId)
}
