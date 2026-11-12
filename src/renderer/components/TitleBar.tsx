import { useState, useEffect, type ReactNode } from "react"
import { Minus, Square, X, Copy } from "lucide-react"
import { titleBarLayout, type TitleBarLayout } from "../../shared/window-chrome"

interface Props {
  children?: ReactNode
  /** 标题栏正中，位置不受左右内容宽度影响 */
  center?: ReactNode
  /** 窗口按钮左侧的操作区 */
  actions?: ReactNode
}

interface ViewProps extends Props {
  layout: TitleBarLayout
  maximized: boolean
}

/** 标题栏的样子：布局和最大化状态都由外面传进来，所以不用 Electron 也能渲染 */
export function TitleBarView({ children, center, actions, layout, maximized }: ViewProps) {
  return (
    <div
      className="relative flex h-12 items-center border-b border-line-subtle"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        className="flex flex-1 items-center overflow-hidden px-6"
        // macOS：左上角是系统的红绿灯，内容往右让开
        style={layout.leftInset ? { paddingLeft: layout.leftInset } : undefined}
      >
        {children}
      </div>
      {center && (
        <div
          className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {center}
        </div>
      )}
      <div
        className={`flex shrink-0 items-center gap-1 ${layout.windowButtons ? "pr-3" : "pr-6"}`}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {actions}
        {/* Windows / Linux 的自绘按钮；macOS 用系统的红绿灯，不画 */}
        {layout.windowButtons && (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}

export default function TitleBar(props: Props) {
  const [maximized, setMaximized] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    window.electronAPI.windowIsMaximized().then(setMaximized)
    return window.electronAPI.onWindowMaximizedChange(setMaximized)
  }, [])

  // 全屏只有 macOS 用得上：全屏时红绿灯收起，左侧不用再给它让位
  useEffect(() => {
    window.electronAPI.windowIsFullScreen().then(setFullScreen)
    return window.electronAPI.onWindowFullScreenChange(setFullScreen)
  }, [])

  // 渲染期就要用到系统，但页面级的静态渲染测试里 window 上没有 electronAPI：取不到按 Windows 布局处理（和以前一致）
  const platform = window.electronAPI?.platform
  return <TitleBarView {...props} layout={titleBarLayout(platform, fullScreen)} maximized={maximized} />
}
