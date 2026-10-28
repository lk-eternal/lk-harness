import { useEffect, useRef, useState } from "react"
import type { ManagerListResult } from "../../shared/managed-sessions"
import { createLatestRunner } from "./latest-runner"

async function loadList(): Promise<ManagerListResult> {
  try {
    return await window.electronAPI.listManagedSessions()
  } catch (e) {
    return { ok: false, daemonRunning: false, sessions: [], skipped: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 会话管理页的会话清单：进入时拉一次，打开期间定时刷新（别人的会话随时在跑）。
 * 刷新走 createLatestRunner：操作后 `await refresh()` 返回时，界面上一定是操作之后的清单。
 * 某一轮失败（临时出错）时保留上次的清单，只挂上错误，别把列表清空。
 */
export function useManagedSessions(enabled: boolean, intervalMs = 8000): {
  result: ManagerListResult | null
  refresh: () => Promise<void>
} {
  const [result, setResult] = useState<ManagerListResult | null>(null)
  const alive = useRef(true)
  const runner = useRef<(() => Promise<void>) | null>(null)
  if (!runner.current) {
    runner.current = createLatestRunner(
      loadList,
      (next) => setResult((prev) => (next.ok || !prev ? next : { ...prev, error: next.error ?? "刷新失败" })),
      () => alive.current,
    )
  }
  const refresh = runner.current

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const t = setInterval(() => { void refresh() }, intervalMs)
    return () => clearInterval(t)
  }, [enabled, refresh, intervalMs])

  return { result, refresh }
}
