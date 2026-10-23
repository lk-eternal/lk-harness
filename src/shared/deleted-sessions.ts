// ── 刚删除的会话：界面侧的「墓碑」────────────────────────────────────────
// 删除会话后界面会马上刷新会话树，但刷新是异步的：删除发生前就发出的那次请求可能晚一步返回，
// 带着已删会话盖掉刚更新好的列表，要等下一轮轮询才消失（期间标题已被清掉，显示成「新会话」）。
// 删除成功后记一笔墓碑，刷新结果里命中墓碑的会话先不显示；服务端不再返回它，或超时，墓碑就撤掉。

import { appChatSessionId } from "./app-chat-types.js"

/** 归一后的会话标识 → 删除时间 */
export type DeletedSessions = Map<string, number>

/** 兜底：服务端迟迟不收敛时墓碑也不能一直压着，否则同一目录重新打开后会话永远不出现 */
export const DELETED_SESSION_TTL_MS = 30_000

export function markSessionDeleted(deleted: DeletedSessions, sessionKey: string, now = Date.now()): void {
  deleted.set(appChatSessionId(sessionKey), now)
}

/** 同一个会话键被重新打开（如再次添加同一目录）时撤掉墓碑 */
export function forgetDeletedSession(deleted: DeletedSessions, sessionKey: string): void {
  deleted.delete(appChatSessionId(sessionKey))
}

/**
 * 把命中墓碑的会话从各通道的 tabs 里去掉。会顺带清理 deleted：
 * 服务端已不再返回的（已收敛）和超时的墓碑直接撤掉。没有需要过滤的内容时原样返回同一个数组。
 */
export function hideDeletedTabs<V extends { tabs: { sessionKey: string }[] }>(
  views: V[],
  deleted: DeletedSessions,
  now = Date.now(),
): V[] {
  if (deleted.size === 0) return views
  const present = new Set(views.flatMap((v) => v.tabs.map((t) => appChatSessionId(t.sessionKey))))
  for (const [id, at] of [...deleted]) {
    if (now - at > DELETED_SESSION_TTL_MS || !present.has(id)) deleted.delete(id)
  }
  if (deleted.size === 0) return views
  return views.map((v) => {
    const tabs = v.tabs.filter((t) => !deleted.has(appChatSessionId(t.sessionKey)))
    return tabs.length === v.tabs.length ? v : { ...v, tabs }
  })
}
