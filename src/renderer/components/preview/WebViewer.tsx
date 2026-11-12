import { useEffect, useRef, useState } from "react"
import { Globe, RotateCw } from "lucide-react"
import { useOverlayOpen } from "../overlay-presence"
import { CenterMessage } from "./preview-ui"
import type { WebTab } from "./preview-tabs"

/** 先截图再藏视图时，等截图的最长时间：超过就不等了，直接藏 */
const SNAPSHOT_TIMEOUT_MS = 300

/**
 * 网页标签页的内容区。真正的网页是主进程里一个盖在这块区域上方的原生视图，这里只负责：
 * - 量出这块区域的位置告诉主进程（窗口缩放、拖动分隔条后跟着走）
 * - 有界面弹层、正在拖动分隔条、页面不可见时，让原生视图让位；让位前先截一张图顶在原处，页面不会一下子空掉
 * - 空白页、加载失败时显示界面自己的提示
 */
export default function WebViewer({ tab, visible, dragging }: { tab: WebTab; visible: boolean; dragging: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayOpen = useOverlayOpen()
  const [snapshot, setSnapshot] = useState<string | null>(null)
  /** 要让位且截图已经拿到（或放弃等了）：这时才真的把原生视图藏起来 */
  const [yielded, setYielded] = useState(false)

  // 被换出去的标签页主进程里没有视图，换回来（重新加载）之前没有页面可摆；换回来后 showNative 翻成 true，位置会重新告诉主进程
  const hasPage = !!tab.url && !tab.error && !tab.discarded
  const needYield = visible && hasPage && (overlayOpen || dragging)

  useEffect(() => {
    if (!needYield) {
      setSnapshot(null)
      setYielded(false)
      return
    }
    let cancelled = false
    const finish = (dataUrl: string | null) => {
      if (cancelled) return
      setSnapshot(dataUrl)
      setYielded(true)
    }
    const timer = window.setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS)
    void window.electronAPI.previewWebSnapshot(tab.id).then((r) => {
      window.clearTimeout(timer)
      finish(r.ok ? r.dataUrl : null)
    }).catch(() => finish(null))
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [needYield, tab.id])

  const showNative = visible && hasPage && !(needYield && yielded)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !showNative) {
      window.electronAPI.previewWebBounds(null, null)
      return
    }
    const send = () => {
      const r = host.getBoundingClientRect()
      window.electronAPI.previewWebBounds(tab.id, { x: r.x, y: r.y, width: r.width, height: r.height })
    }
    send()
    // 区域自己的大小变化 + 整个页面的大小变化（窗口缩放时区域位置变了但大小不一定变）
    const observer = new ResizeObserver(send)
    observer.observe(host)
    observer.observe(document.documentElement)
    window.addEventListener("resize", send)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", send)
    }
  }, [showNative, tab.id])

  // 卸载（切走标签页、面板收起）时把原生视图藏掉
  useEffect(() => () => window.electronAPI.previewWebBounds(null, null), [])

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-page">
      {!tab.url && (
        <CenterMessage>
          <Globe size={28} className="text-fg-faint" />
          <p>在上方地址栏输入网址，回车打开</p>
        </CenterMessage>
      )}
      {tab.error && (
        <CenterMessage>
          <p className="text-fg-2">无法打开这个页面</p>
          <p className="break-all text-xs text-fg-faint">{tab.url}</p>
          <p className="text-xs text-danger">{tab.error}</p>
          <button
            type="button"
            onClick={() => void window.electronAPI.previewWebNav(tab.id, "reload")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:border-blue-500 hover:text-accent-soft"
          ><RotateCw size={12} />重试</button>
        </CenterMessage>
      )}
      {snapshot && showNative === false && <img src={snapshot} alt="" className="pointer-events-none absolute inset-0 h-full w-full select-none" />}
    </div>
  )
}
