import { Suspense, lazy, type ReactNode } from "react"
import { unsupportedReason, type PreviewKind } from "../../../shared/preview-kinds"
import type { PreviewFileInfo } from "../../../shared/preview-types"
import ArchiveView from "./ArchiveView"
import { ImageView, MediaView, PdfView } from "./MediaViewers"
import { CodeView, CsvView, HtmlView, MarkdownView } from "./TextViewers"
import { FileNotice, LoadBoundary, Loading } from "./preview-ui"

// Word / Excel 的解析库体积大，只在真的打开这类文件时才加载
const DocxView = lazy(() => import("./DocxView"))
const XlsxView = lazy(() => import("./XlsxView"))

/** 加载中显示转圈；加载失败显示说明和这个环境里能做的操作，不白屏 */
function LazyViewer({ info, actions, children }: { info: PreviewFileInfo; actions?: ReactNode; children: ReactNode }) {
  return (
    <LoadBoundary fallback={<FileNotice file={info} reason="查看器加载失败，请检查网络后重新打开这个文件">{actions}</FileNotice>}>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </LoadBoundary>
  )
}

/**
 * 按文件类型选查看器。电脑端的预览面板和手机端的预览页共用这里。
 * actions 是「这个环境里能对文件做什么」（用默认程序打开、下载…），显示在说明页和读取失败页里。
 * line 是要定位的行号，只有文本和代码用得上。
 */
export default function FileBody({ info, kind, actions, line }: { info: PreviewFileInfo; kind: PreviewKind; actions?: ReactNode; line?: number }) {
  switch (kind) {
    case "text":
    case "code":
      return <CodeView info={{ ...info, kind }} line={line} />
    case "markdown": return <MarkdownView info={info} />
    case "html": return <HtmlView info={info} />
    case "csv": return <CsvView info={info} />
    case "image": return <ImageView info={info} />
    case "pdf": return <PdfView info={info} />
    case "audio": return <MediaView info={info} video={false} />
    case "video": return <MediaView info={info} video />
    case "archive": return <ArchiveView info={info} actions={actions} />
    case "docx": return <LazyViewer info={info} actions={actions}><DocxView info={info} actions={actions} /></LazyViewer>
    case "xlsx": return <LazyViewer info={info} actions={actions}><XlsxView info={info} actions={actions} /></LazyViewer>
    case "unsupported": return <FileNotice file={info} reason={unsupportedReason(info.name)}>{actions}</FileNotice>
  }
}
