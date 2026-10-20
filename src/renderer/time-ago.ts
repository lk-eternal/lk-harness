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

const pad = (n: number) => String(n).padStart(2, "0")
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** 消息时间：今天 14:03 / 昨天 14:03 / 10-18 14:03 / 跨年 2025-12-31 14:03 */
export function formatMessageTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const today = new Date(now)
  const daysAgo = Math.round((startOfDay(today) - startOfDay(d)) / DAY)
  if (daysAgo <= 0) return clock(d)
  if (daysAgo === 1) return `昨天 ${clock(d)}`
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === today.getFullYear() ? `${date} ${clock(d)}` : `${d.getFullYear()}-${date} ${clock(d)}`
}

/** 精确到秒的完整时间，给悬停提示用：2026-10-20 14:03:07 */
export function formatFullTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}:${pad(d.getSeconds())}`
}
