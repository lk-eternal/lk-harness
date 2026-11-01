/**
 * 底部弹层（模型、目录、配对）的下拉关闭手势：判定规则放在这里，不依赖 DOM，可以直接测。
 * 手势本身（指针事件、跟手位移、收尾动画）在 useSheetDrag.tsx。
 */

/** 慢慢往下拖，至少拖这么远才算关（弹层更高时取高度的 1/4，取大的） */
export const SHEET_MIN_DISMISS_PX = 80
/** 往下一甩的速度（px/ms）。够快时拖得不远也算关 */
export const SHEET_FLING_VELOCITY = 0.5
/** 一甩要成立，至少也得动这么远，免得手指抖一下就关 */
export const SHEET_FLING_MIN_PX = 24
/** 估算速度只看最近这段时间的采样（ms） */
export const SHEET_VELOCITY_WINDOW_MS = 120

export interface DragSample {
  y: number
  /** 毫秒时间戳 */
  t: number
}

/** 弹层跟手的位移：只能往下拉，往上拉不动 */
export function sheetOffset(dy: number): number {
  return dy > 0 ? dy : 0
}

/** 向下的速度（px/ms，向上为负）。取最近一小段时间内的首尾采样，松手前先往回拉就不算甩 */
export function dragVelocity(samples: DragSample[], windowMs = SHEET_VELOCITY_WINDOW_MS): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]!
  let first = last
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]!
    if (last.t - s.t > windowMs) break
    first = s
  }
  const dt = last.t - first.t
  if (dt <= 0) return 0
  return (last.y - first.y) / dt
}

/** 松手时是否关闭。dy 是相对按下位置的垂直位移，panelHeight 是弹层高度 */
export function shouldDismissSheet(dy: number, velocity: number, panelHeight: number): boolean {
  if (dy <= 0) return false
  if (velocity >= SHEET_FLING_VELOCITY && dy >= SHEET_FLING_MIN_PX) return true
  return dy >= Math.max(SHEET_MIN_DISMISS_PX, panelHeight * 0.25)
}
