import { useEffect, useState, type ReactNode } from "react"

/** 折起的动画时长，要和下面的 duration-200 一致；折完才把内容从界面上摘掉，摘的时机要比动画略晚 */
const COLLAPSE_MS = 200
const UNMOUNT_DELAY_MS = COLLAPSE_MS + 50

/**
 * 内容跟着 open 滑开 / 滑合。折着的时候不画内容（折起来的行不占界面）：
 * 展开时先画出来再滑开，折起时先滑合、滑完再摘掉，所以折起的那一刻 children 还要继续给。
 * 系统设了「减少动态效果」就不做动画，内容照样稍后摘掉。
 */
export default function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)

  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => setMounted(false), UNMOUNT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [open])

  return (
    <div className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
      <div className="min-h-0 overflow-hidden">{mounted && children}</div>
    </div>
  )
}
