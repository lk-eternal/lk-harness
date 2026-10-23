import { useEffect, useRef, useState } from "react"

export default function UpdateDownloadBanner() {
  const [downloading, setDownloading] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  /** 下载中断后自动重试/续传时的提示；数据重新流动后清掉 */
  const [retryNote, setRetryNote] = useState<string | null>(null)
  const active = useRef(false)

  useEffect(() => {
    const offS = window.electronAPI.onUpdaterStatus((s) => {
      if (s.kind === "downloading") {
        active.current = true
        setDownloading(true)
        setPct(null)
        setRetryNote(null)
      }
      if (s.kind === "retrying") {
        active.current = true
        setDownloading(true)
        // 只取第一行（「连接中断，正在重试…」），具体的网络错误留给设置页看
        setRetryNote(s.message.split("\n")[0] ?? null)
      }
      if (s.kind === "downloaded" || s.kind === "available") {
        active.current = false
        setDownloading(false)
        setPct(null)
        setRetryNote(null)
      }
    })
    const offP = window.electronAPI.onUpdaterProgress((p) => {
      if (!active.current) return
      setPct(Math.round(p))
      setRetryNote(null)
    })
    const offE = window.electronAPI.onUpdaterError(() => {
      active.current = false
      setDownloading(false)
      setPct(null)
      setRetryNote(null)
    })
    return () => {
      offS()
      offP()
      offE()
    }
  }, [])

  if (!downloading) {
    return null
  }

  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[150] w-[min(22rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-line bg-surface/95 px-4 py-3 shadow-xl backdrop-blur-sm ring-1 ring-white/[0.06]"
      role="status"
      aria-live="polite"
    >
      <p className="text-center text-xs font-medium text-fg-soft">
        {pct === null ? "正在下载更新…" : `正在下载更新 ${pct}%`}
      </p>
      {retryNote && <p className="mt-1 text-center text-[11px] text-amber-500">{retryNote}</p>}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
          style={{ width: pct === null ? "0%" : `${pct}%` }}
        />
      </div>
    </div>
  )
}
