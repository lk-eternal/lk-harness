import { createContext, useContext, useEffect, useState } from "react"
import type { PreviewBytesResult, PreviewTextResult, PreviewZipResult } from "../../../shared/preview-types"

/**
 * 查看器读文件内容的方式。电脑端经主进程 IPC 读；手机端走网关的 HTTP 接口。
 * 查看器只认这个接口，所以同一套查看器两边通用。令牌是打开文件时拿到的（电脑端是预览令牌，手机端是票据）。
 */
export interface PreviewHost {
  fileText(token: string): Promise<PreviewTextResult>
  fileBytes(token: string): Promise<PreviewBytesResult>
  fileZip(token: string): Promise<PreviewZipResult>
}

/** 电脑端的实现；方法里才取 electronAPI，手机端打包引入这个文件时不会在加载时出错 */
export const desktopPreviewHost: PreviewHost = {
  fileText: (token) => window.electronAPI.previewFileText(token),
  fileBytes: (token) => window.electronAPI.previewFileBytes(token),
  fileZip: (token) => window.electronAPI.previewFileZip(token),
}

const PreviewHostContext = createContext<PreviewHost>(desktopPreviewHost)

export const PreviewHostProvider = PreviewHostContext.Provider

export function usePreviewHost(): PreviewHost {
  return useContext(PreviewHostContext)
}

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; value: T }

/** 异步加载一份数据：deps 变化就重新加载，旧的结果作废。load 返回 `ok: false` 或者抛错，都变成 error 状态 */
export function useLoaded<T>(load: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    setState({ status: "loading" })
    load().then((r) => {
      if (!cancelled) setState(r.ok ? { status: "ready", value: r.value } : { status: "error", error: r.error })
    }).catch((e: unknown) => {
      if (!cancelled) setState({ status: "error", error: e instanceof Error ? e.message : String(e) })
    })
    return () => { cancelled = true }
  }, deps)
  return state
}
