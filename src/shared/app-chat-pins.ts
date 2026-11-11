// ── 应用内对话：置顶的会话 ───────────────────────────────────────────
// 置顶状态存在电脑端（主进程，见 electron/app-chat-pins.ts），桌面端对话页和手机端会话抽屉
// 都读它、改它，所以两端看到的是同一份。这里放两端共用的纯规则：怎么认、怎么改、怎么排。
// 存的是 appChatSessionId（路径分隔符、大小写归一后的会话标识），同一个会话不管怎么写都认得出。

import { appChatSessionId } from "./app-chat-types.js"

/**
 * 把读到的东西整理成置顶列表。没存过、格式不对（比如旧版电脑端根本没这个字段）都当作没有置顶；
 * 里面混进不是字符串、空字符串的丢掉，重复的只留一个。
 */
export function parsePinnedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((x): x is string => typeof x === "string" && x !== ""))]
}

/** 这个会话在不在置顶列表里 */
export function isSessionPinned(ids: readonly string[], sessionKey: string): boolean {
  return ids.includes(appChatSessionId(sessionKey))
}

/** 置顶 / 取消置顶：返回新列表；已经是目标状态时原样返回同一个数组（调用方据此省掉写盘和刷新） */
export function setSessionPinned(ids: readonly string[], sessionKey: string, pinned: boolean): readonly string[] {
  const id = appChatSessionId(sessionKey)
  const has = ids.includes(id)
  if (pinned === has) return ids
  return pinned ? [...ids, id] : ids.filter((x) => x !== id)
}

/** 置顶的排到最前面；两组内部各自保持原来的顺序（比如按最近对话排好的） */
export function pinFirst<T extends { sessionKey: string }>(tabs: readonly T[], ids: readonly string[]): T[] {
  if (ids.length === 0) return [...tabs]
  const pinned = new Set(ids)
  const isPinned = (t: T) => pinned.has(appChatSessionId(t.sessionKey))
  return [...tabs.filter(isPinned), ...tabs.filter((t) => !isPinned(t))]
}
