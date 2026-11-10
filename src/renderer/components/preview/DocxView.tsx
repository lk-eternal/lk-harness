import type { ReactNode } from "react"
// mammoth 体积大（带着自己的 zip 和 XML 解析）：这个文件由 FileBody 按需懒加载，不进主包
import mammoth from "mammoth/mammoth.browser"
import { formatBytes } from "../../../shared/preview-text"
import { DocxFormatError, convertDocxToPreview, type DocxConvert } from "../../../shared/preview-docx"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import { CenterMessage, FileNotice, Loading, ViewerBar } from "./preview-ui"
import { useLoaded, usePreviewHost } from "./preview-host"

const convertWithMammoth: DocxConvert = (bytes) => {
  // 不用 bytes.buffer：它可能比这份数据大（是别的数据的一段视图）
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return mammoth.convertToHtml({ arrayBuffer })
}

/** Word 文档：还原文字、标题、列表、表格、图片；版式、页眉页脚不还原。放进沙箱 iframe，里面的脚本和链接都不起作用 */
export default function DocxView({ info, actions }: { info: PreviewFileInfo; actions?: ReactNode }) {
  const host = usePreviewHost()
  const state = useLoaded(async () => {
    const r = await host.fileBytes(info.token)
    if (!r.ok) return r
    try {
      return { ok: true as const, value: await convertDocxToPreview(r.bytes, convertWithMammoth) }
    } catch (e) {
      return { ok: false as const, error: e instanceof DocxFormatError ? e.message : `无法解析这个文档：${e instanceof Error ? e.message : String(e)}` }
    }
  }, [info.token])

  if (state.status === "loading") return <Loading />
  if (state.status === "error") return <FileNotice file={info} reason={state.error}>{actions}</FileNotice>
  const { srcdoc, empty } = state.value
  if (empty) return <CenterMessage>这个文档里没有可以显示的内容</CenterMessage>

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span title="排版（页边距、分栏、页眉页脚、文本框）不会还原，以 Word 里的样子为准">只读 · 显示文字、表格和图片</span>
        <span className="ml-auto">{formatBytes(info.size)}</span>
      </ViewerBar>
      <iframe title={info.name} srcDoc={srcdoc} sandbox="" className="min-h-0 flex-1 border-0 bg-white" />
    </div>
  )
}
