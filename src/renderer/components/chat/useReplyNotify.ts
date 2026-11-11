import { useEffect, useRef } from "react"

/**
 * 对话页和主进程「回复完成通知」的对接：
 * - 把用户正看着的会话告诉主进程（离开对话页、卸载时报 null），回复完成时主进程据此判断要不要弹；
 * - 点了通知，主进程把窗口唤到前台后推来要打开的会话，交给 onOpen 去切换。
 */
export function useReplyNotify(viewing: string | null, onOpen: (sessionKey: string) => void): void {
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    window.electronAPI.appChatViewing(viewing)
  }, [viewing])

  useEffect(() => () => window.electronAPI.appChatViewing(null), [])

  useEffect(() => window.electronAPI.onAppChatOpenSession((sessionKey) => onOpenRef.current(sessionKey)), [])
}
