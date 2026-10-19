import { useEffect, useRef, useState } from "react"

export default function UpdateDownloadBanner() {
  const [downloading, setDownloading] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const active = useRef(false)

  useEffect(() => {
    const offS = window.electronAPI.onUpdaterStatus((s) => {
      if (s.kind === "downloading") {
        active.current = true
        setDownloading(true)
        setPct(null)
      }
      if (s.kind === "downloaded" || s.kind === "available") {
        active.current = false
        setDownloading(false)
        setPct(null)
      }
    })
    const offP = window.electronAPI.onUpdaterProgress((p) => {
      if (!active.current) return
      setPct(Math.round(p))
    })
    const offE = window.electronAPI.onUpdaterError(() => {
      active.current = false
      setDownloading(false)
      setPct(null)
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
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
          style={{ width: pct === null ? "0%" : `${pct}%` }}
        />
      </div>
    </div>
  )
}
