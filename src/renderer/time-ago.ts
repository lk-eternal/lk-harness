const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 距今多久的简短中文描述：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function formatTimeAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return "刚刚"
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  return `${Math.floor(diff / DAY)} 天前`
}
