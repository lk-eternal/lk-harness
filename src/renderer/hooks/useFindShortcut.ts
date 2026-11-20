import { useEffect, useRef } from "react"

/**
 * Ctrl+F（Mac 是 ⌘F）：enabled 时调用 onFind。
 * 已经被别处处理过的不再响应：鼠标在预览面板上时，Ctrl+F 归它自己的查找条（见 FindScope）。
 */
export function useFindShortcut(enabled: boolean, onFind: () => void): void {
  const onFindRef = useRef(onFind)
  useEffect(() => { onFindRef.current = onFind })

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      // 输入法开着时 key 可能是 "Process"，这时看物理键位
      const isF = e.key.toLowerCase() === "f" || ((e.key === "Process" || e.key === "Unidentified") && e.code === "KeyF")
      if (!isF) return
      e.preventDefault()
      onFindRef.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled])
}
