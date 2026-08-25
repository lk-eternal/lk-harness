import { useCallback, useRef, useState } from "react"

/** 保存成功后短暂显示「已保存」反馈 */
export function usePanelSave() {
  const [justSaved, setJustSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const markSaved = useCallback(() => {
    setJustSaved(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setJustSaved(false), 1800)
  }, [])

  return { justSaved, markSaved }
}
