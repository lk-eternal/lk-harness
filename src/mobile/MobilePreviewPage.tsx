import { useMemo, type ReactNode } from "react"
import { ArrowLeft, Download, Loader2 } from "lucide-react"
import { baseName } from "../shared/preview-kinds"
import { formatBytes } from "../shared/preview-text"
import type { PreviewFileInfo } from "../shared/preview-types"
import FileBody from "../renderer/components/preview/FileBody"
import { PreviewHostProvider, useLoaded } from "../renderer/components/preview/preview-host"
import { CenterMessage, FileNotice, Loading, NOTICE_BUTTON, NOTICE_BUTTON_PRIMARY } from "../renderer/components/preview/preview-ui"
import { createMobilePreviewHost, openMobilePreview, requestMobileFileDownloadUrl, requestMobilePreviewDownloadUrl } from "./api"
import { useBackToClose } from "./back-stack"
import { useFileDownload } from "./use-file-download"

export interface PreviewTarget {
  path: string
  name?: string
  line?: number
}

/**
 * 全屏预览页：先向电脑端打开文件（校验权限、发令牌），再用和电脑端同一套查看器显示。
 * 这个文件体积不小（带着 Markdown / 代码高亮 / 各种查看器），由 MobilePreview.tsx 按需懒加载，不进手机端的主包。
 */
export default function MobilePreviewPage({ baseUrl, token, sessionKey, target, onClose }: {
  baseUrl: string
  token: string
  sessionKey: string
  target: PreviewTarget
  onClose: () => void
}) {
  useBackToClose(true, onClose)
  const host = useMemo(() => createMobilePreviewHost(baseUrl, token), [baseUrl, token])
  const download = useFileDownload()
  const state = useLoaded<PreviewFileInfo>(async () => {
    const r = await openMobilePreview(baseUrl, token, sessionKey, target.path)
    return r.ok ? { ok: true, value: r } : r
  }, [baseUrl, token, sessionKey, target.path])

  const info = state.status === "ready" ? state.value : undefined
  const name = info?.name ?? target.name ?? baseName(target.path)
  // 打开成功后凭预览令牌下载（工作目录里的文件不一定在会话记录里出现过）；没打开成功时按路径试（旧版电脑端只认这种）
  const getDownloadUrl = () => (info
    ? requestMobilePreviewDownloadUrl(baseUrl, token, info.token)
    : requestMobileFileDownloadUrl(baseUrl, token, target.path, sessionKey))

  const downloadAction = (primary: boolean) => (
    <button
      type="button"
      disabled={download.downloading}
      onClick={() => void download.start(getDownloadUrl, name)}
      className={`${primary ? NOTICE_BUTTON_PRIMARY : NOTICE_BUTTON} disabled:opacity-60`}
    >
      {download.downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}下载到手机
    </button>
  )

  let body: ReactNode
  if (state.status === "loading") {
    body = <Loading />
  } else if (state.status === "error") {
    body = <CenterMessage>{state.error}{downloadAction(false)}</CenterMessage>
  } else if (state.value.kind === "pdf") {
    // Android 的 WebView 不能内嵌 PDF；给出路：下载后用手机上的 PDF 应用打开
    body = <FileNotice file={state.value} reason="手机上没法直接显示 PDF，下载后可以用其他应用打开">{downloadAction(true)}</FileNotice>
  } else {
    const kind = state.value.kind
    body = (
      <PreviewHostProvider value={host}>
        <FileBody key={state.value.token} info={state.value} kind={kind} line={target.line} actions={downloadAction(kind === "unsupported")} />
      </PreviewHostProvider>
    )
  }

  return (
    <PreviewFrame
      title={name}
      subtitle={info ? formatBytes(info.size) : undefined}
      onClose={onClose}
      right={(
        <button
          type="button"
          aria-label="下载"
          disabled={download.downloading}
          onClick={() => void download.start(getDownloadUrl, name)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-fg-2 transition active:bg-raised disabled:opacity-60"
        >{download.downloading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}</button>
      )}
      notice={download.error || undefined}
    >{body}</PreviewFrame>
  )
}

/** 预览页的外框：顶栏（返回、文件名）+ 内容区 */
function PreviewFrame({ title, subtitle, right, notice, onClose, children }: {
  title: string
  subtitle?: string
  right?: ReactNode
  notice?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-page text-fg">
      <header className="flex shrink-0 items-center gap-2 border-b border-line-subtle bg-surface/90 px-3 pb-2.5 pt-safe backdrop-blur">
        <button
          type="button"
          onClick={onClose}
          aria-label="返回"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-fg-2 transition active:bg-raised"
        ><ArrowLeft size={19} /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg-soft" title={title}>{title}</p>
          {subtitle && <p className="truncate text-[11px] text-fg-faint">{subtitle}</p>}
        </div>
        {right}
      </header>
      {notice && <p className="shrink-0 border-b border-line-subtle bg-surface/60 px-3 py-1.5 text-[11px] text-amber-400">{notice}</p>}
      {/* 手机端页面整体禁止选中（select-none），预览的文字、代码要能选中复制 */}
      <div className="min-h-0 flex-1 select-text overflow-hidden" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>{children}</div>
    </div>
  )
}
