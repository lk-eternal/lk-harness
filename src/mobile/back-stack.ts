import { useEffect, useRef } from "react"

/**
 * 返回键 / 返回手势关浮层。
 * 浏览器（含手机浏览器）的返回手势会走 history：返回 → popstate → 关最上面一个浮层。
 * APK 里不一样：Capacitor 的原生壳本身不处理返回键（没有「有历史就后退」），按返回会直接退出应用，
 * 要由 native-back.ts 接管返回键、调用这里的 closeTopOverlay 才能关浮层。
 *
 * 每个打开的浮层对应一条 history 记录：返回 → popstate → 关最上面一个；
 * 浮层被按钮等方式关掉时，把多出来的记录退回去，没有浮层时按返回仍是原来的行为（退出应用）。
 * 开关不直接操作 history，而是登记到 stack，再在微任务里让「已压入的记录数」追平「打开的浮层数」：
 * 同一次提交里一个关、一个开（抽屉 → 配对弹窗）正好抵消，不会出现异步 back 与 pushState 抢跑。
 */
interface Entry {
  close: () => void
}

/** 当前打开的浮层，末尾是最上层 */
const stack: Entry[] = []
/** 已压进 history、还没退回去的记录数 */
let pushed = 0
/** 程序发起的 history.go(-n) 还没返回；它引起的 popstate 不是用户按了返回 */
let traversing = false
let listening = false
let scheduled = false

function reconcile(): void {
  scheduled = false
  if (traversing) return // 等在途的回退完成，popstate 里会再对账一次
  while (pushed < stack.length) {
    window.history.pushState({ lkOverlay: true }, "")
    pushed++
  }
  if (pushed > stack.length) {
    const extra = pushed - stack.length
    pushed = stack.length
    traversing = true
    window.history.go(-extra)
  }
}

function scheduleReconcile(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(reconcile)
}

function onPopState(): void {
  if (traversing) {
    traversing = false
    reconcile()
    return
  }
  // 用户按了返回：这条记录已经用掉，关最上面的浮层
  if (pushed > 0) pushed--
  stack.pop()?.close()
}

/** 当前打开着的浮层数（抽屉、弹窗、菜单、图片查看…）。手势据此判断有没有东西盖在上面，别去接管触摸 */
export function openOverlayCount(): number {
  return stack.length
}

/**
 * 直接关掉最上层的浮层，返回有没有关。APK 里的返回键走这里（见 native-back.ts）。
 * 关闭之后 useBackToClose 的清理会把多压的那条 history 记录退回去，和点关闭按钮完全一样。
 */
export function closeTopOverlay(): boolean {
  const top = stack.pop()
  if (!top) return false
  top.close()
  return true
}

/** 登记一个打开着的浮层，返回注销函数。useBackToClose 就是在 effect 里调它；拆出来是为了不靠渲染也能测 */
export function registerOverlay(close: () => void): () => void {
  if (!listening) {
    window.addEventListener("popstate", onPopState)
    listening = true
  }
  const entry: Entry = { close }
  stack.push(entry)
  scheduleReconcile()
  return () => {
    const at = stack.indexOf(entry)
    if (at >= 0) stack.splice(at, 1) // 已被返回键弹出的不在栈里
    scheduleReconcile()
  }
}

export function useBackToClose(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    return registerOverlay(() => closeRef.current())
  }, [open])
}
