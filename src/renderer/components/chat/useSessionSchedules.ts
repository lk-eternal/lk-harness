import { useCallback, useEffect, useRef, useState } from "react"
import type { SessionScheduleItem } from "../../../shared/session-schedule"
import { sameChatSession } from "./useAppChatItems"

const POLL_MS = 5000

/**
 * 绑定到某个会话的定时任务（AI 给自己排的 + 设置页里投给它的），下次触发时间由主进程算好。
 * 可见时每 5 秒刷一次；独立任务开始 / 结束运行时主进程会推一次状态，借它立刻刷新。
 * 切会话时旧会话的结果一律不显示（请求在飞的时候切走，晚到的结果属于上一个会话）。
 */
export function useSessionSchedules(
  sessionKey: string | null,
  active: boolean,
): { items: SessionScheduleItem[]; reload: () => Promise<void> } {
  const [state, setState] = useState<{ key: string; items: SessionScheduleItem[] } | null>(null)
  const keyRef = useRef(sessionKey)
  keyRef.current = sessionKey
  const inflight = useRef(false)
  const dirty = useRef(false)

  const reload = useCallback(async () => {
    // 已经有一次在飞：只记一笔，飞完再按最新的会话键补一次，请求不叠
    if (inflight.current) { dirty.current = true; return }
    inflight.current = true
    try {
      do {
        dirty.current = false
        const key = keyRef.current
        if (!key) return
        let items: SessionScheduleItem[]
        try {
          items = await window.electronAPI.getSessionSchedules(key)
        } catch {
          return // 下一轮轮询再试
        }
        if (keyRef.current === key) setState({ key, items })
        else dirty.current = true
      } while (dirty.current)
    } finally {
      inflight.current = false
    }
  }, [])

  useEffect(() => {
    if (!active || !sessionKey) return
    void reload()
    const timer = window.setInterval(() => void reload(), POLL_MS)
    const unsub = window.electronAPI.onScheduledTaskStatus(() => void reload())
    return () => { window.clearInterval(timer); unsub() }
  }, [active, sessionKey, reload])

  const items = state && sameChatSession(state.key, sessionKey) ? state.items : []
  return { items, reload }
}
