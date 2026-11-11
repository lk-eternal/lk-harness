import { useEffect, useRef } from "react"

/**
 * 设置页「左边列表 + 右边详情」的面板，第一次读到列表时默认打开第一项，进来就有内容，不用先点一下。
 * 只做这一次：之后用户删掉了、取消了新建，右边回到空白提示，不会又被自动选回第一项；
 * 列表之后（比如 AI 排了新任务）长出新项，也不会把用户正在看的东西顶掉。
 *
 * wait：还没读完列表，等着。skip：读完了但不用打开（列表是空的，或用户已经选了别的）。open：打开第一项。
 */
export type OpenFirstStep = "wait" | "skip" | "open"

export function openFirstStep(s: { ready: boolean; count: number; occupied: boolean }): OpenFirstStep {
  if (!s.ready) return "wait"
  return s.count > 0 && !s.occupied ? "open" : "skip"
}

/**
 * ready：列表已经读回来了（读之前列表是空的，不能当成「没有项」）。
 * occupied：右边已经有东西（选中的项、或正在新建的草稿）。
 * 每次渲染都会走一遍，但只有第一次 ready 时起作用；StrictMode 下 effect 跑两遍，ref 保证只打开一次。
 */
export function useOpenFirstOnce<T>(ready: boolean, items: readonly T[], occupied: boolean, open: (first: T) => void): void {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    const step = openFirstStep({ ready, count: items.length, occupied })
    if (step === "wait") return
    done.current = true
    if (step === "open") open(items[0])
  })
}
