import { useEffect, type RefObject } from "react"

/**
 * 列表里「选中行」要滚多少才看得见（上负下正，0 = 已经看得见）。
 * view / row 都是屏幕坐标（getBoundingClientRect 的 top / bottom）。
 * inset：列表顶上被粘住的表头占掉的高度，行不能藏在它下面。
 * 行比可视区还高时，保证行的顶部先露出来。
 */
export function scrollDelta(view: { top: number; bottom: number }, row: { top: number; bottom: number }, inset = 0): number {
  const top = view.top + inset
  if (row.top < top) return row.top - top
  if (row.bottom > view.bottom) return Math.min(row.bottom - view.bottom, row.top - top)
  return 0
}

/**
 * 把 list 里 aria-current="true" 的行滚进可视区，只动这个列表自己的滚动条。
 * 不用 scrollIntoView：它会连祖先容器一起滚，还不认粘性表头（带 data-sticky-head 的元素）。
 */
export function scrollActiveIntoView(list: HTMLElement | null): void {
  const row = list?.querySelector<HTMLElement>('[aria-current="true"]')
  if (!list || !row) return
  const view = list.getBoundingClientRect()
  let inset = 0
  for (const head of list.querySelectorAll<HTMLElement>("[data-sticky-head]")) {
    const r = head.getBoundingClientRect()
    if (r.top <= view.top + 1 && r.bottom > view.top) inset = Math.max(inset, r.bottom - view.top)
  }
  const delta = scrollDelta(view, row.getBoundingClientRect(), inset)
  if (delta !== 0) list.scrollTop += delta
}

/**
 * 选中项变了、或列表长了一项（新建保存后）时，让选中行出现在可视区里。
 * 新增项追加在列表末尾，列表一长就在屏幕外；点已经看得见的行不会有任何滚动。
 */
export function useScrollActiveIntoView(listRef: RefObject<HTMLElement | null>, activeKey: string | null | undefined, count: number): void {
  useEffect(() => {
    scrollActiveIntoView(listRef.current)
  }, [listRef, activeKey, count])
}
