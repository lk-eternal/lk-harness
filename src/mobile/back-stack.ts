import { useEffect, useRef } from "react"

/**
 * 返回键 / 返回手势关浮层，不依赖 Capacitor 插件：
 * 安卓 WebView 默认「有历史就后退，没有才退出应用」，浏览器的返回手势同理。
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

export function useBackToClose(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    if (!listening) {
      window.addEventListener("popstate", onPopState)
      listening = true
    }
    const entry: Entry = { close: () => closeRef.current() }
    stack.push(entry)
    scheduleReconcile()
    return () => {
      const at = stack.indexOf(entry)
      if (at >= 0) stack.splice(at, 1) // 已被返回键弹出的不在栈里
      scheduleReconcile()
    }
  }, [open])
}
