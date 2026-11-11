import { useCallback, useEffect, useState } from "react"
import type { SessionStatus } from "./useSessionActivity"

const KEY = "lk.chat.sidebarCollapsed"

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** 上次是不是收起的；没存过、读不了都当作展开 */
export function loadSidebarCollapsed(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function saveSidebarCollapsed(collapsed: boolean, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(KEY, collapsed ? "1" : "0")
  } catch { /* 存不了就只在本次运行里生效 */ }
}

/** 对话页左侧会话栏的收起状态，会记住：下次打开还是上次的样子 */
export function useSidebarCollapsed(): [collapsed: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState(() => loadSidebarCollapsed())
  useEffect(() => { saveSidebarCollapsed(collapsed) }, [collapsed])
  const toggle = useCallback(() => setCollapsed((c) => !c), [])
  return [collapsed, toggle]
}

/**
 * 你没在看的会话里，有几个有新回复（会话栏里的绿点）。
 * 会话栏收起后看不到那些绿点，开关按钮上用它补一个提示。
 */
export function countUnreadElsewhere(
  tabs: readonly { sessionKey: string; running: boolean }[],
  isViewing: (sessionKey: string) => boolean,
  statusOf: (sessionKey: string, running: boolean) => SessionStatus,
): number {
  let n = 0
  for (const t of tabs) {
    if (!isViewing(t.sessionKey) && statusOf(t.sessionKey, t.running) === "unread") n++
  }
  return n
}

/** 没选中会话时对话区中间的提示；会话栏收起着就别再指着左边（那里已经没有东西了） */
export function emptySessionHint(loaded: boolean, collapsed: boolean): string {
  if (!loaded) return "加载中…"
  return collapsed ? "展开会话栏选择会话，或新建一个" : "← 选择会话，或新建一个"
}

export function sidebarToggleTitle(collapsed: boolean, unread: number): string {
  if (!collapsed) return "收起会话栏"
  return unread > 0 ? `展开会话栏（${unread} 个会话有新回复）` : "展开会话栏"
}
