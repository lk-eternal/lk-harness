import { chatIdFromSessionKey } from "../src/shared/channel-types"

let chatNameResolver: ((chatId: string) => string | undefined) | null = null
let chatNameStored: ((chatId: string) => string | undefined) | null = null
let chatNameFallback: ((chatId: string) => string | undefined) | null = null

export function setChatNameResolver(fn: (chatId: string) => string | undefined): void {
  chatNameResolver = fn
}

/** 落盘的名字（重启后内存缓存还是空的时候用）：排在本次运行查到的名字之后 */
export function setChatNameStored(fn: (chatId: string) => string | undefined): void {
  chatNameStored = fn
}

export function setChatNameFallback(fn: (chatId: string) => string | undefined): void {
  chatNameFallback = fn
}

/**
 * 只认真查到过的名字：本次运行里按 chatId / senderOpenId 查到的，其次是落盘记着的。
 * 查不到返回 undefined，不编兜底名——调用方（比如会话清单）自己决定查不到时怎么显示。
 */
export function lookupChatName(sessionKey: string, senderOpenId?: string): string | undefined {
  const chatId = chatIdFromSessionKey(sessionKey)
  return chatNameResolver?.(chatId)
    || (senderOpenId ? chatNameResolver?.(senderOpenId) : undefined)
    || chatNameStored?.(chatId)
}

/** 广播时实时解析会话名：优先用会话自带名，否则按 chatId / senderOpenId 查缓存，最后走兜底名 */
export function resolveSessionChatName(sessionKey: string, chatName?: string, senderOpenId?: string): string | undefined {
  if (chatName) return chatName
  return lookupChatName(sessionKey, senderOpenId) || chatNameFallback?.(chatIdFromSessionKey(sessionKey))
}
