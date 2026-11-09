/** 拖拽排序的纯逻辑：不依赖 DOM / React，便于单测。组件见 SortableList.tsx。 */

export type Snapshot = { id: string; midY: number }

export function reorderById<T>(items: T[], activeId: string, overId: string, getId: (t: T) => string): T[] {
  const from = items.findIndex((x) => getId(x) === activeId)
  const to = items.findIndex((x) => getId(x) === overId)
  if (from < 0 || to < 0 || from === to) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * 指针当前落在哪一行（按拖动开始时的行位置快照判断）。
 * 往下拖：取指针越过的行里最靠下的一行；往上拖：取越过的行里最靠上的一行。
 * 越过 = 往下时指针在该行中线以下，往上时指针在该行中线以上。
 */
export function resolveOverIndex(clientY: number, fromIdx: number, snaps: Snapshot[]): number {
  let toIdx = fromIdx
  for (let i = fromIdx + 1; i < snaps.length; i++) {
    if (clientY >= snaps[i].midY) toIdx = i
  }
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (clientY <= snaps[i].midY) toIdx = i
  }
  return toIdx
}

/**
 * 按 orderIds 给 items 排序。orderIds 里没有的项排在最后（保持原相对顺序），
 * orderIds 里有但 items 里已经没有的项忽略——列表在保存期间被别处增删时不会出错。
 */
export function applyOrder<T>(items: T[], orderIds: string[], getId: (t: T) => string): T[] {
  const rank = new Map<string, number>()
  orderIds.forEach((id, i) => rank.set(id, i))
  const known: T[] = []
  const extra: T[] = []
  for (const it of items) (rank.has(getId(it)) ? known : extra).push(it)
  known.sort((a, b) => (rank.get(getId(a)) as number) - (rank.get(getId(b)) as number))
  return [...known, ...extra]
}

/**
 * 记录「已松手、保存还没回来」的排序。
 * 可能连续拖多次，保存会有多个同时在途：显示始终按最近一次的顺序，等全部结束才撤掉。
 */
export function createReorderTracker() {
  let inflight = 0
  let order: string[] | null = null
  return {
    begin(ids: string[]): void {
      inflight++
      order = ids
    },
    /** 一次保存结束（成功或失败）。返回 true 表示已没有在途的保存，可以撤掉临时顺序。 */
    end(): boolean {
      inflight = Math.max(0, inflight - 1)
      if (inflight > 0) return false
      order = null
      return true
    },
    get order(): string[] | null {
      return order
    },
    get inflight(): number {
      return inflight
    },
  }
}
