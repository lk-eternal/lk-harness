/** 拖拽排序的纯逻辑：不依赖 DOM / React，便于单测。组件见 SortableList.tsx。 */

/** 拖动开始时一行的位置（视口坐标）和高度 */
export type Snapshot = { id: string; top: number; height: number }

export function reorderById<T>(items: T[], activeId: string, overId: string, getId: (t: T) => string): T[] {
  const from = items.findIndex((x) => getId(x) === activeId)
  const to = items.findIndex((x) => getId(x) === overId)
  if (from < 0 || to < 0 || from === to) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

const midY = (s: Snapshot): number => s.top + s.height / 2

/**
 * 指针当前落在哪一行（按拖动开始时的行位置快照判断）。
 * 往下拖：取指针越过的行里最靠下的一行；往上拖：取越过的行里最靠上的一行。
 * 越过 = 往下时指针在该行中线以下，往上时指针在该行中线以上。
 */
export function resolveOverIndex(clientY: number, fromIdx: number, snaps: Snapshot[]): number {
  let toIdx = fromIdx
  for (let i = fromIdx + 1; i < snaps.length; i++) {
    if (clientY >= midY(snaps[i])) toIdx = i
  }
  for (let i = fromIdx - 1; i >= 0; i--) {
    if (clientY <= midY(snaps[i])) toIdx = i
  }
  return toIdx
}

/**
 * 把 activeId 那一行拖到 overId 那一行的位置时，每一行要从原位置挪多远（纵向，正数往下）。
 * 拖动中列表本身不换顺序，各行用这个位移滑到新位置；位移为 0 的行不在结果里。
 * 行距按前两行推出来；各行高度可以不同。
 */
export function slideOffsets(snaps: Snapshot[], activeId: string, overId: string): Map<string, number> {
  const offsets = new Map<string, number>()
  const moved = reorderById(snaps, activeId, overId, (s) => s.id)
  if (moved === snaps) return offsets
  const gap = snaps[1].top - snaps[0].top - snaps[0].height
  let top = snaps[0].top
  for (const s of moved) {
    if (top !== s.top) offsets.set(s.id, top - s.top)
    top += s.height + gap
  }
  return offsets
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
