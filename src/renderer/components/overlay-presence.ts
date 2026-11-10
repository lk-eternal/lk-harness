import { useEffect, useSyncExternalStore } from "react"

// 内置浏览器的网页视图是盖在界面之上的原生视图，界面里的弹层（确认框、图片查看器等）会被它挡住。
// 弹层出现时在这里登记，网页视图见到有弹层就先让位。

let count = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** 登记一个弹层，返回撤销函数 */
export function acquireOverlay(): () => void {
  count++
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    count--
    emit()
  }
}

/** 弹层组件挂载期间登记自己 */
export function useOverlayPresence(): void {
  useEffect(() => acquireOverlay(), [])
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 现在有没有界面弹层开着 */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, () => count > 0)
}
