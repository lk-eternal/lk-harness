import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Loader2 } from "lucide-react"
import { PreviewContext, type PreviewApi } from "../renderer/components/preview/PreviewContext"
import { createPathResolver } from "../renderer/components/preview/path-resolver"
import { LoadBoundary } from "../renderer/components/preview/preview-ui"
import { checkMobilePreviewPaths } from "./api"
import { useBackToClose } from "./back-stack"
import type { PreviewTarget } from "./MobilePreviewPage"

// 预览页带着 Markdown / 代码高亮 / 各种查看器，体积不小：第一次点开预览时才加载，不进手机端的主包
const MobilePreviewPage = lazy(() => import("./MobilePreviewPage"))

/** 预览页的代码没加载下来（经浏览器访问网关时断了网等）：说明并给个出口，不能把整个应用搞白屏 */
function PageLoadFailed({ onClose }: { onClose: () => void }) {
  useBackToClose(true, onClose)
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-page px-8 text-center text-sm text-fg-muted">
      <p>预览页加载失败，请检查与电脑的连接；仍然不行就重新打开应用或刷新页面</p>
      <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-1.5 text-xs text-fg-2 active:bg-raised">关闭</button>
    </div>
  )
}

/**
 * 手机端的文件预览：给里面的消息提供 PreviewContext（文件卡的「预览」按钮、文字里可点的路径都经它打开），
 * 点开后在最上层显示全屏预览页。查看器和电脑端同一套，读内容的方式换成走网关的接口。
 * 手机上没有内置浏览器，网址仍然交给系统浏览器，所以 linkMode 固定是 external。
 */
export function MobilePreviewProvider({ baseUrl, token, sessionKey, children }: { baseUrl: string; token: string; sessionKey: string; children: ReactNode }) {
  const [target, setTarget] = useState<PreviewTarget | null>(null)
  const close = useCallback(() => setTarget(null), [])
  // 换了会话，上一个会话里打开的预览就不该还盖在上面
  useEffect(() => { setTarget(null) }, [sessionKey])

  const api = useMemo<PreviewApi>(() => ({
    available: true,
    linkMode: "external",
    openFile: (file) => setTarget({ path: file.path, name: file.name, line: file.line }),
    openUrl: () => undefined,
    resolvePath: createPathResolver((paths) => checkMobilePreviewPaths(baseUrl, token, sessionKey, paths)),
  }), [baseUrl, token, sessionKey])

  return (
    <PreviewContext.Provider value={api}>
      {children}
      {/* 挂到 body 上：消息列表外层有变换/模糊时，fixed 会相对它定位而不是整个屏幕 */}
      {target && createPortal(
        <LoadBoundary fallback={<PageLoadFailed onClose={close} />}>
          <Suspense fallback={<div className="fixed inset-0 z-40 flex items-center justify-center bg-page text-fg-muted"><Loader2 size={20} className="animate-spin" /></div>}>
            <MobilePreviewPage baseUrl={baseUrl} token={token} sessionKey={sessionKey} target={target} onClose={close} />
          </Suspense>
        </LoadBoundary>,
        document.body,
      )}
    </PreviewContext.Provider>
  )
}
