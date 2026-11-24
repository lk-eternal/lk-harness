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

/**
 * 置顶 / 取消置顶：返回新列表；已经是目标状态时原样返回同一个数组（调用方据此省掉写盘和刷新）。
 * 列表的顺序就是置顶的会话在会话栏里从上到下的顺序，新置顶的放在最前面。
 */
export function setSessionPinned(ids: readonly string[], sessionKey: string, pinned: boolean): readonly string[] {
  const id = appChatSessionId(sessionKey)
  const has = ids.includes(id)
  if (pinned === has) return ids
  return pinned ? [id, ...ids] : ids.filter((x) => x !== id)
}

export type PinPlacement = "before" | "after"

export function parsePinPlacement(raw: unknown): PinPlacement | undefined {
  return raw === "before" || raw === "after" ? raw : undefined
}

/**
 * 拖动调整置顶的顺序：把 sessionKey 挪到 targetKey 的前面 / 后面。
 * 有一个不在置顶列表里、是同一个会话、或者挪完顺序没变：原样返回同一个数组（调用方据此省掉写盘和刷新）。
 * 列表里还有别的分类、别的通道的置顶，这里只管这两个会话的相对位置，其余的相对顺序不变。
 */
export function movePinned(ids: readonly string[], sessionKey: string, targetKey: string, placement: PinPlacement): readonly string[] {
  const id = appChatSessionId(sessionKey)
  const target = appChatSessionId(targetKey)
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids
  const rest = ids.filter((x) => x !== id)
  const at = rest.indexOf(target) + (placement === "after" ? 1 : 0)
  const next = [...rest.slice(0, at), id, ...rest.slice(at)]
  return next.every((x, i) => x === ids[i]) ? ids : next
}

/** 置顶的排到最前面，按置顶列表里的顺序；其余的保持原来的顺序（比如按最近对话排好的） */
export function pinFirst<T extends { sessionKey: string }>(tabs: readonly T[], ids: readonly string[]): T[] {
  if (ids.length === 0) return [...tabs]
  const rank = new Map(ids.map((id, i) => [id, i]))
  const pinned: { tab: T; rank: number }[] = []
  const rest: T[] = []
  for (const tab of tabs) {
    const r = rank.get(appChatSessionId(tab.sessionKey))
    if (r === undefined) rest.push(tab)
    else pinned.push({ tab, rank: r })
  }
  return [...pinned.sort((a, b) => a.rank - b.rank).map((p) => p.tab), ...rest]
}
