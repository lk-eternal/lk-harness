import { useState, useEffect, type ReactNode } from "react"
import { Minus, Square, X, Copy } from "lucide-react"

interface Props {
  children?: ReactNode
}

export default function TitleBar({ children }: Props) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.electronAPI.windowIsMaximized().then(setMaximized)
    return window.electronAPI.onWindowMaximizedChange(setMaximized)
  }, [])

  return (
    <div
      className="flex h-12 items-center border-b border-line-subtle"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex flex-1 items-center overflow-hidden px-6">
        {children}
      </div>
      <div
        className="flex shrink-0 items-center gap-1 pr-3"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={() => window.electronAPI.windowMinimize()}
          className="rounded-lg p-2 text-fg-3 transition hover:bg-raised hover:text-fg"
        >
          <Minus size={16} />
        </button>
        <button
          onClick={() => window.electronAPI.windowMaximize()}
          className="rounded-lg p-2 text-fg-3 transition hover:bg-raised hover:text-fg"
        >
          {maximized ? <Copy size={14} className="rotate-180" /> : <Square size={14} />}
        </button>
        <button
          onClick={() => window.electronAPI.windowClose()}
          className="rounded-lg p-2 text-fg-3 transition hover:bg-red-600 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
