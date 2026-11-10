import { useState } from "react"
import { Music } from "lucide-react"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import { formatBytes } from "../../../shared/preview-text"
import { ImageLightbox } from "../chat/ImageLightbox"
import { CenterMessage, ViewerBar } from "./preview-ui"

export function ImageView({ info }: { info: PreviewFileInfo }) {
  const [zoom, setZoom] = useState(false)
  const [failed, setFailed] = useState(false)
  if (failed) return <CenterMessage>这张图片无法显示（格式不支持或文件已损坏）</CenterMessage>
  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span>点击图片放大查看</span>
        <span className="ml-auto">{formatBytes(info.size)}</span>
      </ViewerBar>
      <div className="preview-checker flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={info.url}
          alt={info.name}
          onClick={() => setZoom(true)}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full cursor-zoom-in rounded object-contain shadow-lg"
        />
      </div>
      {zoom && <ImageLightbox src={info.url} onClose={() => setZoom(false)} />}
    </div>
  )
}

/** PDF 用 Chromium 自带的查看器：翻页、缩放、搜索、打印都有 */
export function PdfView({ info }: { info: PreviewFileInfo }) {
  return <iframe title={info.name} src={`${info.url}#navpanes=0`} className="h-full w-full border-0 bg-white" />
}

export function MediaView({ info, video }: { info: PreviewFileInfo; video: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <CenterMessage>应用内无法播放这个文件（编码或封装格式不受支持）<span className="text-xs text-fg-faint">可以在所在位置用其他播放器打开</span></CenterMessage>
  }
  if (video) {
    return (
      <div className="flex h-full items-center justify-center bg-black">
        <video src={info.url} controls preload="metadata" onError={() => setFailed(true)} className="max-h-full max-w-full" />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-raised text-accent"><Music size={36} /></div>
      <div className="text-center">
        <p className="break-all text-sm font-medium text-fg-soft">{info.name}</p>
        <p className="mt-1 text-xs text-fg-faint">{formatBytes(info.size)}</p>
      </div>
      <audio src={info.url} controls preload="metadata" onError={() => setFailed(true)} className="w-full max-w-md" />
    </div>
  )
}
