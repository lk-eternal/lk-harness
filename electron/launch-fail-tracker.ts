const PERMANENT_LAUNCH_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000]
const LAUNCH_FAIL_NOTIFY_INTERVAL_MS = 60_000

interface LaunchFailState {
  count: number
  lastFailAt: number
  permanent: boolean
  lastNotifyAt: number
}

const launchFailStreak = new Map<string, LaunchFailState>()

/** 瞬时故障立即重试；配置/权限类错误阶梯退避 */
export function isTransientLaunchError(error: string): boolean {
  return /resume\s*暂不可用|暂不可用|network|timeout|fetch failed|econnreset|会话已重置/i.test(error)
}

export function recordLaunchFailure(sessionKey: string, error: string): void {
  const permanent = !isTransientLaunchError(error)
  const st = launchFailStreak.get(sessionKey) ?? { count: 0, lastFailAt: 0, permanent: false, lastNotifyAt: 0 }
  st.count += 1
  st.lastFailAt = Date.now()
  st.permanent = permanent
  launchFailStreak.set(sessionKey, st)
}

export function launchFailCooldownRemaining(sessionKey: string): number {
  const st = launchFailStreak.get(sessionKey)
  if (!st?.permanent) return 0
  const idx = Math.min(st.count - 1, PERMANENT_LAUNCH_BACKOFF_MS.length - 1)
  const wait = PERMANENT_LAUNCH_BACKOFF_MS[Math.max(idx, 0)]
  return Math.max(0, st.lastFailAt + wait - Date.now())
}

export function shouldNotifyLaunchFailure(sessionKey: string): boolean {
  const st = launchFailStreak.get(sessionKey)
  if (!st) return true
  const now = Date.now()
  if (st.lastNotifyAt > 0 && now - st.lastNotifyAt < LAUNCH_FAIL_NOTIFY_INTERVAL_MS) return false
  st.lastNotifyAt = now
  return true
}

export function clearLaunchFailStreak(sessionKey: string): void {
  launchFailStreak.delete(sessionKey)
}
