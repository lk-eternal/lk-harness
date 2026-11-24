import { useState, type DragEvent, type Dispatch, type HTMLAttributes, type SetStateAction } from "react"
import type { PinPlacement } from "../../../shared/app-chat-pins"

/** 拖到一行的上半边放到它前面，下半边放到它后面 */
export function dropPlacement(offsetY: number, height: number): PinPlacement {
  return offsetY < height / 2 ? "before" : "after"
}

export interface Dragging { key: string; zone: string }
export interface DropOver { key: string; placement: PinPlacement }

/**
 * 这次拖动能不能落在这一行：只能落在同一类（同一个 zone，比如某通道的「项目」）里别的置顶会话上。
 * 拖到别的类里、拖到自己身上都不行。
 */
export function canDropOn(dragging: Dragging | null, zone: string, sessionKey: string): boolean {
  return dragging !== null && dragging.zone === zone && dragging.key !== sessionKey
}

export interface PinDragRow {
  /** 摊在行最外层 div 上；没置顶的行是空的（不能拖，也不能当落点） */
  props: HTMLAttributes<HTMLDivElement>
  /** 此刻松手会落在这一行的哪一边（画指示线）；这一行不是落点就是 undefined */
  dropAt: PinPlacement | undefined
  /** 这一行正在被拖着 */
  dragging: boolean
}

export interface PinDragState {
  dragging: Dragging | null
  over: DropOver | null
}

export interface PinDragActions {
  setDragging: Dispatch<SetStateAction<Dragging | null>>
  setOver: Dispatch<SetStateAction<DropOver | null>>
  move: (sessionKey: string, targetKey: string, placement: PinPlacement) => void
}

function placementAt(e: DragEvent<HTMLElement>): PinPlacement {
  const rect = e.currentTarget.getBoundingClientRect()
  return dropPlacement(e.clientY - rect.top, rect.height)
}

/** 一行会话怎么响应拖放；状态存在哪由调用方管（见 usePinDrag） */
export function pinDragRow(state: PinDragState, actions: PinDragActions, zone: string, sessionKey: string, pinned: boolean): PinDragRow {
  const { dragging, over } = state
  const row = { dropAt: over?.key === sessionKey ? over.placement : undefined, dragging: dragging?.key === sessionKey }
  if (!pinned) return { props: {}, ...row }

  const end = () => { actions.setDragging(null); actions.setOver(null) }
  return {
    ...row,
    props: {
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", sessionKey)
        // 晚一拍再改界面：浏览器在这个事件结束后才给被拖的行截图当拖动时跟着鼠标的影子，现在就把它变淡，影子也是淡的
        setTimeout(() => actions.setDragging({ key: sessionKey, zone }), 0)
      },
      onDragOver: (e) => {
        if (!canDropOn(dragging, zone, sessionKey)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        const placement = placementAt(e)
        if (over?.key !== sessionKey || over.placement !== placement) actions.setOver({ key: sessionKey, placement })
      },
      onDragLeave: (e) => {
        // 移进这一行里面的子元素也会触发，只有真的离开这一行才清掉指示线
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        actions.setOver((o) => (o?.key === sessionKey ? null : o))
      },
      onDrop: (e) => {
        if (dragging && canDropOn(dragging, zone, sessionKey)) {
          e.preventDefault()
          actions.move(dragging.key, sessionKey, placementAt(e))
        }
        end()
      },
      onDragEnd: end,
    },
  }
}

/**
 * 会话栏里置顶的会话可以拖动调整顺序（像飞书）：只有置顶的能拖，没置顶的仍按最近对话排；
 * 只能在同一类的置顶会话之间拖。用浏览器自带的拖放，松手时交给 move 去改。
 * 返回的函数每行调一次（不是 hook，可以在渲染行的函数里用）。
 */
export function usePinDrag(move: PinDragActions["move"]): (zone: string, sessionKey: string, pinned: boolean) => PinDragRow {
  const [dragging, setDragging] = useState<Dragging | null>(null)
  const [over, setOver] = useState<DropOver | null>(null)
  return (zone, sessionKey, pinned) => pinDragRow({ dragging, over }, { setDragging, setOver, move }, zone, sessionKey, pinned)
}
