// ── 会话列表里的「已归档」分组（对话页侧栏、手机端会话抽屉共用，纯逻辑） ─────────────
// 归档目前只有项目会话有：做完的项目用户自己归档，会话和成果都还在，只是收进列表最下面一个折叠分组。
// 没有归档的会话时不出现这个分组，列表保持原样。

export const ARCHIVED_GROUP_TITLE = "已归档"

interface Archivable {
  archived?: boolean
}

/** 把会话分成正常的和已归档的，各自保持原来的顺序 */
export function splitArchived<T extends Archivable>(tabs: readonly T[]): { live: T[]; archived: T[] } {
  const live: T[] = []
  const archived: T[] = []
  for (const t of tabs) (t.archived ? archived : live).push(t)
  return { live, archived }
}

/**
 * 没有选中会话（首次进入、选中的被删了）时默认进哪个：优先通道当前会话，没有就取第一个，
 * 但都先在没归档的里挑；全是归档的才退而求其次，不能让用户一进来就落在收起来的会话上。
 */
export function pickDefaultTab<T extends Archivable & { sessionKey: string }>(
  tabs: readonly T[],
  activeKey: string | undefined,
  same: (a: string, b: string | undefined) => boolean,
): T | undefined {
  const { live } = splitArchived(tabs)
  const pool = live.length > 0 ? live : tabs
  return pool.find((t) => same(t.sessionKey, activeKey)) ?? pool[0]
}
